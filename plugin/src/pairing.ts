import { generateGatewayIdentity, fingerprintFromPublicKeyBase64 } from './crypto.js';
import { disableAccount, revokeApprovedClient, upsertApprovedClient } from './config.js';
import { PairingSessionInfo, RelayAccountConfig, RelayConfigStore } from './types.js';
import { randomToken } from './utils.js';

export class PairingManager {
  private pairingUntil = 0;

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  begin(now = Date.now()): number {
    this.pairingUntil = now + this.ttlMs;
    return this.pairingUntil;
  }

  end(): void {
    this.pairingUntil = 0;
  }

  isActive(now = Date.now()): boolean {
    return now < this.pairingUntil;
  }

  expiresAt(): string | undefined {
    return this.pairingUntil > 0 ? new Date(this.pairingUntil).toISOString() : undefined;
  }
}

export async function ensureEnabledAccountConfig(existing: RelayAccountConfig | undefined, server: string): Promise<RelayAccountConfig> {
  if (existing) {
    return { ...existing, enabled: true, server };
  }
  const identity = await generateGatewayIdentity();
  return {
    enabled: true,
    server,
    channelToken: randomToken(24),
    gatewayKeyPair: identity.serialized,
    approvedClients: {},
    discovery: { enabled: false },
  };
}

export async function buildPairingInfo(accountId: string, config: RelayAccountConfig, pairing: PairingManager): Promise<PairingSessionInfo> {
  const relayUrl = config.server;
  const gatewayFingerprint = await fingerprintFromPublicKeyBase64(config.gatewayKeyPair.publicKey);
  const expiresAt = pairing.expiresAt() ?? new Date().toISOString();
  return {
    accountId,
    relayUrl,
    channelToken: config.channelToken,
    gatewayPublicKey: config.gatewayKeyPair.publicKey,
    gatewayFingerprint,
    uri: `openclaw-relay://${new URL(relayUrl).host}/${config.channelToken}#${config.gatewayKeyPair.publicKey}`,
    expiresAt,
  };
}

export async function approveClient(
  store: RelayConfigStore,
  accountId: string,
  publicKey: string,
  clientId?: string,
  label?: string,
): Promise<string> {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  const { fingerprint, next } = await upsertApprovedClient(account, publicKey, clientId, label);
  await store.save(accountId, next);
  return fingerprint;
}

export async function revokeClient(
  store: RelayConfigStore,
  accountId: string,
  fingerprint: string,
): Promise<void> {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  await store.save(accountId, revokeApprovedClient(account, fingerprint));
}

export async function rotateToken(store: RelayConfigStore, accountId: string): Promise<string> {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  const next = { ...account, channelToken: randomToken(24) };
  await store.save(accountId, next);
  return next.channelToken;
}

export async function disableRelay(store: RelayConfigStore, accountId: string): Promise<void> {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  await store.save(accountId, disableAccount(account));
}

export async function listApprovedClients(
  store: RelayConfigStore,
  accountId: string,
): Promise<Array<{ fingerprint: string; label?: string; firstPairedAt: string; lastSeenAt?: string; lastSeenClientId?: string }>> {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  return Object.entries(account.approvedClients)
    .map(([fingerprint, record]) => ({
      fingerprint,
      firstPairedAt: record.firstPairedAt,
      ...(record.label ? { label: record.label } : {}),
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(record.lastSeenClientId ? { lastSeenClientId: record.lastSeenClientId } : {}),
    }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}
