import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveGatewaySession, generateGatewayIdentity, GatewayIdentity } from '../src/crypto.js';
import { RelayPeerSession } from '../src/outbound-peer-session.js';
import type { WebSocketLike } from '../src/types.js';
import { b64Decode, b64Encode, sha256Hex } from '../src/utils.js';

class MockPeerWebSocket implements WebSocketLike {
  readyState = 1;
  readonly sentFrames: Record<string, unknown>[] = [];
  readonly joinedChannels: string[] = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private serverCipher: Awaited<ReturnType<typeof deriveGatewaySession>>['cipher'] | undefined;

  constructor(
    private readonly gatewayIdentity: GatewayIdentity,
    private readonly expectedInviteHash: string,
    private readonly helloAckPublicKey: string = gatewayIdentity.serialized.publicKey,
    private readonly respondToPing = true,
    private readonly sendTrailingResponse = true,
  ) {
    queueMicrotask(() => this.emit('open', {}));
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sentFrames.push(frame);
    void this.handleSend(frame);
  }

  close(): void {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', {}));
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private async handleSend(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'join') {
      if (typeof frame.channel === 'string') {
        this.joinedChannels.push(frame.channel);
      }
      this.emit('message', { data: JSON.stringify({ type: 'joined', channel: this.expectedInviteHash, gateway_online: true }) });
      return;
    }

    if (frame.type === 'pong') {
      return;
    }

    if (frame.type === 'ping') {
      if (this.respondToPing && typeof frame.ts === 'number') {
        this.emit('message', { data: JSON.stringify({ type: 'pong', ts: frame.ts }) });
      }
      return;
    }

    if (frame.type !== 'data' || typeof frame.payload !== 'string') {
      return;
    }

    if (!this.serverCipher) {
      const hello = JSON.parse(frame.payload) as { type: string; client_public_key: string; session_nonce: string };
      if (hello.type !== 'hello') {
        throw new Error('expected hello payload during handshake');
      }
      const gatewaySession = await deriveGatewaySession(
        this.gatewayIdentity,
        b64Decode(hello.client_public_key),
        b64Decode(hello.session_nonce),
      );
      this.serverCipher = gatewaySession.cipher;
      this.emit('message', {
        data: JSON.stringify({
          type: 'data',
          from: 'gateway',
          to: frame.to,
          payload: JSON.stringify({
            type: 'hello_ack',
            gateway_public_key: this.helloAckPublicKey,
            session_nonce: b64Encode(gatewaySession.gatewayNonce),
            protocol_version: 1,
            capabilities: ['chat', 'stream', 'system'],
          }),
        }),
      });
      return;
    }

    const plaintext = await this.serverCipher.decryptToText(frame.payload);
    const message = JSON.parse(plaintext) as { id: string; type: string; method?: string; params?: Record<string, unknown> };
    if (message.type !== 'request') {
      return;
    }

    if (message.method === 'system.status') {
      const payload = await this.serverCipher.encryptJson({
        id: message.id,
        type: 'response',
        result: { ok: true, remote: 'peer-gateway' },
      });
      this.emit('message', { data: JSON.stringify({ type: 'data', from: 'gateway', to: frame.to, payload }) });
      return;
    }

    if (message.method === 'chat.send') {
      const frames: Record<string, unknown>[] = [
        { id: message.id, type: 'stream_start', method: 'chat.send' },
        { id: message.id, type: 'stream_chunk', seq: 1, data: { delta: 'hello ' } },
        { id: message.id, type: 'stream_chunk', seq: 2, data: { delta: 'world' } },
        { id: message.id, type: 'stream_end', seq: 3 },
      ];
      if (this.sendTrailingResponse) {
        frames.push({ id: message.id, type: 'response', result: { session_id: 'peer-session', agent: 'remote-agent' } });
      }
      for (const inner of frames) {
        const payload = await this.serverCipher.encryptJson(inner as Record<string, unknown>);
        this.emit('message', { data: JSON.stringify({ type: 'data', from: 'gateway', to: frame.to, payload }) });
      }
    }
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('RelayPeerSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins an invite alias and performs request and stream calls', async () => {
    const localIdentity = await generateGatewayIdentity();
    const remoteIdentity = await generateGatewayIdentity();
    const inviteToken = 'peer-invite-token';
    const inviteHash = await sha256Hex(inviteToken);
    let socket: MockPeerWebSocket | undefined;

    const session = new RelayPeerSession({
      relayUrl: 'ws://relay.example.test/ws',
      inviteToken,
      gatewayPublicKey: remoteIdentity.serialized.publicKey,
      identity: localIdentity,
      webSocketFactory: () => {
        socket = new MockPeerWebSocket(remoteIdentity, inviteHash);
        return socket;
      },
      clientId: 'peer-client-1',
    });

    await session.connect();
    expect(session.isConnected).toBe(true);

    await expect(session.request('system.status', {})).resolves.toEqual({ ok: true, remote: 'peer-gateway' });

    const chunks: Array<Record<string, unknown>> = [];
    await expect(session.requestStream('chat.send', { message: 'hi', stream: true }, (chunk) => {
      chunks.push(chunk);
    })).resolves.toEqual({ session_id: 'peer-session', agent: 'remote-agent' });
    expect(chunks).toEqual([{ delta: 'hello ' }, { delta: 'world' }]);

    await session.close();
    expect(socket?.sentFrames[0]).toMatchObject({ type: 'join', client_id: 'peer-client-1' });
    expect(socket?.joinedChannels).toEqual([inviteHash]);
  });

  it('resolves a streaming request on stream_end when no trailing response arrives', async () => {
    const localIdentity = await generateGatewayIdentity();
    const remoteIdentity = await generateGatewayIdentity();
    const inviteToken = 'peer-invite-token-no-response';
    const inviteHash = await sha256Hex(inviteToken);

    const session = new RelayPeerSession({
      relayUrl: 'ws://relay.example.test/ws',
      inviteToken,
      gatewayPublicKey: remoteIdentity.serialized.publicKey,
      identity: localIdentity,
      webSocketFactory: () => new MockPeerWebSocket(remoteIdentity, inviteHash, remoteIdentity.serialized.publicKey, true, false),
    });

    await session.connect();
    const chunks: Array<Record<string, unknown>> = [];
    const resultPromise = session.requestStream('chat.send', { message: 'hi', stream: true }, (chunk) => {
      chunks.push(chunk);
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(resultPromise).resolves.toEqual({});
    expect(chunks).toEqual([{ delta: 'hello ' }, { delta: 'world' }]);

    await session.close();
  });

  it('rejects invite dial when hello_ack gateway key mismatches the expected peer key', async () => {
    const localIdentity = await generateGatewayIdentity();
    const remoteIdentity = await generateGatewayIdentity();
    const wrongIdentity = await generateGatewayIdentity();
    const inviteToken = 'peer-invite-token';
    const inviteHash = await sha256Hex(inviteToken);

    const session = new RelayPeerSession({
      relayUrl: 'ws://relay.example.test/ws',
      inviteToken,
      gatewayPublicKey: remoteIdentity.serialized.publicKey,
      identity: localIdentity,
      webSocketFactory: () => new MockPeerWebSocket(wrongIdentity, inviteHash, wrongIdentity.serialized.publicKey),
    });

    await expect(session.connect()).rejects.toThrow('Gateway public key mismatch during peer invite dial');
  });

  it('sends heartbeat pings to keep peer sessions alive', async () => {
    vi.useFakeTimers();
    const localIdentity = await generateGatewayIdentity();
    const remoteIdentity = await generateGatewayIdentity();
    const inviteToken = 'peer-invite-token';
    const inviteHash = await sha256Hex(inviteToken);
    let socket: MockPeerWebSocket | undefined;

    const session = new RelayPeerSession({
      relayUrl: 'ws://relay.example.test/ws',
      inviteToken,
      gatewayPublicKey: remoteIdentity.serialized.publicKey,
      identity: localIdentity,
      webSocketFactory: () => {
        socket = new MockPeerWebSocket(remoteIdentity, inviteHash);
        return socket;
      },
    });

    await session.connect();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(socket?.sentFrames.some((frame) => frame.type === 'ping')).toBe(true);
    expect(session.isConnected).toBe(true);

    await session.close();
  });

  it('drops the peer session when heartbeat pong is missing', async () => {
    vi.useFakeTimers();
    const localIdentity = await generateGatewayIdentity();
    const remoteIdentity = await generateGatewayIdentity();
    const inviteToken = 'peer-invite-token';
    const inviteHash = await sha256Hex(inviteToken);

    const session = new RelayPeerSession({
      relayUrl: 'ws://relay.example.test/ws',
      inviteToken,
      gatewayPublicKey: remoteIdentity.serialized.publicKey,
      identity: localIdentity,
      webSocketFactory: () => new MockPeerWebSocket(remoteIdentity, inviteHash, remoteIdentity.serialized.publicKey, false),
    });

    await session.connect();
    await vi.advanceTimersByTimeAsync(40_000);

    expect(session.isConnected).toBe(false);
    await expect(session.request('system.status', {})).rejects.toThrow('peer session is not connected');
  });
});
