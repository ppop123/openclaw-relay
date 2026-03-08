import { RelayFatalError } from './errors.js';
import { ConnectionState, ErrorFrame, GatewayStatus, PingFrame, RegisteredFrame, RelayFrame, WebSocketFactory, WebSocketLike } from './types.js';

const WS_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

export interface RelayConnectionOptions {
  url: string;
  channel: string;
  webSocketFactory?: WebSocketFactory;
  onFrame: (frame: RelayFrame) => Promise<void> | void;
  onErrorFrame?: (frame: ErrorFrame) => Promise<void> | void;
  onStateChange?: (state: ConnectionState) => void;
  onRegistered?: (frame: RegisteredFrame) => void;
}

function isRegisteredFrame(frame: RelayFrame): frame is RegisteredFrame {
  return frame.type === 'registered' && typeof (frame as RegisteredFrame).channel === 'string';
}

function isErrorFrame(frame: RelayFrame): frame is ErrorFrame {
  return frame.type === 'error' && typeof (frame as ErrorFrame).code === 'string' && typeof (frame as ErrorFrame).message === 'string';
}

function isPingFrame(frame: RelayFrame): frame is PingFrame {
  return frame.type === 'ping' && typeof (frame as PingFrame).ts === 'number';
}

export class RelayConnection {
  private readonly webSocketFactory: WebSocketFactory;
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private registered = false;
  private reconnectDelayMs = 1000;
  private heartbeatGeneration = 0;
  private awaitingPongTs: number | null = null;
  private connectPromise: Promise<void> | null = null;
  private state: ConnectionState = 'disconnected';
  private lastRegisteredAt: string | undefined;
  private lastFatalErrorCode: string | undefined;

  constructor(private readonly options: RelayConnectionOptions) {
    this.webSocketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  }

  getStatusBase(): Pick<GatewayStatus, 'state' | 'lastRegisteredAt' | 'lastFatalErrorCode'> {
    return {
      state: this.state,
      ...(this.lastRegisteredAt ? { lastRegisteredAt: this.lastRegisteredAt } : {}),
      ...(this.lastFatalErrorCode ? { lastFatalErrorCode: this.lastFatalErrorCode } : {}),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.connectPromise) {
      this.connectPromise = this.connectOnce();
    }
    return this.connectPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close(1000, 'plugin stop');
    this.ws = null;
    this.registered = false;
    this.connectPromise = null;
    this.setState('disconnected');
  }

  async send(frame: object): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error('relay websocket is not open');
    }
    this.ws.send(JSON.stringify(frame));
  }

  private async connectOnce(): Promise<void> {
    this.setState(this.state === 'disconnected' ? 'connecting' : 'reconnecting');
    this.registered = false;

    await new Promise<void>((resolve, reject) => {
      const ws = this.webSocketFactory(this.options.url);
      this.ws = ws;

      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
      };

      const onOpen = () => {
        try {
          ws.send(JSON.stringify({ type: 'register', channel: this.options.channel, version: 1 }));
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      const onMessage = async (event: MessageEvent | { data: string }) => {
        try {
          const frame = JSON.parse(String(event.data)) as RelayFrame;
          if (!this.registered) {
            if (isRegisteredFrame(frame)) {
              this.registered = true;
              this.reconnectDelayMs = 1000;
              this.lastRegisteredAt = new Date().toISOString();
              this.lastFatalErrorCode = undefined;
              this.setState('registered');
              this.options.onRegistered?.(frame);
              this.startHeartbeat();
              cleanup();
              this.attachLiveListeners(ws);
              resolve();
              return;
            }
            if (isErrorFrame(frame)) {
              if (frame.code === 'channel_occupied' || frame.code === 'channel_limit_reached') {
                this.lastFatalErrorCode = frame.code;
                cleanup();
                reject(new RelayFatalError(frame.code, frame.message));
                return;
              }
              cleanup();
              reject(new Error(`${frame.code}: ${frame.message}`));
              return;
            }
            return;
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error('relay connection closed before register'));
      };

      const onError = () => {
        cleanup();
        reject(new Error('relay websocket error'));
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    }).catch(async (error) => {
      this.clearHeartbeat();
      this.ws = null;
      this.registered = false;
      if (error instanceof RelayFatalError) {
        this.setState('disconnected');
        this.connectPromise = null;
        throw error;
      }
      if (!this.stopped) {
        this.setState('reconnecting');
        await this.delay(this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
        this.connectPromise = this.connectOnce();
        await this.connectPromise;
      } else {
        this.setState('disconnected');
        this.connectPromise = null;
      }
    });
  }

  private attachLiveListeners(ws: WebSocketLike): void {
    const onMessage = async (event: MessageEvent | { data: string }) => {
      const frame = JSON.parse(String(event.data)) as RelayFrame;
      if (frame.type === 'pong') {
        this.awaitingPongTs = null;
        return;
      }
      if (isPingFrame(frame)) {
        await this.send({ type: 'pong', ts: frame.ts });
        return;
      }
      if (isErrorFrame(frame)) {
        await this.options.onErrorFrame?.(frame);
        return;
      }
      await this.options.onFrame(frame);
    };

    const onClose = async () => {
      this.clearHeartbeat();
      this.ws = null;
      this.registered = false;
      if (this.stopped) {
        this.setState('disconnected');
        return;
      }
      this.setState('reconnecting');
      await this.delay(this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
      this.connectPromise = this.connectOnce();
      try {
        await this.connectPromise;
      } catch {
        // connectOnce already owns retry/fatal behavior.
      }
    };

    const onError = () => {
      // close handler manages reconnects.
    };

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const generation = ++this.heartbeatGeneration;
    void this.runHeartbeat(generation);
  }

  private clearHeartbeat(): void {
    this.heartbeatGeneration += 1;
    this.awaitingPongTs = null;
  }

  private async runHeartbeat(generation: number): Promise<void> {
    while (generation === this.heartbeatGeneration && !this.stopped) {
      await this.delay(HEARTBEAT_INTERVAL_MS);
      if (generation !== this.heartbeatGeneration || this.stopped) return;
      if (!this.ws || this.ws.readyState !== WS_OPEN) return;
      const ts = Date.now();
      this.awaitingPongTs = ts;
      try {
        await this.send({ type: 'ping', ts });
      } catch {
        this.ws?.close(4001, 'ping failed');
        return;
      }
      await this.delay(PONG_TIMEOUT_MS);
      if (generation !== this.heartbeatGeneration || this.stopped) return;
      if (this.awaitingPongTs === ts) {
        this.ws?.close(4000, 'pong timeout');
        return;
      }
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
