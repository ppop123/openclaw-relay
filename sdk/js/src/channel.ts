import WebSocket from 'ws';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const JITTER_FACTOR = 0.25;

class ChannelDisconnected extends Error {
  constructor(message = 'channel disconnected') {
    super(message);
    this.name = 'ChannelDisconnected';
  }
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: (value: T) => void; reject: (err: Error) => void }> = [];
  private failure: Error | null = null;

  push(item: T): void {
    if (this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) waiter.reject(error);
    }
  }

  async shift(): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }
    return await new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

export class ChannelReconnected extends Error {
  constructor() {
    super('channel reconnected');
    this.name = 'ChannelReconnected';
  }
}

export class ChannelConnection {
  private ws: WebSocket | null = null;
  private relayUrl: string | null = null;
  private closed = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectPromise: Promise<void> | null = null;
  private role: 'gateway' | 'client' | null = null;
  private channelHash: string | null = null;
  private clientId: string | null = null;
  private incoming = new AsyncQueue<Record<string, unknown>>();

  async connect(relayUrl: string): Promise<void> {
    this.relayUrl = relayUrl;
    this.closed = false;
    await this._doConnect();
  }

  async register(channelHash: string): Promise<Record<string, unknown>> {
    this.role = 'gateway';
    this.channelHash = channelHash;
    await this._sendFrame({ type: 'register', channel: channelHash, version: 1 });
    return await this._recvFrameExpect('registered');
  }

  async join(channelHash: string, clientId: string): Promise<Record<string, unknown>> {
    this.role = 'client';
    this.channelHash = channelHash;
    this.clientId = clientId;
    await this._sendFrame({ type: 'join', channel: channelHash, version: 1, client_id: clientId });
    return await this._recvFrameExpect('joined');
  }

  async sendData(to: string, payload: string): Promise<void> {
    await this._sendFrame({ type: 'data', to, payload });
  }

  async recv(): Promise<Record<string, unknown>> {
    while (true) {
      let frame: Record<string, unknown>;
      try {
        frame = await this.incoming.shift();
      } catch (err) {
        if (err instanceof ChannelDisconnected) {
          if (this.closed) {
            throw new Error('Connection closed');
          }
          await this._reconnect();
          throw new ChannelReconnected();
        }
        throw err;
      }

      const frameType = String(frame.type || '');
      if (frameType === 'ping') {
        await this._sendFrame({ type: 'pong' });
        continue;
      }

      return frame;
    }
  }

  async sendPing(): Promise<void> {
    await this._sendFrame({ type: 'ping' });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.incoming.fail(new ChannelDisconnected('closed'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private async _sendFrame(frame: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(frame));
  }

  private async _recvFrameExpect(expected: string): Promise<Record<string, unknown>> {
    while (true) {
      const frame = await this.incoming.shift();
      const frameType = String(frame.type || '');
      if (frameType === expected) return frame;
      if (frameType === 'ping') {
        await this._sendFrame({ type: 'pong' });
        continue;
      }
      if (frameType === 'error') {
        const code = String(frame.code || 'error');
        const message = String(frame.message || frameType);
        throw new ChannelError(`[${code}] ${message}`);
      }
    }
  }

  private async _doConnect(): Promise<void> {
    if (!this.relayUrl) {
      throw new Error('Relay URL not set');
    }

    const ws = new WebSocket(this.relayUrl, { handshakeTimeout: 10000 });
    this.ws = ws;
    this.incoming = new AsyncQueue<Record<string, unknown>>();

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString();
        const frame = JSON.parse(raw) as Record<string, unknown>;
        this.incoming.push(frame);
      } catch {
        // Ignore malformed frames
      }
    });

    ws.on('close', () => {
      if (!this.closed) {
        this.incoming.fail(new ChannelDisconnected('closed'));
      }
    });

    ws.on('error', () => {
      if (!this.closed) {
        this.incoming.fail(new ChannelDisconnected('error'));
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
    ws.once('error', (err: Error) => reject(err));
    });

    this.backoffMs = INITIAL_BACKOFF_MS;
  }

  private async _reconnect(): Promise<void> {
    if (this.reconnectPromise) {
      return await this.reconnectPromise;
    }

    this.reconnectPromise = (async () => {
      while (!this.closed) {
        const jitter = Math.random() * JITTER_FACTOR * this.backoffMs;
        const delay = this.backoffMs + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));

        try {
          await this._doConnect();
        } catch {
          this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
          continue;
        }

        try {
          if (this.role === 'gateway' && this.channelHash) {
            await this.register(this.channelHash);
          } else if (this.role === 'client' && this.channelHash && this.clientId) {
            await this.join(this.channelHash, this.clientId);
          }
        } catch {
          this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
          continue;
        }

        return;
      }

      throw new Error('Connection closed, cannot reconnect');
    })();

    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise = null;
    }
  }
}
