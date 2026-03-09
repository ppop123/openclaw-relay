import { describe, expect, it, vi } from 'vitest';
import {
  createRelayPeerAgentService,
  isInviteOfferSignal,
  isInviteRejectSignal,
  isInviteRequestSignal,
  RelayPeerAgentService,
} from '../src/peer-agent-service.js';
import type { RelayAgentBridge } from '../src/openclaw-host.js';
import type { ReceivedPeerSignal } from '../src/types.js';

function signal(source: string, kind: string, body?: Record<string, unknown>): ReceivedPeerSignal {
  return {
    source,
    envelope: { version: 1, kind, ...(body ? { body } : {}) },
    receivedAt: '2026-03-09T00:00:00.000Z',
    raw: { type: 'signal', source, ephemeral_key: 'ephemeral', payload: 'payload' },
  };
}

function createBridge(): RelayAgentBridge {
  return {
    ensureStarted: vi.fn(async () => ({ state: 'registered', health: 'healthy', approvedClients: 0, activeSessions: 0 })),
    stopAccount: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ state: 'registered', health: 'healthy', approvedClients: 0, activeSessions: 0 })),
    discoverPeers: vi.fn(async () => [{ public_key: 'peer-key', online_since: '2026-03-09T00:00:00.000Z' }]),
    sendPeerSignal: vi.fn(async () => undefined),
    createPeerInvite: vi.fn(async () => ({ inviteToken: 'invite-token', inviteHash: 'invite-hash', expiresAt: '2026-03-09T00:05:00.000Z' })),
    acceptPeerSignal: vi.fn(async () => ({ sourcePublicKey: 'peer-key', fingerprint: 'sha256:peer', peerAuthorizedUntil: '2026-03-09T00:05:00.000Z', inviteToken: 'invite-token', inviteHash: 'invite-hash', expiresAt: '2026-03-09T00:05:00.000Z' })),
    dialPeerInvite: vi.fn(async () => ({ isConnected: true, request: vi.fn(async () => ({ ok: true })), requestStream: vi.fn(async () => ({ done: true })), close: vi.fn(async () => undefined) } as any)),
    drainPeerSignals: vi.fn(() => []),
    drainPeerSignalErrors: vi.fn(() => []),
  };
}

describe('RelayPeerAgentService', () => {
  it('orchestrates request, accept, connect, request proxy, and teardown', async () => {
    const bridge = createBridge();
    const service = createRelayPeerAgentService({ bridge, accountId: 'default' });

    await service.ensureStarted();
    await expect(service.discoverPeers()).resolves.toEqual([{ public_key: 'peer-key', online_since: '2026-03-09T00:00:00.000Z' }]);

    await service.requestPeerInvite('peer-key', { purpose: 'test' });
    expect(bridge.sendPeerSignal).toHaveBeenCalledWith(
      'peer-key',
      { version: 1, kind: 'invite_request', body: { purpose: 'test' } },
      { accountId: 'default' },
    );

    const requestSignal = signal('peer-key', 'invite_request', { purpose: 'test' });
    await expect(service.acceptPeerRequest(requestSignal, { ttlSeconds: 45, maxUses: 1 }, { policy: 'allow' })).resolves.toEqual({
      inviteToken: 'invite-token',
      expiresAt: '2026-03-09T00:05:00.000Z',
      peerAuthorizedUntil: '2026-03-09T00:05:00.000Z',
    });
    expect(bridge.acceptPeerSignal).toHaveBeenCalledWith('peer-key', { accountId: 'default', ttlSeconds: 45, maxUses: 1 });
    expect(bridge.sendPeerSignal).toHaveBeenLastCalledWith(
      'peer-key',
      {
        version: 1,
        kind: 'invite_offer',
        body: {
          invite_token: 'invite-token',
          expires_at: '2026-03-09T00:05:00.000Z',
          peer_authorized_until: '2026-03-09T00:05:00.000Z',
          policy: 'allow',
        },
      },
      { accountId: 'default' },
    );

    const offerSignal = signal('peer-key', 'invite_offer', {
      invite_token: 'invite-token',
      expires_at: '2026-03-09T00:05:00.000Z',
      peer_authorized_until: '2026-03-09T00:05:00.000Z',
    });
    const session = await service.connectFromInviteOffer(offerSignal, { clientId: 'peer-client-1' });
    expect(isInviteOfferSignal(offerSignal)).toBe(true);
    expect(isInviteRequestSignal(requestSignal)).toBe(true);
    expect(bridge.dialPeerInvite).toHaveBeenCalledWith('invite-token', 'peer-key', expect.objectContaining({ accountId: 'default', clientId: 'peer-client-1' }));
    expect(service.listConnectedPeers()).toEqual(['peer-key']);

    await expect(service.requestPeer('peer-key', 'system.status', {})).resolves.toEqual({ ok: true });
    await service.closeAllPeerSessions();
    expect(service.listConnectedPeers()).toEqual([]);
    expect((session.close as any)).toHaveBeenCalledTimes(1);
  });

  it('classifies and parses reject signals', () => {
    const rejected = signal('peer-key', 'invite_reject', { reason: 'busy', retry_after: 30 });
    expect(isInviteRejectSignal(rejected)).toBe(true);
    expect(RelayPeerAgentService.parseInviteReject(rejected)).toEqual({
      reason: 'busy',
      body: { reason: 'busy', retry_after: 30 },
    });
  });

  it('prunes stale peer sessions before reporting and only throws when autoDial is disabled', async () => {
    const bridge = createBridge();
    const staleSession = {
      isConnected: false,
      request: vi.fn(async () => ({ ok: true })),
      requestStream: vi.fn(async () => ({ done: true })),
      close: vi.fn(async () => undefined),
    } as any;
    (bridge.dialPeerInvite as any).mockResolvedValueOnce(staleSession);
    const service = createRelayPeerAgentService({ bridge, accountId: 'default' });

    const offerSignal = signal('peer-key', 'invite_offer', {
      invite_token: 'invite-token',
      expires_at: '2026-03-09T00:05:00.000Z',
      peer_authorized_until: '2026-03-09T00:05:00.000Z',
    });

    await service.connectFromInviteOffer(offerSignal, { clientId: 'peer-client-stale' });

    expect(service.listConnectedPeers()).toEqual([]);
    expect(service.listPeerSessionStatuses()).toMatchObject([
      { peerPublicKey: 'peer-key', connected: false, canAutoDial: true, lastClientId: 'peer-client-stale' },
    ]);
    await expect(service.requestPeer('peer-key', 'system.status', {}, { autoDial: false })).rejects.toThrow('no active peer session');
  });

  it('auto-dials on first peer request when no session exists', async () => {
    const bridge = createBridge();
    (bridge.drainPeerSignals as any)
      .mockReturnValueOnce([
        signal('peer-key', 'invite_offer', {
          invite_token: 'invite-token',
          expires_at: '2026-03-09T00:05:00.000Z',
          peer_authorized_until: '2026-03-09T00:05:00.000Z',
        }),
      ])
      .mockReturnValue([]);
    const requestSpy = vi.fn(async () => ({ ok: true, version: 'remote' }));
    (bridge.dialPeerInvite as any).mockResolvedValueOnce({
      isConnected: true,
      request: requestSpy,
      requestStream: vi.fn(async () => ({ done: true })),
      close: vi.fn(async () => undefined),
    } as any);
    const service = createRelayPeerAgentService({ bridge, accountId: 'default' });

    await expect(service.requestPeer('peer-key', 'system.status', {}, { clientId: 'peer-client-auto' })).resolves.toEqual({ ok: true, version: 'remote' });
    expect(bridge.sendPeerSignal).toHaveBeenCalledWith(
      'peer-key',
      { version: 1, kind: 'invite_request', body: {} },
      { accountId: 'default' },
    );
    expect(bridge.dialPeerInvite).toHaveBeenCalledWith('invite-token', 'peer-key', expect.objectContaining({ accountId: 'default', clientId: 'peer-client-auto' }));
    expect(requestSpy).toHaveBeenCalledWith('system.status', {}, undefined);
  });

  it('redials once when a live peer session drops during request', async () => {
    const bridge = createBridge();
    (bridge.drainPeerSignals as any)
      .mockReturnValueOnce([
        signal('peer-key', 'invite_offer', {
          invite_token: 'invite-token-1',
          expires_at: '2026-03-09T00:05:00.000Z',
          peer_authorized_until: '2026-03-09T00:05:00.000Z',
        }),
      ])
      .mockReturnValueOnce([
        signal('peer-key', 'invite_offer', {
          invite_token: 'invite-token-2',
          expires_at: '2026-03-09T00:06:00.000Z',
          peer_authorized_until: '2026-03-09T00:06:00.000Z',
        }),
      ])
      .mockReturnValue([]);
    const firstRequest = vi.fn(async () => { throw new Error('peer relay websocket closed'); });
    const secondRequest = vi.fn(async () => ({ ok: true, version: 'redialed' }));
    const closeSpy = vi.fn(async () => undefined);
    (bridge.dialPeerInvite as any)
      .mockResolvedValueOnce({
        isConnected: true,
        request: firstRequest,
        requestStream: vi.fn(async () => ({ done: true })),
        close: closeSpy,
      } as any)
      .mockResolvedValueOnce({
        isConnected: true,
        request: secondRequest,
        requestStream: vi.fn(async () => ({ done: true })),
        close: vi.fn(async () => undefined),
      } as any);
    const service = createRelayPeerAgentService({ bridge, accountId: 'default' });

    await expect(service.requestPeer('peer-key', 'system.status', {}, { clientId: 'peer-client-redial' })).resolves.toEqual({ ok: true, version: 'redialed' });
    expect(bridge.dialPeerInvite).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(service.listPeerSessionStatuses()).toMatchObject([
      { peerPublicKey: 'peer-key', connected: true, lastClientId: 'peer-client-redial' },
    ]);
  });

  it('removes a connected peer immediately when the session closes later', async () => {
    const bridge = createBridge();
    let onClosed: ((error?: Error) => void) | undefined;
    (bridge.dialPeerInvite as any).mockImplementationOnce(async (_inviteToken, _peerKey, options) => {
      onClosed = options?.onClosed;
      return {
        isConnected: true,
        request: vi.fn(async () => ({ ok: true })),
        requestStream: vi.fn(async () => ({ done: true })),
        close: vi.fn(async () => undefined),
      } as any;
    });
    const service = createRelayPeerAgentService({ bridge, accountId: 'default' });
    const offerSignal = signal('peer-key', 'invite_offer', {
      invite_token: 'invite-token',
      expires_at: '2026-03-09T00:05:00.000Z',
      peer_authorized_until: '2026-03-09T00:05:00.000Z',
    });

    await service.connectFromInviteOffer(offerSignal, { clientId: 'peer-client-live' });
    expect(service.listConnectedPeers()).toEqual(['peer-key']);
    onClosed?.(new Error('peer session closed'));
    expect(service.listConnectedPeers()).toEqual([]);
    expect(service.listPeerSessionStatuses()).toMatchObject([
      { peerPublicKey: 'peer-key', connected: false, lastError: 'peer session closed' },
    ]);
  });
});
