import { b64Decode, b64Encode, generateMsgId } from './utils.js';
import { ChannelConnection, ChannelReconnected } from './channel.js';
import { SessionCipher } from './crypto.js';

const STREAM_END = Symbol('stream_end');

type StreamItem = Record<string, unknown> | typeof STREAM_END | Error;

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.failure) throw this.failure;
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (this.failure) throw this.failure;
      if (next.done) return;
      yield next.value as T;
    }
  }
}

export class TransportError extends Error {
  readonly code: string;
  readonly remoteMessage: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'TransportError';
    this.code = code;
    this.remoteMessage = message;
  }
}

export class TransportLayer {
  private pending = new Map<string, PendingRequest>();
  private streams = new Map<string, AsyncQueue<StreamItem>>();
  private handlers = new Map<string, Array<(event: string, data: Record<string, unknown>) => unknown>>();
  private recvTask: Promise<void> | null = null;
  private doneResolver: (() => void) | null = null;
  private donePromise: Promise<void>;

  constructor(
    private readonly channel: ChannelConnection,
    private readonly cipher: SessionCipher,
    private readonly myId: string,
    private readonly peerId: string,
  ) {
    this.donePromise = new Promise((resolve) => {
      this.doneResolver = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.recvTask) return;
    this.recvTask = this._recvLoop();
  }

  async stop(): Promise<void> {
    if (!this.recvTask) return;
    try {
      await this.recvTask;
    } catch {
      // ignore
    }
    this.recvTask = null;

    const err = new TransportError('transport_closed', 'Transport stopped');
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();

    for (const queue of this.streams.values()) {
      queue.push(err);
      queue.close();
    }
    this.streams.clear();
  }

  async waitDone(): Promise<void> {
    return await this.donePromise;
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 120000): Promise<Record<string, unknown>> {
    const id = generateMsgId();
    const message = { id, type: 'request', method, params };

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransportError('timeout', `Request ${id} (${method}) timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
    // Attach a noop handler early to avoid unhandled rejection warnings before await attaches.
    promise.catch(() => {});

    try {
      await this._sendEncrypted(message);
    } catch (err) {
      const pending = this.pending.get(id);
      if (pending?.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      throw err;
    }
    return await promise;
  }

  async *requestStream(method: string, params: Record<string, unknown>): AsyncIterable<Record<string, unknown>> {
    const id = generateMsgId();
    const message = { id, type: 'request', method, params };

    const queue = new AsyncQueue<StreamItem>();
    this.streams.set(id, queue);

    try {
      await this._sendEncrypted(message);

      for await (const item of queue.iterate()) {
        if (item === STREAM_END) return;
        if (item instanceof Error) throw item;
        yield item as Record<string, unknown>;
      }
    } finally {
      this.streams.delete(id);
    }
  }

  async cancel(requestId: string): Promise<void> {
    await this._sendEncrypted({ id: requestId, type: 'cancel' });
  }

  async notify(event: string, data: Record<string, unknown>): Promise<void> {
    await this._sendEncrypted({ id: generateMsgId(), type: 'notify', event, data });
  }

  on(event: string, handler: (event: string, data: Record<string, unknown>) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  private async _recvLoop(): Promise<void> {
    try {
      while (true) {
        const frame = await this.channel.recv();
        const frameType = String(frame.type || '');

        if (frameType === 'error') {
          const code = String(frame.code || 'relay_error');
          const message = String(frame.message || 'Unknown relay error');
          this._failAllPending(code, message);
          continue;
        }

        if (frameType !== 'data') {
          continue;
        }

        const payload = frame.payload;
        if (typeof payload !== 'string') {
          continue;
        }

        try {
          const payloadBytes = b64Decode(payload);
          const plaintext = await this.cipher.decrypt(payloadBytes);
          const msg = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
          await this._dispatch(msg);
        } catch {
          // Decryption/parse failures are dropped silently.
          continue;
        }
      }
    } catch (err) {
      if (err instanceof ChannelReconnected) {
        this._failAllPending('reconnected', 'Connection lost, session will be re-established');
      }
    } finally {
      this.doneResolver?.();
    }
  }

  private _failAllPending(code: string, message: string): void {
    const err = new TransportError(code, message);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();

    for (const queue of this.streams.values()) {
      queue.push(err);
      queue.close();
    }
    this.streams.clear();
  }

  private async _dispatch(msg: Record<string, unknown>): Promise<void> {
    const msgType = String(msg.type || '');
    const msgId = String(msg.id || '');

    if (msgType === 'response') {
      const pending = this.pending.get(msgId);
      if (!pending) return;
      this.pending.delete(msgId);
      if (pending.timer) clearTimeout(pending.timer);

      if ('error' in msg && msg.error && typeof msg.error === 'object') {
        const err = msg.error as Record<string, unknown>;
        pending.reject(new TransportError(String(err.code || 'unknown'), String(err.message || '')));
      } else {
        pending.resolve((msg.result as Record<string, unknown>) ?? {});
      }
      return;
    }

    if (msgType === 'stream_start') {
      if (!this.streams.has(msgId)) {
        this.streams.set(msgId, new AsyncQueue<StreamItem>());
      }
      return;
    }

    if (msgType === 'stream_chunk') {
      const queue = this.streams.get(msgId);
      if (queue) {
        queue.push((msg.data as Record<string, unknown>) ?? {});
      }
      return;
    }

    if (msgType === 'stream_end') {
      const queue = this.streams.get(msgId);
      if (queue) {
        queue.push(STREAM_END);
        queue.close();
      }
      return;
    }

    if (msgType === 'notify') {
      const event = String(msg.event || '');
      const data = (msg.data as Record<string, unknown>) ?? {};
      const handlers = this.handlers.get(event) ?? [];
      for (const handler of handlers) {
        try {
          const result = handler(event, data);
          if (result instanceof Promise) {
            await result;
          }
        } catch {
          // ignore handler errors
        }
      }
      return;
    }
  }

  private async _sendEncrypted(msg: Record<string, unknown>): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(msg));
    const ciphertext = await this.cipher.encrypt(plaintext);
    const payload = b64Encode(ciphertext);
    await this.channel.sendData(this.peerId, payload);
  }
}
