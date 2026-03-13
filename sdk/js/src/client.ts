import { ChannelConnection, ChannelError, ChannelReconnected } from './channel.js';
import {
  DIRECTION_CLIENT_TO_GATEWAY,
  IdentityKeyPair,
  SessionCipher,
  deriveSessionKey,
  generateSessionNonce,
} from './crypto.js';
import { TransportLayer } from './transport.js';
import type {
  Agent,
  AgentInfo,
  ChatChunk,
  ChatResponse,
  CronTask,
  CronToggleResult,
  RelayClientOptions,
  SessionHistoryParams,
  SessionHistoryResponse,
  SessionsListParams,
  SessionsListResponse,
} from './types.js';
import { b64Decode, b64Encode, channelTokenHash, randomHex } from './utils.js';

const GATEWAY_PEER_ID = 'gateway';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class RelayClient {
  private readonly relayUrl: string;
  private readonly channelToken: string;
  private readonly gatewayPublicKeyB64: string;
  private readonly gatewayPublicKeyBytes: Uint8Array;
  private readonly clientId: string;
  private readonly eventHandlers = new Map<string, Array<(event: string, data: Record<string, unknown>) => unknown>>();

  private identity: IdentityKeyPair | null = null;
  private identitySeed: RelayClientOptions['identity'] | null = null;
  private channel: ChannelConnection | null = null;
  private transport: TransportLayer | null = null;
  private connectedState = false;
  private closed = false;
  private sessionTask: Promise<void> | null = null;

  constructor(options: RelayClientOptions) {
    this.relayUrl = options.relayUrl;
    this.channelToken = options.channelToken;
    this.gatewayPublicKeyB64 = options.gatewayPublicKey;
    this.gatewayPublicKeyBytes = b64Decode(options.gatewayPublicKey);
    this.clientId = options.clientId ?? `client_${randomHex(6)}`;

    if (options.identity) {
      this.identitySeed = options.identity;
    }
  }

  get connected(): boolean {
    return this.connectedState;
  }

  async connect(): Promise<void> {
    if (this.connectedState || this.channel) {
      throw new Error('Already connected');
    }

    this.closed = false;
    const channel = new ChannelConnection();
    try {
      await channel.connect(this.relayUrl);

      const hash = await channelTokenHash(this.channelToken);
      await channel.join(hash, this.clientId);

      this.channel = channel;

      while (true) {
        try {
          await this._doHelloHandshake();
          break;
        } catch (err) {
          if (err instanceof ChannelReconnected) {
            continue;
          }
          throw err;
        }
      }

      this.sessionTask = this._sessionLoop();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.connectedState = false;

    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }

    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }

    if (this.sessionTask) {
      try {
        await this.sessionTask;
      } catch {
        // ignore
      }
      this.sessionTask = null;
    }
  }

  async chat(agent: string, message: string, stream = true): Promise<AsyncIterable<ChatChunk> | ChatResponse> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const params: Record<string, unknown> = { agent, message };

    if (stream) {
      params.stream = true;
      const iterator = transport.requestStream('chat.send', params);
      return (async function* () {
        for await (const chunk of iterator) {
          yield {
            delta: String(chunk.delta ?? ''),
            session_id: String(chunk.session_id ?? ''),
          } satisfies ChatChunk;
        }
      })();
    }

    const result = await transport.request('chat.send', params);
    return {
      content: String(result.content ?? ''),
      session_id: String(result.session_id ?? ''),
      agent: String(result.agent ?? agent),
      tokens: (result.tokens as Record<string, unknown>) ?? {},
    } satisfies ChatResponse;
  }

  async agentsList(): Promise<Agent[]> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const result = await transport.request('agents.list', {});
    const agents = Array.isArray(result.agents) ? result.agents as Array<Record<string, unknown>> : [];

    return agents.map((agent) => ({
      name: String(agent.name ?? ''),
      display_name: String(agent.display_name ?? ''),
      status: String(agent.status ?? 'unknown'),
      description: String(agent.description ?? ''),
      group: typeof agent.group === 'string' ? agent.group : undefined,
    }));
  }

  async agentsInfo(agent: string): Promise<AgentInfo> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const result = await transport.request('agents.info', { agent });
    return {
      name: String(result.name ?? agent),
      display_name: String(result.display_name ?? ''),
      status: String(result.status ?? 'unknown'),
      description: String(result.description ?? ''),
      group: typeof result.group === 'string' ? result.group : undefined,
      tools: Array.isArray(result.tools) ? result.tools.map((tool) => String(tool)) : [],
      recent_sessions: Number(result.recent_sessions ?? 0),
    };
  }

  async sessionsList(params: SessionsListParams = {}): Promise<SessionsListResponse> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const requestParams: Record<string, unknown> = {};
    if (params.agent) requestParams.agent = params.agent;
    if (params.limit !== undefined) requestParams.limit = params.limit;
    if (params.offset !== undefined) requestParams.offset = params.offset;

    const result = await transport.request('sessions.list', requestParams);
    const sessions = Array.isArray(result.sessions) ? result.sessions as Array<Record<string, unknown>> : [];

    return {
      sessions: sessions.map((session) => ({
        id: String(session.id ?? ''),
        agent: String(session.agent ?? ''),
        started_at: String(session.started_at ?? ''),
        last_message_at: String(session.last_message_at ?? ''),
        message_count: Number(session.message_count ?? 0),
        preview: String(session.preview ?? ''),
      })),
      total: Number(result.total ?? sessions.length),
    };
  }

  async sessionsHistory(params: SessionHistoryParams): Promise<SessionHistoryResponse> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const requestParams: Record<string, unknown> = { session_id: params.session_id };
    if (params.limit !== undefined) requestParams.limit = params.limit;
    if ('before' in params) requestParams.before = params.before;

    const result = await transport.request('sessions.history', requestParams);
    const messages = Array.isArray(result.messages) ? result.messages as Array<Record<string, unknown>> : [];

    return {
      messages: messages.map((msg) => ({
        role: String(msg.role ?? ''),
        content: String(msg.content ?? ''),
        timestamp: String(msg.timestamp ?? ''),
      })),
      has_more: Boolean(result.has_more),
    };
  }

  async cronList(): Promise<CronTask[]> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const result = await transport.request('cron.list', {});
    const tasks = Array.isArray(result.tasks) ? result.tasks as Array<Record<string, unknown>> : [];

    return tasks.map((task) => ({
      id: String(task.id ?? ''),
      name: String(task.name ?? ''),
      agent: String(task.agent ?? ''),
      schedule: String(task.schedule ?? ''),
      enabled: Boolean(task.enabled),
      last_run: String(task.last_run ?? ''),
      last_status: String(task.last_status ?? ''),
    }));
  }

  async cronToggle(id: string, enabled: boolean): Promise<CronToggleResult> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    const result = await transport.request('cron.toggle', { id, enabled });
    return {
      id: String(result.id ?? id),
      enabled: Boolean(result.enabled ?? enabled),
    };
  }

  async systemStatus(): Promise<Record<string, unknown>> {
    this._ensureConnected();
    const transport = this.transport as TransportLayer;
    return await transport.request('system.status', {});
  }

  on(event: string, handler: (event: string, data: Record<string, unknown>) => unknown): void {
    const list = this.eventHandlers.get(event) ?? [];
    list.push(handler);
    this.eventHandlers.set(event, list);

    if (this.transport) {
      this.transport.on(event, handler);
    }
  }

  private async _ensureIdentity(): Promise<IdentityKeyPair> {
    if (this.identity) return this.identity;
    if (this.identitySeed) {
      this.identity = await IdentityKeyPair.fromIdentity(this.identitySeed);
      return this.identity;
    }
    this.identity = await IdentityKeyPair.generate();
    return this.identity;
  }

  private async _doHelloHandshake(): Promise<void> {
    if (!this.channel) throw new Error('Channel not connected');

    const identity = await this._ensureIdentity();
    const clientNonce = generateSessionNonce();

    const helloPayload = {
      type: 'hello',
      client_public_key: b64Encode(identity.publicKeyBytes),
      session_nonce: b64Encode(clientNonce),
      protocol_version: 1,
      capabilities: ['chat', 'stream', 'notify'],
    };

    await this.channel.sendData(GATEWAY_PEER_ID, JSON.stringify(helloPayload));

    const helloAck = await this._waitForHelloAck(this.channel);

    const gatewayPubBytes = b64Decode(String(helloAck.gateway_public_key ?? ''));
    const gatewayNonce = b64Decode(String(helloAck.session_nonce ?? ''));

    if (!bytesEqual(gatewayPubBytes, this.gatewayPublicKeyBytes)) {
      throw new Error('Gateway public key mismatch; pairing key does not match HELLO_ACK');
    }

    const sessionKey = await deriveSessionKey({
      privateKey: identity.privateKey,
      clientPublicKey: identity.publicKeyBytes,
      gatewayPublicKey: gatewayPubBytes,
      clientSessionNonce: clientNonce,
      gatewaySessionNonce: gatewayNonce,
    });

    const cipher = new SessionCipher(sessionKey, DIRECTION_CLIENT_TO_GATEWAY);
    const transport = new TransportLayer(this.channel, cipher, this.clientId, GATEWAY_PEER_ID);

    for (const [event, handlers] of this.eventHandlers.entries()) {
      for (const handler of handlers) {
        transport.on(event, handler);
      }
    }

    await transport.start();
    this.transport = transport;
    this.connectedState = true;
  }

  private async _sessionLoop(): Promise<void> {
    while (!this.closed) {
      if (!this.transport) return;
      await this.transport.waitDone();

      if (this.closed) return;

      this.connectedState = false;
      this.transport = null;

      while (!this.closed) {
        try {
          await this._doHelloHandshake();
          break;
        } catch (err) {
          if (err instanceof ChannelReconnected) {
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }

  private async _waitForHelloAck(channel: ChannelConnection, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const waitForPayload = async (): Promise<Record<string, unknown>> => {
      while (true) {
        const frame = await channel.recv();
        if (String(frame.type || '') === 'error') {
          throw new ChannelError(String(frame.message || 'Relay error during handshake'));
        }
        if (String(frame.type || '') !== 'data') {
          continue;
        }
        const payloadRaw = frame.payload;
        if (typeof payloadRaw !== 'string') {
          continue;
        }
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(payloadRaw) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (payload?.type === 'hello_ack') {
          return payload;
        }
        if (payload?.type === 'hello_reject') {
          const code = String(payload.code || 'rejected');
          const message = String(payload.message || 'Handshake rejected');
          throw new Error(`[${code}] ${message}`);
        }
      }
    };

    return await Promise.race([
      waitForPayload(),
      new Promise<Record<string, unknown>>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for HELLO_ACK from gateway')), timeoutMs);
      }),
    ]);
  }

  private _ensureConnected(): void {
    if (!this.connectedState || !this.transport) {
      throw new Error('Not connected. Call connect() first.');
    }
  }
}
