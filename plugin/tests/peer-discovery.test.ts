import { describe, expect, it, vi } from 'vitest';
import { GatewayPeerDiscovery } from '../src/peer-discovery.js';

const keyA = Buffer.alloc(32, 0x11).toString('base64');
const keyB = Buffer.alloc(32, 0x22).toString('base64');
const eph = Buffer.alloc(32, 0x33).toString('base64');

describe('GatewayPeerDiscovery', () => {
  it('sends discover and resolves discover_result', async () => {
    const sendFrame = vi.fn(async () => undefined);
    const discovery = new GatewayPeerDiscovery({ sendFrame });

    const pending = discovery.listPeers();
    expect(sendFrame).toHaveBeenCalledWith({ type: 'discover' });

    await discovery.handleFrame({
      type: 'discover_result',
      peers: [
        {
          public_key: keyA,
          metadata: { name: 'alpha' },
          online_since: '2026-03-09T12:00:00Z',
        },
      ],
    });

    await expect(pending).resolves.toEqual([
      {
        public_key: keyA,
        metadata: { name: 'alpha' },
        online_since: '2026-03-09T12:00:00Z',
      },
    ]);
  });

  it('creates invite aliases and resolves invite_created', async () => {
    const sendFrame = vi.fn(async () => undefined);
    const discovery = new GatewayPeerDiscovery({ sendFrame });
    const inviteHash = 'd'.repeat(64);

    const pending = discovery.createInvite(inviteHash, 300);
    expect(sendFrame).toHaveBeenCalledWith({
      type: 'invite_create',
      invite_hash: inviteHash,
      max_uses: 1,
      ttl_seconds: 300,
    });

    await discovery.handleFrame({
      type: 'invite_created',
      invite_hash: inviteHash,
      expires_at: '2026-03-09T12:05:00Z',
    });

    await expect(pending).resolves.toEqual({
      type: 'invite_created',
      invite_hash: inviteHash,
      expires_at: '2026-03-09T12:05:00Z',
    });
  });

  it('delivers incoming signals and signal errors to listeners', async () => {
    const sendFrame = vi.fn(async () => undefined);
    const discovery = new GatewayPeerDiscovery({ sendFrame });
    const signalListener = vi.fn(async () => undefined);
    const signalErrorListener = vi.fn(async () => undefined);

    discovery.onSignal(signalListener);
    discovery.onSignalError(signalErrorListener);

    await discovery.sendSignal(keyB, eph, 'opaque');
    expect(sendFrame).toHaveBeenCalledWith({
      type: 'signal',
      target: keyB,
      ephemeral_key: eph,
      payload: 'opaque',
    });

    await discovery.handleFrame({
      type: 'signal',
      source: keyA,
      ephemeral_key: eph,
      payload: 'ciphertext',
    });
    expect(signalListener).toHaveBeenCalledWith({
      type: 'signal',
      source: keyA,
      ephemeral_key: eph,
      payload: 'ciphertext',
    });

    await discovery.handleFrame({
      type: 'signal_error',
      code: 'peer_offline',
      target: keyB,
    });
    expect(signalErrorListener).toHaveBeenCalledWith({
      type: 'signal_error',
      code: 'peer_offline',
      target: keyB,
    });
  });
});
