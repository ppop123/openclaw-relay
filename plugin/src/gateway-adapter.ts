import { deriveChannelHash, inspectAccount, validateAccountConfig } from './config.js';
import { MethodNotFoundError, dispatchRequest } from './dispatch.js';
import { InvalidParamsError, Layer2ResponseError, RelayFatalError, UnsupportedRuntimeMethodError } from './errors.js';
import { fingerprintFromPublicKeyBase64, GatewayIdentity, importGatewayIdentity } from './crypto.js';
import { RelayOutbound } from './outbound.js';
import { PairingManager, approveClient } from './pairing.js';
import { PeerDiscoveryService } from './peer-discovery.js';
import { RelayPeerSession } from './outbound-peer-session.js';
import { RelayConnection } from './relay-connection.js';
import { GatewayTransport, GatewaySession } from './transport.js';
import {
  CancelMessage,
  ConnectionState,
  DataFrame,
  ErrorFrame,
  GatewayStatus,
  PeerSignalEnvelope,
  ReceivedPeerSignal,
  RelayAccountConfig,
  RelayConfigStore,
  RelayFrame,
  RelayRequestContext,
  RelayRuntimeAdapter,
  RelayStreamResult,
  RequestMessage,
  SignalErrorFrame,
  WebSocketFactory,
} from './types.js';

interface PendingExecution {
  clientId: string;
  abortController: AbortController;
  cancelled: boolean;
  terminalSent: boolean;
}

export interface RelayGatewayAdapterOptions {
  accountId?: string;
  configStore: RelayConfigStore;
  runtime: RelayRuntimeAdapter;
  webSocketFactory?: WebSocketFactory;
  pairingManager?: PairingManager;
  maxConcurrentPerClient?: number;
  maxConcurrentGlobal?: number;
}

function isDataFrame(frame: RelayFrame): frame is DataFrame {
  return frame.type === 'data' && typeof (frame as DataFrame).to === 'string' && typeof (frame as DataFrame).payload === 'string';
}

function isStreamResult(value: Record<string, unknown> | RelayStreamResult): value is RelayStreamResult {
  return 'stream' in value && 'final' in value;
}

export class RelayGatewayAdapter {
  readonly accountId: string;
  readonly pairingManager: PairingManager;
  private currentConfig: RelayAccountConfig | undefined;
  private identity: GatewayIdentity | undefined;
  private connection: RelayConnection | undefined;
  private transport: GatewayTransport | undefined;
  private outbound: RelayOutbound | undefined;
  private peerDiscovery: PeerDiscoveryService | undefined;
  private lastFatalErrorCode: string | undefined;
  private connectionState: ConnectionState = 'disconnected';
  private readonly pendingRequests = new Map<string, PendingExecution>();
  private readonly pendingPeerApprovals = new Map<string, { publicKey: string; expiresAt: number; remainingUses: number }>();
  private channelHash: string | undefined;

  constructor(private readonly options: RelayGatewayAdapterOptions) {
    this.accountId = options.accountId ?? 'default';
    this.pairingManager = options.pairingManager ?? new PairingManager();
  }

  async start(options: { waitForRegistered?: boolean } = {}): Promise<void> {
    const config = await this.options.configStore.load(this.accountId);
    if (!config) throw new Error(`account '${this.accountId}' not found`);
    validateAccountConfig(config);
    if (!config.enabled) throw new Error(`account '${this.accountId}' is disabled`);
    this.currentConfig = config;
    this.channelHash = await deriveChannelHash(config.channelToken);

    const identity = await importGatewayIdentity(config.gatewayKeyPair);
    this.identity = identity;

    this.peerDiscovery = new PeerDiscoveryService({
      identity,
      discoveryConfig: () => this.currentConfig?.peerDiscovery,
      capabilities: () => this.computeCapabilities(),
      sendFrame: async (frame) => {
        if (!this.connection) throw new Error('relay connection not initialized');
        await this.connection.send(frame);
      },
    });

    this.transport = new GatewayTransport({
      accountId: this.accountId,
      identity,
      accountConfig: () => {
        if (!this.currentConfig) throw new Error('config not loaded');
        return this.currentConfig;
      },
      pairingActive: () => this.pairingManager.isActive(),
      endPairing: () => this.pairingManager.end(),
      capabilities: () => this.computeCapabilities(),
      sendFrame: async (frame) => {
        if (!this.connection) throw new Error('relay connection not initialized');
        await this.connection.send(frame);
      },
      approveUnknownClient: async (publicKey, clientId) => {
        const fingerprint = await approveClient(this.options.configStore, this.accountId, publicKey, clientId);
        this.currentConfig = await this.options.configStore.load(this.accountId);
        return fingerprint;
      },
      authorizePeerClient: async (publicKey, _clientId, fingerprint) => {
        const approval = this.pendingPeerApprovals.get(fingerprint);
        if (!approval) return false;
        if (approval.publicKey !== publicKey || approval.expiresAt <= Date.now() || approval.remainingUses <= 0) {
          this.pendingPeerApprovals.delete(fingerprint);
          return false;
        }
        approval.remainingUses -= 1;
        if (approval.remainingUses <= 0) {
          this.pendingPeerApprovals.delete(fingerprint);
        } else {
          this.pendingPeerApprovals.set(fingerprint, approval);
        }
        return true;
      },
      touchApprovedClient: async (fingerprint, clientId) => {
        const current = this.currentConfig;
        if (!current) return;
        const record = current.approvedClients[fingerprint];
        if (!record) return;
        const next: RelayAccountConfig = {
          ...current,
          approvedClients: {
            ...current.approvedClients,
            [fingerprint]: {
              ...record,
              lastSeenClientId: clientId,
              lastSeenAt: new Date().toISOString(),
            },
          },
        };
        this.currentConfig = next;
      },
      onRequest: async (session, message) => {
        await this.handleRequest(session, message);
      },
      onCancel: async (session, message) => {
        await this.handleCancel(session, message);
      },
      onSessionEnded: async (session) => {
        await this.failPendingForClient(session.clientId);
      },
    });

    this.outbound = new RelayOutbound(this.transport);

    this.connection = new RelayConnection({
      url: config.server,
      channel: this.channelHash,
      registerFields: this.peerDiscovery.getRegisterFields(),
      onStateChange: (state) => {
        this.connectionState = state;
        this.peerDiscovery?.handleConnectionState(state);
      },
      onRegistered: () => {
        this.lastFatalErrorCode = undefined;
      },
      onErrorFrame: async (frame) => {
        await this.handleErrorFrame(frame);
      },
      onFrame: async (frame) => {
        if (this.peerDiscovery && await this.peerDiscovery.handleFrame(frame)) {
          return;
        }
        if (frame.type === 'presence' && frame.role === 'client' && frame.status === 'offline' && typeof frame.client_id === 'string') {
          await this.transport?.handlePresenceOffline(frame.client_id);
          return;
        }
        if (isDataFrame(frame)) {
          try {
            await this.transport?.handleDataFrame(frame);
          } catch {
            // Per protocol, decryption and parse failures are dropped silently.
          }
        }
      },
      ...(this.options.webSocketFactory ? { webSocketFactory: this.options.webSocketFactory } : {}),
    });

    await this.connection.start(options.waitForRegistered ?? true);
  }

  async waitForReady(timeoutMs = 10000): Promise<GatewayStatus> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = await this.getStatus();
      if (status.state === 'registered') {
        return status;
      }
      if (status.lastFatalErrorCode) {
        throw new Error(`relay connection fatal: ${status.lastFatalErrorCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const status = await this.getStatus();
    throw new Error(`relay gateway not ready after ${timeoutMs}ms (state=${status.state})`);
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingRequests.values()) {
      pending.cancelled = true;
      pending.abortController.abort();
    }
    this.pendingRequests.clear();
    if (this.connection) {
      await this.connection.stop();
    }
    this.connection = undefined;
    this.transport = undefined;
    this.outbound = undefined;
    this.peerDiscovery = undefined;
    this.identity = undefined;
    this.pendingPeerApprovals.clear();
    this.connectionState = 'disconnected';
  }

  async beginPairing(): Promise<void> {
    this.pairingManager.begin();
  }

  async discoverPeers(timeoutMs = 10000) {
    if (!this.peerDiscovery) throw new Error('peer discovery is not initialized');
    await this.waitForReady(timeoutMs);
    return this.peerDiscovery.discoverPeers(timeoutMs);
  }

  async sendPeerSignal(targetPublicKey: string, envelope: PeerSignalEnvelope): Promise<void> {
    if (!this.peerDiscovery) throw new Error('peer discovery is not initialized');
    await this.waitForReady();
    await this.peerDiscovery.sendSignal(targetPublicKey, envelope);
  }

  async createPeerInvite(ttlSeconds = 300): Promise<{ inviteToken: string; inviteHash: string; expiresAt: string }> {
    if (!this.peerDiscovery) throw new Error('peer discovery is not initialized');
    await this.waitForReady();
    return this.peerDiscovery.createInvite(ttlSeconds);
  }

  async dialPeerInvite(inviteToken: string, gatewayPublicKey: string, clientId?: string, onClosed?: (error?: Error) => void): Promise<RelayPeerSession> {
    if (!this.currentConfig) throw new Error('gateway adapter is not started');
    if (!this.identity) throw new Error('gateway identity is not initialized');
    await this.waitForReady();
    const session = new RelayPeerSession({
      relayUrl: this.currentConfig.server,
      inviteToken,
      gatewayPublicKey,
      identity: this.identity,
      ...(clientId ? { clientId } : {}),
      ...(this.options.webSocketFactory ? { webSocketFactory: this.options.webSocketFactory } : {}),
      ...(onClosed ? { onClosed } : {}),
    });
    await session.connect();
    return session;
  }

  async authorizePeerPublicKey(publicKey: string, ttlSeconds = 300, maxUses = 1): Promise<{ fingerprint: string; expiresAt: string }> {
    const ttlMs = Math.max(1, Math.floor(ttlSeconds * 1000));
    const uses = Math.max(1, Math.floor(maxUses));
    const fingerprint = await fingerprintFromPublicKeyBase64(publicKey);
    const expiresAtMs = Date.now() + ttlMs;
    this.pendingPeerApprovals.set(fingerprint, {
      publicKey,
      expiresAt: expiresAtMs,
      remainingUses: uses,
    });
    return {
      fingerprint,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  drainPeerSignals(): ReceivedPeerSignal[] {
    return this.peerDiscovery?.drainSignals() ?? [];
  }

  drainPeerSignalErrors(): SignalErrorFrame[] {
    return this.peerDiscovery?.drainSignalErrors() ?? [];
  }

  async disconnectFingerprint(fingerprint: string, reason = 'revoked'): Promise<void> {
    await this.transport?.endSessionsByFingerprint(fingerprint, reason);
  }

  async getStatus(): Promise<GatewayStatus> {
    const approvedClients = Object.keys(this.currentConfig?.approvedClients ?? {}).length;
    const activeSessions = this.transport?.sessionCount ?? 0;
    const channel = this.currentConfig ? await deriveChannelHash(this.currentConfig.channelToken) : undefined;
    const base = this.connection?.getStatusBase();
    return {
      state: this.connectionState,
      health: this.computeHealth(),
      approvedClients,
      activeSessions,
      peerDiscovery: {
        enabled: this.currentConfig?.peerDiscovery?.enabled === true,
        ...(this.currentConfig?.peerDiscovery?.enabled ? { publicKey: this.currentConfig.gatewayKeyPair.publicKey } : {}),
        pendingSignals: this.peerDiscovery?.pendingSignalCount ?? 0,
        pendingSignalErrors: this.peerDiscovery?.pendingSignalErrorCount ?? 0,
      },
      ...(this.currentConfig?.server ? { server: this.currentConfig.server } : {}),
      ...(channel ? { channel } : {}),
      ...(base?.lastRegisteredAt ? { lastRegisteredAt: base.lastRegisteredAt } : {}),
      ...(this.lastFatalErrorCode ?? base?.lastFatalErrorCode ? { lastFatalErrorCode: this.lastFatalErrorCode ?? base?.lastFatalErrorCode! } : {}),
    };
  }

  async inspectAccount() {
    if (!this.currentConfig) return this.options.configStore.inspectAccount(this.accountId);
    return inspectAccount(this.currentConfig);
  }

  private computeCapabilities(): string[] {
    const capabilities = new Set<string>();
    if (this.options.runtime.chatSend) {
      capabilities.add('chat');
      capabilities.add('stream');
    }
    if (this.options.runtime.agentsList || this.options.runtime.agentsInfo) {
      capabilities.add('agents');
    }
    if (this.options.runtime.sessionsList || this.options.runtime.sessionsHistory) {
      capabilities.add('sessions');
    }
    if (this.options.runtime.cronList || this.options.runtime.cronToggle) {
      capabilities.add('cron');
    }
    if (this.options.runtime.systemStatus) {
      capabilities.add('system');
    }
    return [...capabilities].sort();
  }

  private computeHealth(): GatewayStatus['health'] {
    if (this.lastFatalErrorCode) return 'unhealthy';
    if (this.connectionState === 'registered') return 'healthy';
    if (this.connectionState === 'connecting' || this.connectionState === 'reconnecting') return 'degraded';
    return this.currentConfig ? 'degraded' : 'unhealthy';
  }

  private countPendingForClient(clientId: string): number {
    let count = 0;
    for (const pending of this.pendingRequests.values()) {
      if (pending.clientId === clientId && !pending.cancelled) count += 1;
    }
    return count;
  }

  private async handleRequest(session: GatewaySession, message: RequestMessage): Promise<void> {
    if (!this.outbound) throw new Error('outbound not initialized');

    const maxPerClient = this.options.maxConcurrentPerClient ?? 4;
    const maxGlobal = this.options.maxConcurrentGlobal ?? 16;
    if (this.countPendingForClient(session.clientId) >= maxPerClient || this.pendingRequests.size >= maxGlobal) {
      await this.outbound.sendError(session.clientId, message.id, 'rate_limited', 'gateway request limit reached');
      return;
    }

    const pending: PendingExecution = {
      clientId: session.clientId,
      abortController: new AbortController(),
      cancelled: false,
      terminalSent: false,
    };
    this.pendingRequests.set(message.id, pending);

    const ctx: RelayRequestContext = {
      accountId: this.accountId,
      clientId: session.clientId,
      fingerprint: session.fingerprint,
      signal: pending.abortController.signal,
    };

    try {
      const result = await dispatchRequest(this.options.runtime, message, ctx);
      if (this.isCancelled(message.id)) return;

      if (isStreamResult(result)) {
        await this.outbound.sendStreamStart(session.clientId, message.id, message.method);
        let seq = 1;
        for await (const chunk of result.stream) {
          if (this.isCancelled(message.id)) return;
          await this.outbound.sendStreamChunk(session.clientId, message.id, seq, chunk);
          seq += 1;
        }
        if (this.isCancelled(message.id)) return;
        await this.outbound.sendStreamEnd(session.clientId, message.id, seq);
        await this.outbound.sendResponse(session.clientId, message.id, await Promise.resolve(result.final));
      } else {
        await this.outbound.sendResponse(session.clientId, message.id, result);
      }
      pending.terminalSent = true;
    } catch (error) {
      if (this.isCancelled(message.id)) return;
      const { code, text } = this.mapError(error);
      await this.outbound.sendError(session.clientId, message.id, code, text);
      pending.terminalSent = true;
    } finally {
      this.pendingRequests.delete(message.id);
    }
  }

  private async handleCancel(session: GatewaySession, message: CancelMessage): Promise<void> {
    const pending = this.pendingRequests.get(message.id);
    if (!pending || pending.clientId !== session.clientId) {
      return;
    }
    pending.cancelled = true;
    pending.abortController.abort();
    if (!pending.terminalSent) {
      await this.outbound?.sendError(session.clientId, message.id, 'cancelled', 'request cancelled');
      pending.terminalSent = true;
    }
  }

  private async failPendingForClient(clientId: string): Promise<void> {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.clientId !== clientId) continue;
      pending.cancelled = true;
      pending.abortController.abort();
      this.pendingRequests.delete(requestId);
    }
  }

  private isCancelled(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    return !pending || pending.cancelled;
  }

  private async handleErrorFrame(frame: ErrorFrame): Promise<void> {
    switch (frame.code) {
      case 'channel_occupied':
      case 'channel_limit_reached':
        this.lastFatalErrorCode = frame.code;
        break;
      case 'rate_limited':
      case 'payload_too_large':
      case 'invalid_frame':
      case 'channel_full':
      case 'public_key_required':
      case 'invalid_public_key':
      case 'metadata_too_large':
      case 'gateway_only':
      case 'not_discoverable':
      case 'peer_offline':
      case 'invite_limit_reached':
      case 'invite_invalid':
      default:
        break;
    }
  }

  private mapError(error: unknown): { code: string; text: string } {
    if (error instanceof MethodNotFoundError) {
      return { code: 'method_not_found', text: error.message };
    }
    if (error instanceof RelayFatalError) {
      return { code: 'internal_error', text: error.message };
    }
    if (error instanceof Layer2ResponseError) {
      return { code: error.code, text: error.message };
    }
    if (error instanceof InvalidParamsError) {
      return { code: 'invalid_params', text: error.message };
    }
    if (error instanceof UnsupportedRuntimeMethodError) {
      return { code: 'method_not_found', text: error.message };
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { code: 'cancelled', text: 'request cancelled' };
    }
    if (error instanceof Error) {
      return { code: 'internal_error', text: error.message };
    }
    return { code: 'internal_error', text: 'unexpected gateway error' };
  }
}
