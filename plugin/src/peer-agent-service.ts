import { RelayPeerSession } from './outbound-peer-session.js';
import { RelayAgentAcceptPeerOptions, RelayAgentBridge, RelayAgentBridgeStartOptions, RelayAgentInviteOptions } from './openclaw-host.js';
import { DiscoveryPeer, PeerSignalEnvelope, ReceivedPeerSignal, SignalErrorFrame } from './types.js';

const INVITE_REQUEST_KIND = 'invite_request';
const INVITE_OFFER_KIND = 'invite_offer';
const INVITE_REJECT_KIND = 'invite_reject';
const DEFAULT_SIGNAL_WAIT_TIMEOUT_MS = 15000;
const DEFAULT_SIGNAL_POLL_INTERVAL_MS = 250;

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

export interface RelayPeerDialOptions {
  body?: Record<string, unknown>;
  clientId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RelayPeerDialResult {
  peerPublicKey: string;
  connected: true;
  reusedSession: boolean;
  offer?: RelayPeerInviteOffer;
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
  private readonly deferredSignals: ReceivedPeerSignal[] = [];

  constructor(private readonly options: RelayPeerAgentServiceOptions) {
    this.accountId = options.accountId;
  }

  async ensureStarted(options: RelayAgentBridgeStartOptions = {}): Promise<void> {
    await this.options.bridge.ensureStarted({ ...asSignalOptions(this.accountId), ...options });
  }

  async discoverPeers(timeoutMs?: number): Promise<DiscoveryPeer[]> {
    return this.options.bridge.discoverPeers({
      ...asSignalOptions(this.accountId),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
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

  private collectSignals(): ReceivedPeerSignal[] {
    const liveSignals = this.options.bridge.drainPeerSignals(this.accountId);
    if (this.deferredSignals.length === 0) {
      return liveSignals;
    }
    const merged = [...this.deferredSignals, ...liveSignals];
    this.deferredSignals.length = 0;
    return merged;
  }

  private deferSignals(signals: ReceivedPeerSignal[]): void {
    if (signals.length === 0) return;
    this.deferredSignals.push(...signals);
  }

  private async waitForPeerSignal(
    peerPublicKey: string,
    matcher: (signal: ReceivedPeerSignal) => boolean,
    options: RelayPeerDialOptions = {},
  ): Promise<ReceivedPeerSignal> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SIGNAL_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SIGNAL_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const drained = this.collectSignals();
      const deferred: ReceivedPeerSignal[] = [];
      for (const signal of drained) {
        if (signal.source === peerPublicKey && matcher(signal)) {
          this.deferSignals(deferred);
          return signal;
        }
        deferred.push(signal);
      }
      this.deferSignals(deferred);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }
    throw new Error(`timed out waiting ${timeoutMs}ms for peer signal from ${peerPublicKey}`);
  }

  drainSignals(): ReceivedPeerSignal[] {
    return this.collectSignals();
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
      onClosed: () => {
        const current = this.activeSessions.get(signal.source);
        if (current === session) {
          this.activeSessions.delete(signal.source);
        }
      },
    });
    this.activeSessions.set(signal.source, session);
    return session;
  }

  private getUsableSession(peerPublicKey: string): RelayPeerSession | undefined {
    const session = this.activeSessions.get(peerPublicKey);
    if (!session) return undefined;
    if (session.isConnected) return session;
    this.activeSessions.delete(peerPublicKey);
    return undefined;
  }

  async requestPeerConnection(peerPublicKey: string, options: RelayPeerDialOptions = {}): Promise<RelayPeerDialResult> {
    if (this.getUsableSession(peerPublicKey)) {
      return {
        peerPublicKey,
        connected: true,
        reusedSession: true,
      };
    }
    await this.ensureStarted();
    await this.requestPeerInvite(peerPublicKey, options.body ?? {});
    const signal = await this.waitForPeerSignal(
      peerPublicKey,
      (candidate) => isInviteOfferSignal(candidate) || isInviteRejectSignal(candidate),
      options,
    );
    if (isInviteRejectSignal(signal)) {
      const rejected = RelayPeerAgentService.parseInviteReject(signal);
      throw new Error(rejected.reason ? `peer rejected invite request: ${rejected.reason}` : 'peer rejected invite request');
    }
    const offer = RelayPeerAgentService.parseInviteOffer(signal);
    await this.connectFromInviteOffer(signal, {
      ...asSignalOptions(this.accountId),
      ...(options.clientId ? { clientId: options.clientId } : {}),
    });
    return {
      peerPublicKey,
      connected: true,
      reusedSession: false,
      offer,
    };
  }

  getPeerSession(peerPublicKey: string): RelayPeerSession | undefined {
    return this.getUsableSession(peerPublicKey);
  }

  listConnectedPeers(): string[] {
    for (const peerPublicKey of [...this.activeSessions.keys()]) {
      this.getUsableSession(peerPublicKey);
    }
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
    const session = this.getUsableSession(peerPublicKey);
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
    const session = this.getUsableSession(peerPublicKey);
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
