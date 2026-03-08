import { deriveClientSession, GatewayIdentity, SessionCipher } from './crypto.js';
import { Layer2ResponseError, RelayProtocolError } from './errors.js';
import {
  DataFrame,
  ErrorFrame,
  HelloAckMessage,
  HelloMessage,
  JoinFrame,
  JoinedFrame,
  Layer2Message,
  PingFrame,
  RelayFrame,
  RequestMessage,
  ResponseMessage,
  StreamChunkMessage,
  WebSocketFactory,
  WebSocketLike,
} from './types.js';
import { b64Decode, b64Encode, generateMessageId, randomHex, sha256Hex } from './utils.js';

const WS_OPEN = 1;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;
const GATEWAY_PEER_ID = 'gateway';

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  streaming?: boolean;
  onChunk?: (chunk: Record<string, unknown>) => Promise<void> | void;
}

export interface RelayPeerSessionOptions {
  relayUrl: string;
  inviteToken: string;
  gatewayPublicKey: string;
  identity: GatewayIdentity;
  webSocketFactory?: WebSocketFactory;
  clientId?: string;
  capabilities?: string[];
}

export class RelayPeerSession {
  readonly clientId: string;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly frameWaiters = new Map<string, { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly dataWaiters = new Map<string, { resolve: (payload: Record<string, unknown>) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private ws: WebSocketLike | undefined;
  private cipher: SessionCipher | undefined;
  private connected = false;
  private closed = false;

  constructor(private readonly options: RelayPeerSessionOptions) {
    this.webSocketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.clientId = options.clientId ?? `peer_${randomHex(8)}`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.ws) {
      throw new Error('peer session is already connecting');
    }
    this.closed = false;
    const inviteHash = await sha256Hex(this.options.inviteToken);
    await this.openSocket();
    try {
      const joinedPromise = this.waitForFrame('joined', HANDSHAKE_TIMEOUT_MS);
      await this.sendRaw({
        type: 'join',
        channel: inviteHash,
        version: 1,
        client_id: this.clientId,
      } satisfies JoinFrame);

      const joined = await joinedPromise as unknown as JoinedFrame;
      if (!joined.gateway_online) {
        throw new Error('Gateway is offline for this invite alias');
      }

      const clientNonce = crypto.getRandomValues(new Uint8Array(32));
      const hello: HelloMessage = {
        type: 'hello',
        client_public_key: b64Encode(this.options.identity.publicKeyBytes),
        session_nonce: b64Encode(clientNonce),
        protocol_version: 1,
        capabilities: this.options.capabilities ?? ['chat', 'stream', 'notify'],
      };
      const helloAckPromise = this.waitForDataPayload('hello_ack', HANDSHAKE_TIMEOUT_MS);
      await this.sendRaw({
        type: 'data',
        to: GATEWAY_PEER_ID,
        payload: JSON.stringify(hello),
      } satisfies DataFrame);

      const helloAck = await helloAckPromise as unknown as HelloAckMessage;
      if (helloAck.gateway_public_key !== this.options.gatewayPublicKey) {
        throw new Error('Gateway public key mismatch during peer invite dial');
      }
      const { cipher } = await deriveClientSession(
        this.options.identity,
        b64Decode(helloAck.gateway_public_key),
        clientNonce,
        b64Decode(helloAck.session_nonce),
      );
      this.cipher = cipher;
      this.connected = true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handleProtocolFailure(err);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.rejectHandshakeWaiters(new Error('peer session closed'));
    this.rejectPendingRequests(new Error('peer session closed'));
    if (this.ws) {
      const socket = this.ws;
      this.ws = undefined;
      try {
        socket.close(1000, 'peer session close');
      } catch {
        // ignore close errors
      }
    }
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    this.ensureConnected();
    const id = generateMessageId();
    const message: RequestMessage = { id, type: 'request', method, params };
    return new Promise<Record<string, unknown>>(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      try {
        await this.sendEncrypted(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async requestStream(
    method: string,
    params: Record<string, unknown>,
    onChunk: (chunk: Record<string, unknown>) => Promise<void> | void,
    timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    this.ensureConnected();
    const id = generateMessageId();
    const message: RequestMessage = { id, type: 'request', method, params };
    return new Promise<Record<string, unknown>>(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Stream timeout: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout, streaming: true, onChunk });
      try {
        await this.sendEncrypted(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureConnected(): void {
    if (!this.connected || !this.ws || !this.cipher) {
      throw new Error('peer session is not connected');
    }
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.webSocketFactory(this.options.relayUrl);
      this.ws = socket;
      let opened = false;
      let settled = false;

      const onOpen = () => {
        opened = true;
        settled = true;
        socket.removeEventListener('open', onOpen);
        resolve();
      };
      const onError = () => {
        if (!opened && !settled) {
          settled = true;
          socket.removeEventListener('open', onOpen);
          reject(new Error('peer relay websocket error'));
          return;
        }
        if (this.ws === socket) {
          this.handleProtocolFailure(new Error('peer relay websocket error'));
        }
      };
      const onClose = () => {
        if (!opened && !settled) {
          settled = true;
          socket.removeEventListener('open', onOpen);
          reject(new Error('peer relay websocket closed before connect'));
          return;
        }
        if (this.ws === socket && !this.closed) {
          this.handleProtocolFailure(new Error('peer relay websocket closed'));
        }
      };
      const onMessage = (event: MessageEvent | { data: string }) => {
        if (this.ws !== socket) return;
        void this.handleSocketMessage(event);
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      socket.addEventListener('message', onMessage);
    });
  }

  private async sendRaw(frame: object): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error('peer relay websocket is not open');
    }
    this.ws.send(JSON.stringify(frame));
  }

  private async sendEncrypted(message: Layer2Message): Promise<void> {
    this.ensureConnected();
    const payload = await this.cipher!.encryptJson(message as Record<string, unknown>);
    await this.sendRaw({ type: 'data', to: GATEWAY_PEER_ID, payload } satisfies DataFrame);
  }

  private waitForFrame(type: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.frameWaiters.delete(type);
        reject(new Error(`Timeout waiting for ${type} frame`));
      }, timeoutMs);
      this.frameWaiters.set(type, { resolve, reject, timeout });
    });
  }

  private waitForDataPayload(type: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.dataWaiters.delete(type);
        reject(new Error(`Timeout waiting for ${type} payload`));
      }, timeoutMs);
      this.dataWaiters.set(type, { resolve, reject, timeout });
    });
  }

  private async handleSocketMessage(event: MessageEvent | { data: string }): Promise<void> {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(String(event.data)) as RelayFrame;
    } catch {
      this.handleProtocolFailure(new RelayProtocolError('Received malformed relay frame'));
      return;
    }
    try {
      await this.handleFrame(frame);
    } catch (error) {
      this.handleProtocolFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.type === 'joined') {
      const waiter = this.frameWaiters.get('joined');
      if (waiter) {
        this.frameWaiters.delete('joined');
        clearTimeout(waiter.timeout);
        waiter.resolve(frame as JoinedFrame as unknown as Record<string, unknown>);
      }
      return;
    }

    if (frame.type === 'pong') return;

    if (frame.type === 'ping') {
      await this.sendRaw({ type: 'pong', ts: (frame as PingFrame).ts } satisfies PingFrame);
      return;
    }

    if (frame.type === 'presence') {
      const presence = frame as RelayFrame & { role?: string; status?: string };
      if (presence.role === 'gateway' && presence.status === 'offline') {
        throw new Error('Remote gateway went offline');
      }
      return;
    }

    if (frame.type === 'error') {
      const errorFrame = frame as ErrorFrame;
      const error = new Error(`Relay error: ${errorFrame.code}: ${errorFrame.message}`);
      this.rejectHandshakeWaiters(error);
      this.rejectPendingRequests(error);
      return;
    }

    if (frame.type === 'data') {
      await this.handleDataFrame(frame as DataFrame);
    }
  }

  private async handleDataFrame(frame: DataFrame): Promise<void> {
    let payload: Record<string, unknown>;
    if (this.cipher) {
      try {
        const plaintext = await this.cipher.decryptToText(frame.payload);
        payload = JSON.parse(plaintext) as Record<string, unknown>;
      } catch {
        return;
      }
    } else {
      try {
        payload = JSON.parse(frame.payload) as Record<string, unknown>;
      } catch {
        return;
      }
    }

    if (payload.type === 'hello_ack') {
      const waiter = this.dataWaiters.get('hello_ack');
      if (waiter) {
        this.dataWaiters.delete('hello_ack');
        clearTimeout(waiter.timeout);
        waiter.resolve(payload);
        return;
      }
    }

    await this.handleLayer2Message(payload as Layer2Message);
  }

  private async handleLayer2Message(message: Layer2Message): Promise<void> {
    if (!('type' in message) || typeof message.type !== 'string') return;
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    switch (message.type) {
      case 'response': {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        const response = message as ResponseMessage;
        if (response.error) {
          pending.reject(new Layer2ResponseError(response.error.code, response.error.message));
        } else {
          pending.resolve(response.result ?? {});
        }
        return;
      }
      case 'stream_start':
        return;
      case 'stream_chunk': {
        const pending = this.pendingRequests.get(id);
        if (pending?.onChunk) {
          await pending.onChunk((message as StreamChunkMessage).data ?? {});
        }
        return;
      }
      case 'stream_end':
        return;
      case 'notify':
        return;
      default:
        return;
    }
  }

  private rejectHandshakeWaiters(error: Error): void {
    for (const waiter of this.frameWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.frameWaiters.clear();
    for (const waiter of this.dataWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.dataWaiters.clear();
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleProtocolFailure(error: Error): void {
    this.connected = false;
    this.cipher = undefined;
    this.rejectHandshakeWaiters(error);
    this.rejectPendingRequests(error);
    if (this.ws) {
      const socket = this.ws;
      this.ws = undefined;
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
