import { describe, expect, it, vi } from 'vitest';
import { generateGatewayIdentity } from '../src/crypto.js';
import { PeerDiscoveryService, decryptPeerSignalEnvelope, encryptPeerSignalEnvelope } from '../src/peer-discovery.js';

const targetKey = Buffer.alloc(32, 0x44).toString('base64');

describe('PeerDiscoveryService', () => {
  it('builds register fields only when peer discovery is enabled', async () => {
    const identity = await generateGatewayIdentity();
    const sendFrame = vi.fn(async () => undefined);
    const service = new PeerDiscoveryService({
      identity,
      discoveryConfig: () => ({ enabled: true, metadata: { name: 'alpha' } }),
      capabilities: () => ['chat', 'system', 'chat'],
      sendFrame,
    });

    expect(service.getRegisterFields()).toEqual({
      discoverable: true,
      public_key: identity.serialized.publicKey,
      metadata: {
        name: 'alpha',
        capabilities: ['chat', 'system'],
      },
    });
  });

  it('sends discover and resolves discover_result', async () => {
    const identity = await generateGatewayIdentity();
    const sendFrame = vi.fn(async () => undefined);
    const service = new PeerDiscoveryService({
      identity,
      discoveryConfig: () => ({ enabled: false }),
      capabilities: () => [],
      sendFrame,
    });

    const pending = service.discoverPeers();
    expect(sendFrame).toHaveBeenCalledWith({ type: 'discover' });

    await service.handleFrame({
      type: 'discover_result',
      peers: [
        {
          public_key: targetKey,
          metadata: { name: 'beta' },
          online_since: '2026-03-09T12:00:00Z',
        },
      ],
    });

    await expect(pending).resolves.toEqual([
      {
        public_key: targetKey,
        metadata: { name: 'beta' },
        online_since: '2026-03-09T12:00:00Z',
      },
    ]);
  });

  it('decrypts incoming forwarded peer signals', async () => {
    const senderIdentity = await generateGatewayIdentity();
    const receiverIdentity = await generateGatewayIdentity();
    const receiver = new PeerDiscoveryService({
      identity: receiverIdentity,
      discoveryConfig: () => ({ enabled: true }),
      capabilities: () => ['chat'],
      sendFrame: async () => undefined,
    });

    const envelope = { version: 1 as const, kind: 'invite.request', body: { hello: 'world' } };
    const encrypted = await encryptPeerSignalEnvelope(receiverIdentity.serialized.publicKey, envelope);

    await receiver.handleFrame({
      type: 'signal',
      source: senderIdentity.serialized.publicKey,
      ephemeral_key: encrypted.ephemeralKey,
      payload: encrypted.payload,
    });

    const signals = receiver.drainSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.source).toBe(senderIdentity.serialized.publicKey);
    expect(signals[0]?.envelope).toEqual(envelope);
    expect(signals[0]?.raw).toEqual({
      type: 'signal',
      source: senderIdentity.serialized.publicKey,
      ephemeral_key: encrypted.ephemeralKey,
      payload: encrypted.payload,
    });
    expect(typeof signals[0]?.receivedAt).toBe('string');
  });

  it('tracks invite_create and signal_error responses', async () => {
    const identity = await generateGatewayIdentity();
    const sendFrame = vi.fn(async () => undefined);
    const service = new PeerDiscoveryService({
      identity,
      discoveryConfig: () => ({ enabled: true }),
      capabilities: () => ['chat'],
      sendFrame,
    });

    const pending = service.createInviteHash('d'.repeat(64), 300);
    expect(sendFrame).toHaveBeenCalledWith({
      type: 'invite_create',
      invite_hash: 'd'.repeat(64),
      max_uses: 1,
      ttl_seconds: 300,
    });

    await service.handleFrame({
      type: 'invite_created',
      invite_hash: 'd'.repeat(64),
      expires_at: '2026-03-09T12:05:00Z',
    });
    await expect(pending).resolves.toEqual({
      type: 'invite_created',
      invite_hash: 'd'.repeat(64),
      expires_at: '2026-03-09T12:05:00Z',
    });

    await service.handleFrame({
      type: 'signal_error',
      code: 'peer_offline',
      target: targetKey,
    });
    expect(service.drainSignalErrors()).toEqual([
      {
        type: 'signal_error',
        code: 'peer_offline',
        target: targetKey,
      },
    ]);
  });
});
