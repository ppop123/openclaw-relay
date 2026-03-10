export type ConnectionState = 'disconnected' | 'connecting' | 'registered' | 'reconnecting';
export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface GatewayKeyPairConfig {
  privateKey: string;
  publicKey: string;
}

export interface ApprovedClientRecord {
  publicKey: string;
  label?: string;
  firstPairedAt: string;
  lastSeenClientId?: string;
  lastSeenAt?: string;
}

export interface PeerDiscoveryAutoAcceptConfig {
  enabled: boolean;
  ttlSeconds?: number;
  maxUses?: number;
}

export interface PeerDiscoveryConfig {
  enabled: boolean;
  metadata?: Record<string, unknown>;
  autoAcceptRequests?: PeerDiscoveryAutoAcceptConfig;
}

export interface RelayAccountConfig {
  enabled: boolean;
  server: string;
  channelToken: string;
  /**
   * Optional base URL for the browser client used in pairing handoff links.
   * Example: https://relay.example.com/client/
   */
  webClientBaseUrl?: string;
  gatewayKeyPair: GatewayKeyPairConfig;
  approvedClients: Record<string, ApprovedClientRecord>;
  peerDiscovery?: PeerDiscoveryConfig;
}

export interface RelayChannelConfig {
  accounts: Record<string, RelayAccountConfig>;
}

export interface InspectApprovedClient {
  fingerprint: string;
  label?: string;
  lastSeenAt?: string;
}

export interface RelayAccountInspection {
  enabled: boolean;
  server: string;
  channel: string;
  gatewayPublicKey: string;
  approvedClients: InspectApprovedClient[];
  peerDiscoveryEnabled: boolean;
  peerDiscoveryMetadata?: Record<string, unknown>;
  peerDiscoveryAutoAcceptEnabled?: boolean;
}

export interface RelayConfigStore {
  load(accountId: string): Promise<RelayAccountConfig | undefined>;
  save(accountId: string, config: RelayAccountConfig): Promise<void>;
  listAccountIds(): Promise<string[]>;
  inspectAccount(accountId: string): Promise<RelayAccountInspection | undefined>;
}

export interface RelayFrameBase {
  type: string;
}

export interface RegisterFrame extends RelayFrameBase {
  type: 'register';
  channel: string;
  version: number;
  discoverable?: boolean;
  public_key?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisteredFrame extends RelayFrameBase {
  type: 'registered';
  channel: string;
  clients?: number;
}

export interface JoinFrame extends RelayFrameBase {
  type: 'join';
  channel: string;
  version: number;
  client_id: string;
}

export interface JoinedFrame extends RelayFrameBase {
  type: 'joined';
  channel: string;
  gateway_online: boolean;
}

export interface DiscoveryPeer {
  public_key: string;
  metadata?: Record<string, unknown>;
  online_since: string;
}

export interface DiscoverFrame extends RelayFrameBase {
  type: 'discover';
}

export interface DiscoverResultFrame extends RelayFrameBase {
  type: 'discover_result';
  peers: DiscoveryPeer[];
}

export interface SignalSendFrame extends RelayFrameBase {
  type: 'signal';
  target: string;
  ephemeral_key: string;
  payload: string;
}

export interface SignalForwardFrame extends RelayFrameBase {
  type: 'signal';
  source: string;
  ephemeral_key: string;
  payload: string;
}

export interface SignalErrorFrame extends RelayFrameBase {
  type: 'signal_error';
  code: string;
  target?: string;
}

export interface InviteCreateFrame extends RelayFrameBase {
  type: 'invite_create';
  invite_hash: string;
  max_uses?: number;
  ttl_seconds?: number;
}

export interface InviteCreatedFrame extends RelayFrameBase {
  type: 'invite_created';
  invite_hash: string;
  expires_at: string;
}

export interface DataFrame extends RelayFrameBase {
  type: 'data';
  from?: string;
  to: string;
  payload: string;
}

export interface PresenceFrame extends RelayFrameBase {
  type: 'presence';
  role: 'gateway' | 'client';
  status: 'online' | 'offline';
  client_id?: string;
}

export interface PingFrame extends RelayFrameBase {
  type: 'ping' | 'pong';
  ts: number;
}

export interface ErrorFrame extends RelayFrameBase {
  type: 'error';
  code: string;
  message: string;
}

export type RelayFrame =
  | RegisterFrame
  | RegisteredFrame
  | JoinFrame
  | JoinedFrame
  | DiscoverFrame
  | DiscoverResultFrame
  | SignalSendFrame
  | SignalForwardFrame
  | SignalErrorFrame
  | InviteCreateFrame
  | InviteCreatedFrame
  | DataFrame
  | PresenceFrame
  | PingFrame
  | ErrorFrame
  | Record<string, unknown>;

export interface PeerSignalEnvelope {
  version: 1;
  kind: string;
  body?: Record<string, unknown>;
}

export interface ReceivedPeerSignal {
  source: string;
  envelope: PeerSignalEnvelope;
  receivedAt: string;
  raw: SignalForwardFrame;
}

export interface HelloMessage {
  type: 'hello';
  client_public_key: string;
  session_nonce: string;
  protocol_version?: number;
  capabilities?: string[];
}

export interface HelloAckMessage {
  type: 'hello_ack';
  gateway_public_key: string;
  session_nonce: string;
  protocol_version: number;
  capabilities: string[];
}

export interface RequestMessage {
  id: string;
  type: 'request';
  method: string;
  params: Record<string, unknown>;
}

export interface ResponseMessage {
  id: string;
  type: 'response';
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface StreamStartMessage {
  id: string;
  type: 'stream_start';
  method: string;
}

export interface StreamChunkMessage {
  id: string;
  type: 'stream_chunk';
  seq: number;
  data: Record<string, unknown>;
}

export interface StreamEndMessage {
  id: string;
  type: 'stream_end';
  seq: number;
}

export interface CancelMessage {
  id: string;
  type: 'cancel';
}

export interface NotifyMessage {
  id: string;
  type: 'notify';
  event: string;
  data: Record<string, unknown>;
}

export type Layer2Message = RequestMessage | ResponseMessage | StreamStartMessage | StreamChunkMessage | StreamEndMessage | CancelMessage | NotifyMessage | Record<string, unknown>;

export interface ClientSessionRecord {
  clientId: string;
  fingerprint: string;
  publicKey: Uint8Array;
  capabilities: string[];
  connectedAt: Date;
  lastActivity: Date;
}

export interface RelayRequestContext {
  accountId: string;
  clientId: string;
  fingerprint: string;
  signal: AbortSignal;
}

export interface RelayStreamResult<TChunk extends Record<string, unknown> = Record<string, unknown>, TFinal extends Record<string, unknown> = Record<string, unknown>> {
  stream: AsyncIterable<TChunk>;
  final: TFinal | Promise<TFinal>;
}

export interface RelayRuntimeAdapter {
  chatSend?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown> | RelayStreamResult>;
  agentsList?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
  agentsInfo?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
  sessionsList?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
  sessionsHistory?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
  cronList?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
  cronToggle?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
  systemStatus?(params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>>;
}

export interface PeerDiscoveryStatus {
  enabled: boolean;
  publicKey?: string;
  pendingSignals: number;
  pendingSignalErrors: number;
}

export interface GatewayStatus {
  state: ConnectionState;
  health: HealthState;
  server?: string;
  channel?: string;
  approvedClients: number;
  activeSessions: number;
  lastRegisteredAt?: string;
  lastFatalErrorCode?: string;
  peerDiscovery?: PeerDiscoveryStatus;
}

export interface PairingSessionInfo {
  accountId: string;
  relayUrl: string;
  channelToken: string;
  gatewayPublicKey: string;
  gatewayFingerprint: string;
  uri: string;
  expiresAt: string;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
