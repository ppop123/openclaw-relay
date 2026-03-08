import {
  PeerDiscoveryConfig,
  RelayAccountConfig,
  RelayAccountInspection,
  RelayConfigStore,
  type ApprovedClientRecord,
  type InspectApprovedClient,
} from './types.js';
import { b64Decode, nowIso, publicKeyFingerprint, sha256Hex } from './utils.js';

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInspectApprovedClient(fingerprint: string, record: ApprovedClientRecord): InspectApprovedClient {
  return {
    fingerprint,
    ...(record.label ? { label: record.label } : {}),
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
  };
}

export function normalizePeerDiscoveryConfig(config: PeerDiscoveryConfig | undefined): PeerDiscoveryConfig {
  return {
    enabled: config?.enabled === true,
    ...(config?.metadata ? { metadata: cloneConfig(config.metadata) } : {}),
  };
}

export function validateAccountConfig(config: RelayAccountConfig): void {
  if (!config.server) throw new Error('relay server is required');
  if (!config.channelToken) throw new Error('channel token is required');
  if (!config.gatewayKeyPair?.privateKey) throw new Error('gateway private key is required');
  if (!config.gatewayKeyPair?.publicKey) throw new Error('gateway public key is required');
  if (!config.approvedClients) throw new Error('approvedClients is required');
  if (config.peerDiscovery && !isPlainObject(config.peerDiscovery)) throw new Error('peerDiscovery must be an object when provided');
  if (config.peerDiscovery?.metadata !== undefined && !isPlainObject(config.peerDiscovery.metadata)) {
    throw new Error('peerDiscovery.metadata must be an object when provided');
  }
}

export async function deriveChannelHash(channelToken: string): Promise<string> {
  return sha256Hex(channelToken);
}

export async function inspectAccount(config: RelayAccountConfig): Promise<RelayAccountInspection> {
  validateAccountConfig(config);
  const peerDiscovery = normalizePeerDiscoveryConfig(config.peerDiscovery);
  return {
    enabled: config.enabled,
    server: config.server,
    channel: await deriveChannelHash(config.channelToken),
    gatewayPublicKey: config.gatewayKeyPair.publicKey,
    approvedClients: Object.entries(config.approvedClients).map(([fingerprint, record]) => toInspectApprovedClient(fingerprint, record)),
    peerDiscoveryEnabled: peerDiscovery.enabled,
    ...(peerDiscovery.metadata ? { peerDiscoveryMetadata: cloneConfig(peerDiscovery.metadata) } : {}),
  };
}

export async function createEmptyAccount(server: string, gatewayKeyPair: { privateKey: string; publicKey: string }): Promise<RelayAccountConfig> {
  return {
    enabled: true,
    server,
    channelToken: '',
    gatewayKeyPair,
    approvedClients: {},
    peerDiscovery: { enabled: false },
  };
}

export class MemoryRelayConfigStore implements RelayConfigStore {
  private readonly accounts = new Map<string, RelayAccountConfig>();

  constructor(initial: Record<string, RelayAccountConfig> = {}) {
    for (const [accountId, account] of Object.entries(initial)) {
      this.accounts.set(accountId, cloneConfig(account));
    }
  }

  async load(accountId: string): Promise<RelayAccountConfig | undefined> {
    const account = this.accounts.get(accountId);
    return account ? cloneConfig(account) : undefined;
  }

  async save(accountId: string, config: RelayAccountConfig): Promise<void> {
    validateAccountConfig(config);
    this.accounts.set(accountId, cloneConfig(config));
  }

  async listAccountIds(): Promise<string[]> {
    return [...this.accounts.keys()].sort();
  }

  async inspectAccount(accountId: string): Promise<RelayAccountInspection | undefined> {
    const account = this.accounts.get(accountId);
    return account ? inspectAccount(account) : undefined;
  }
}

export async function upsertApprovedClient(
  config: RelayAccountConfig,
  clientPublicKey: string,
  clientId?: string,
  label?: string,
): Promise<{ fingerprint: string; next: RelayAccountConfig }> {
  const fingerprint = await publicKeyFingerprint(b64Decode(clientPublicKey));
  const next = cloneConfig(config);
  const existing = next.approvedClients[fingerprint];
  const lastSeenAt = nowIso();
  const nextRecord: ApprovedClientRecord = {
    publicKey: clientPublicKey,
    firstPairedAt: existing?.firstPairedAt ?? lastSeenAt,
    lastSeenAt,
    ...((label ?? existing?.label) ? { label: label ?? existing?.label! } : {}),
    ...((clientId ?? existing?.lastSeenClientId) ? { lastSeenClientId: clientId ?? existing?.lastSeenClientId! } : {}),
  };
  next.approvedClients[fingerprint] = nextRecord;
  return { fingerprint, next };
}

export function revokeApprovedClient(config: RelayAccountConfig, fingerprint: string): RelayAccountConfig {
  const next = cloneConfig(config);
  delete next.approvedClients[fingerprint];
  return next;
}

export function disableAccount(config: RelayAccountConfig): RelayAccountConfig {
  const next = cloneConfig(config);
  next.enabled = false;
  return next;
}
