import { RelayPeerSession } from './outbound-peer-session.js';
import { RelayAgentAcceptPeerOptions, RelayAgentBridge, RelayAgentBridgeStartOptions } from './openclaw-host.js';
import { DiscoveryPeer, ReceivedPeerSignal, SignalErrorFrame } from './types.js';

const INVITE_REQUEST_KIND = 'invite_request';
const INVITE_OFFER_KIND = 'invite_offer';
const INVITE_REJECT_KIND = 'invite_reject';
const DEFAULT_SIGNAL_WAIT_TIMEOUT_MS = 15000;
const DEFAULT_SIGNAL_POLL_INTERVAL_MS = 250;
const REDIAL_BACKOFF_MS = 1000;

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

export interface RelayPeerRequestOptions extends RelayPeerDialOptions {
  autoDial?: boolean;
  requestTimeoutMs?: number;
}

export interface RelayPeerDialResult {
  peerPublicKey: string;
  connected: true;
  reusedSession: boolean;
  offer?: RelayPeerInviteOffer;
}

export interface RelayPeerSessionStatus {
  peerPublicKey: string;
  connected: boolean;
  canAutoDial: boolean;
  lastClientId?: string;
  lastDialStartedAt?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
  offer?: RelayPeerInviteOffer;
}

interface RelayPeerRecord {
  session: RelayPeerSession | undefined;
  dialPromise: Promise<RelayPeerDialResult> | undefined;
  lastClientId: string | undefined;
  lastDialStartedAt: string | undefined;
  lastConnectedAt: string | undefined;
  lastDisconnectedAt: string | undefined;
  lastError: string | undefined;
  offer: RelayPeerInviteOffer | undefined;
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

function shouldRetryWithRedial(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || String(error);
  return (
    message.includes('no active peer session')
    || message.includes('peer session is not connected')
    || message.includes('peer relay websocket closed')
    || message.includes('peer relay websocket error')
    || message.includes('peer session ping failed')
    || message.includes('peer session pong timeout')
  );
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
  private readonly peerRecords = new Map<string, RelayPeerRecord>();
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

  private getOrCreatePeerRecord(peerPublicKey: string): RelayPeerRecord {
    const existing = this.peerRecords.get(peerPublicKey);
    if (existing) return existing;
    const created: RelayPeerRecord = { session: undefined, dialPromise: undefined, lastClientId: undefined, lastDialStartedAt: undefined, lastConnectedAt: undefined, lastDisconnectedAt: undefined, lastError: undefined, offer: undefined };
    this.peerRecords.set(peerPublicKey, created);
    return created;
  }

  private markPeerDisconnected(peerPublicKey: string, error?: Error): void {
    const record = this.getOrCreatePeerRecord(peerPublicKey);
    record.session = undefined;
    record.lastDisconnectedAt = new Date().toISOString();
    if (error?.message) {
      record.lastError = error.message;
    }
  }

  private markPeerConnected(peerPublicKey: string, session: RelayPeerSession, options: { clientId?: string; offer?: RelayPeerInviteOffer }): void {
    const record = this.getOrCreatePeerRecord(peerPublicKey);
    record.session = session;
    record.lastConnectedAt = new Date().toISOString();
    record.lastError = undefined;
    if (options.clientId) {
      record.lastClientId = options.clientId;
    }
    if (options.offer) {
      record.offer = options.offer;
    }
  }

  private markPeerDialStarted(peerPublicKey: string, clientId?: string): void {
    const record = this.getOrCreatePeerRecord(peerPublicKey);
    record.lastDialStartedAt = new Date().toISOString();
    if (clientId) {
      record.lastClientId = clientId;
    }
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

  restoreSignals(signals: ReceivedPeerSignal[]): void {
    this.deferSignals(signals);
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
    const offer = RelayPeerAgentService.parseInviteOffer(signal);
    await this.closePeerSession(signal.source).catch(() => undefined);
    const sessionRef: { current?: RelayPeerSession } = {};
    const session = await this.options.bridge.dialPeerInvite(body.invite_token, signal.source, {
      ...asSignalOptions(this.accountId),
      ...options,
      onClosed: (error) => {
        const current = this.peerRecords.get(signal.source)?.session;
        if (!current || !sessionRef.current || current === sessionRef.current) {
          this.markPeerDisconnected(signal.source, error);
        }
      },
    });
    sessionRef.current = session;
    this.markPeerConnected(signal.source, session, { ...(options.clientId ? { clientId: options.clientId } : {}), offer });
    return session;
  }

  private getUsableSession(peerPublicKey: string): RelayPeerSession | undefined {
    const session = this.peerRecords.get(peerPublicKey)?.session;
    if (!session) return undefined;
    if (session.isConnected) return session;
    this.markPeerDisconnected(peerPublicKey);
    return undefined;
  }

  private async ensurePeerSession(peerPublicKey: string, options: RelayPeerRequestOptions = {}): Promise<RelayPeerSession> {
    const existing = this.getUsableSession(peerPublicKey);
    if (existing) {
      return existing;
    }
    if (options.autoDial === false) {
      throw new Error(`no active peer session for ${peerPublicKey}`);
    }
    await this.requestPeerConnection(peerPublicKey, options);
    const redialed = this.getUsableSession(peerPublicKey);
    if (!redialed) {
      throw new Error(`failed to establish peer session for ${peerPublicKey}`);
    }
    return redialed;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async requestPeerConnection(peerPublicKey: string, options: RelayPeerDialOptions = {}): Promise<RelayPeerDialResult> {
    if (this.getUsableSession(peerPublicKey)) {
      return {
        peerPublicKey,
        connected: true as const,
        reusedSession: true,
      };
    }
    const record = this.getOrCreatePeerRecord(peerPublicKey);
    if (record.dialPromise) {
      return record.dialPromise;
    }
    const dialPromise: Promise<RelayPeerDialResult> = (async (): Promise<RelayPeerDialResult> => {
      this.markPeerDialStarted(peerPublicKey, options.clientId);
      await this.ensureStarted();
      await this.requestPeerInvite(peerPublicKey, options.body ?? {});
      const signal = await this.waitForPeerSignal(
        peerPublicKey,
        (candidate) => isInviteOfferSignal(candidate) || isInviteRejectSignal(candidate),
        options,
      );
      if (isInviteRejectSignal(signal)) {
        const rejected = RelayPeerAgentService.parseInviteReject(signal);
        const error = new Error(rejected.reason ? `peer rejected invite request: ${rejected.reason}` : 'peer rejected invite request');
        this.markPeerDisconnected(peerPublicKey, error);
        throw error;
      }
      const offer = RelayPeerAgentService.parseInviteOffer(signal);
      await this.connectFromInviteOffer(signal, {
        ...asSignalOptions(this.accountId),
        ...(options.clientId ? { clientId: options.clientId } : {}),
      });
      return {
        peerPublicKey,
        connected: true as const,
        reusedSession: false,
        offer,
      };
    })();
    record.dialPromise = dialPromise;
    try {
      return await dialPromise;
    } finally {
      if (record.dialPromise === dialPromise) {
        record.dialPromise = undefined;
      }
    }
  }

  getPeerSession(peerPublicKey: string): RelayPeerSession | undefined {
    return this.getUsableSession(peerPublicKey);
  }

  listPeerSessionStatuses(): RelayPeerSessionStatus[] {
    const statuses: RelayPeerSessionStatus[] = [];
    for (const peerPublicKey of [...this.peerRecords.keys()].sort()) {
      const record = this.getOrCreatePeerRecord(peerPublicKey);
      const connected = Boolean(record.session?.isConnected);
      if (!connected && record.session) {
        this.markPeerDisconnected(peerPublicKey);
      }
      statuses.push({
        peerPublicKey,
        connected: Boolean(this.peerRecords.get(peerPublicKey)?.session?.isConnected),
        canAutoDial: true,
        ...(record.lastClientId ? { lastClientId: record.lastClientId } : {}),
        ...(record.lastDialStartedAt ? { lastDialStartedAt: record.lastDialStartedAt } : {}),
        ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
        ...(record.lastDisconnectedAt ? { lastDisconnectedAt: record.lastDisconnectedAt } : {}),
        ...(record.lastError ? { lastError: record.lastError } : {}),
        ...(record.offer ? { offer: structuredClone(record.offer) } : {}),
      });
    }
    return statuses;
  }

  listConnectedPeers(): string[] {
    return this.listPeerSessionStatuses()
      .filter((entry) => entry.connected)
      .map((entry) => entry.peerPublicKey);
  }

  async closePeerSession(peerPublicKey: string): Promise<void> {
    const record = this.peerRecords.get(peerPublicKey);
    const session = record?.session;
    if (!session) return;
    record!.session = undefined;
    record!.lastDisconnectedAt = new Date().toISOString();
    await session.close();
  }

  async closeAllPeerSessions(): Promise<void> {
    for (const peerPublicKey of this.listPeerSessionStatuses().map((entry) => entry.peerPublicKey)) {
      await this.closePeerSession(peerPublicKey);
    }
  }

  async requestPeer(peerPublicKey: string, method: string, params: Record<string, unknown>, options: RelayPeerRequestOptions = {}): Promise<Record<string, unknown>> {
    let session = await this.ensurePeerSession(peerPublicKey, options);
    try {
      return await session.request(method, params, options.requestTimeoutMs);
    } catch (error) {
      if (!shouldRetryWithRedial(error) || options.autoDial === false) {
        this.markPeerDisconnected(peerPublicKey, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      await this.closePeerSession(peerPublicKey).catch(() => undefined);
      await this.delay(REDIAL_BACKOFF_MS);
      session = await this.ensurePeerSession(peerPublicKey, options);
      return session.request(method, params, options.requestTimeoutMs);
    }
  }

  async requestPeerStream(
    peerPublicKey: string,
    method: string,
    params: Record<string, unknown>,
    onChunk: (chunk: Record<string, unknown>) => Promise<void> | void,
    options: RelayPeerRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    let deliveredChunks = 0;
    const observedOnChunk = async (chunk: Record<string, unknown>) => {
      deliveredChunks += 1;
      await onChunk(chunk);
    };
    let session = await this.ensurePeerSession(peerPublicKey, options);
    try {
      return await session.requestStream(method, params, observedOnChunk, options.requestTimeoutMs);
    } catch (error) {
      if (deliveredChunks > 0 || !shouldRetryWithRedial(error) || options.autoDial === false) {
        this.markPeerDisconnected(peerPublicKey, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      await this.closePeerSession(peerPublicKey).catch(() => undefined);
      await this.delay(REDIAL_BACKOFF_MS);
      session = await this.ensurePeerSession(peerPublicKey, options);
      return session.requestStream(method, params, observedOnChunk, options.requestTimeoutMs);
    }
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
