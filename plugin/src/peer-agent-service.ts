import { RelayPeerSession } from './outbound-peer-session.js';
import { RelayAgentAcceptPeerOptions, RelayAgentBridge, RelayAgentBridgeStartOptions, RelayAgentInviteOptions } from './openclaw-host.js';
import { DiscoveryPeer, PeerSignalEnvelope, ReceivedPeerSignal, SignalErrorFrame } from './types.js';

const INVITE_REQUEST_KIND = 'invite_request';
const INVITE_OFFER_KIND = 'invite_offer';
const INVITE_REJECT_KIND = 'invite_reject';

export interface RelayPeerAgentServiceOptions {
  bridge: RelayAgentBridge;
  accountId?: string;
}

export interface RelayPeerSignalContext {
  signal: ReceivedPeerSignal;
  peerPublicKey: string;
}

export interface RelayPeerInviteOffer {
  inviteToken: string;
  expiresAt?: string;
  peerAuthorizedUntil?: string;
}

function asSignalOptions(accountId?: string): RelayAgentBridgeStartOptions {
  return accountId ? { accountId } : {};
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function isInviteRequestSignal(signal: ReceivedPeerSignal): boolean {
  return signal.envelope.version === 1 && signal.envelope.kind === INVITE_REQUEST_KIND;
}

export function isInviteOfferSignal(signal: ReceivedPeerSignal): boolean {
  return signal.envelope.version === 1 && signal.envelope.kind === INVITE_OFFER_KIND;
}

export function isInviteRejectSignal(signal: ReceivedPeerSignal): boolean {
  return signal.envelope.version === 1 && signal.envelope.kind === INVITE_REJECT_KIND;
}

export class RelayPeerAgentService {
  private readonly accountId: string | undefined;
  private readonly activeSessions = new Map<string, RelayPeerSession>();

  constructor(private readonly options: RelayPeerAgentServiceOptions) {
    this.accountId = options.accountId;
  }

  async ensureStarted(options: RelayAgentBridgeStartOptions = {}): Promise<void> {
    await this.options.bridge.ensureStarted({ ...asSignalOptions(this.accountId), ...options });
  }

  async discoverPeers(): Promise<DiscoveryPeer[]> {
    return this.options.bridge.discoverPeers(asSignalOptions(this.accountId));
  }

  async requestPeerInvite(targetPublicKey: string, body: Record<string, unknown> = {}): Promise<void> {
    await this.options.bridge.sendPeerSignal(
      targetPublicKey,
      { version: 1, kind: INVITE_REQUEST_KIND, body },
      asSignalOptions(this.accountId),
    );
  }

  async rejectPeerRequest(signal: ReceivedPeerSignal, reason: string, body: Record<string, unknown> = {}): Promise<void> {
    if (!isInviteRequestSignal(signal)) {
      throw new Error('incoming signal is not an invite_request');
    }
    await this.options.bridge.sendPeerSignal(
      signal.source,
      {
        version: 1,
        kind: INVITE_REJECT_KIND,
        body: {
          reason,
          ...body,
        },
      },
      asSignalOptions(this.accountId),
    );
  }

  async acceptPeerRequest(
    signal: ReceivedPeerSignal,
    options: RelayAgentAcceptPeerOptions = {},
    body: Record<string, unknown> = {},
  ): Promise<RelayPeerInviteOffer> {
    if (!isInviteRequestSignal(signal)) {
      throw new Error('incoming signal is not an invite_request');
    }
    const accepted = await this.options.bridge.acceptPeerSignal(signal.source, {
      ...asSignalOptions(this.accountId),
      ...options,
    });
    await this.options.bridge.sendPeerSignal(
      signal.source,
      {
        version: 1,
        kind: INVITE_OFFER_KIND,
        body: {
          invite_token: accepted.inviteToken,
          expires_at: accepted.expiresAt,
          peer_authorized_until: accepted.peerAuthorizedUntil,
          ...body,
        },
      },
      asSignalOptions(this.accountId),
    );
    return {
      inviteToken: accepted.inviteToken,
      expiresAt: accepted.expiresAt,
      peerAuthorizedUntil: accepted.peerAuthorizedUntil,
    };
  }

  drainSignals(): ReceivedPeerSignal[] {
    return this.options.bridge.drainPeerSignals(this.accountId);
  }

  drainSignalErrors(): SignalErrorFrame[] {
    return this.options.bridge.drainPeerSignalErrors(this.accountId);
  }

  async connectFromInviteOffer(signal: ReceivedPeerSignal, options: RelayAgentBridgeStartOptions & { clientId?: string } = {}): Promise<RelayPeerSession> {
    if (!isInviteOfferSignal(signal)) {
      throw new Error('incoming signal is not an invite_offer');
    }
    const body = requireObject(signal.envelope.body, 'invite_offer body');
    if (typeof body.invite_token !== 'string' || !body.invite_token) {
      throw new Error('invite_offer body.invite_token is required');
    }
    await this.closePeerSession(signal.source).catch(() => undefined);
    const session = await this.options.bridge.dialPeerInvite(body.invite_token, signal.source, {
      ...asSignalOptions(this.accountId),
      ...options,
    });
    this.activeSessions.set(signal.source, session);
    return session;
  }

  getPeerSession(peerPublicKey: string): RelayPeerSession | undefined {
    return this.activeSessions.get(peerPublicKey);
  }

  listConnectedPeers(): string[] {
    return [...this.activeSessions.keys()].sort();
  }

  async closePeerSession(peerPublicKey: string): Promise<void> {
    const session = this.activeSessions.get(peerPublicKey);
    if (!session) return;
    this.activeSessions.delete(peerPublicKey);
    await session.close();
  }

  async closeAllPeerSessions(): Promise<void> {
    for (const peerPublicKey of [...this.activeSessions.keys()]) {
      await this.closePeerSession(peerPublicKey);
    }
  }

  async requestPeer(peerPublicKey: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.activeSessions.get(peerPublicKey);
    if (!session) {
      throw new Error(`no active peer session for ${peerPublicKey}`);
    }
    return session.request(method, params);
  }

  async requestPeerStream(
    peerPublicKey: string,
    method: string,
    params: Record<string, unknown>,
    onChunk: (chunk: Record<string, unknown>) => Promise<void> | void,
  ): Promise<Record<string, unknown>> {
    const session = this.activeSessions.get(peerPublicKey);
    if (!session) {
      throw new Error(`no active peer session for ${peerPublicKey}`);
    }
    return session.requestStream(method, params, onChunk);
  }

  static parseInviteOffer(signal: ReceivedPeerSignal): RelayPeerInviteOffer {
    if (!isInviteOfferSignal(signal)) {
      throw new Error('incoming signal is not an invite_offer');
    }
    const body = requireObject(signal.envelope.body, 'invite_offer body');
    if (typeof body.invite_token !== 'string' || !body.invite_token) {
      throw new Error('invite_offer body.invite_token is required');
    }
    return {
      inviteToken: body.invite_token,
      ...(typeof body.expires_at === 'string' ? { expiresAt: body.expires_at } : {}),
      ...(typeof body.peer_authorized_until === 'string' ? { peerAuthorizedUntil: body.peer_authorized_until } : {}),
    };
  }

  static parseInviteReject(signal: ReceivedPeerSignal): { reason?: string; body: Record<string, unknown> } {
    if (!isInviteRejectSignal(signal)) {
      throw new Error('incoming signal is not an invite_reject');
    }
    const body = signal.envelope.body ? requireObject(signal.envelope.body, 'invite_reject body') : {};
    return {
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      body,
    };
  }
}

export function createRelayPeerAgentService(options: RelayPeerAgentServiceOptions): RelayPeerAgentService {
  return new RelayPeerAgentService(options);
}
