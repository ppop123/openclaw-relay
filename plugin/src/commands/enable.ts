import { generateGatewayIdentity } from '../crypto.js';
import { RelayConfigStore, type PeerDiscoveryConfig } from '../types.js';
import { ensureEnabledAccountConfig } from '../pairing.js';

export async function handleRelayEnable(
  store: RelayConfigStore,
  server: string,
  accountId = 'default',
  options: { discoverable?: boolean; discoveryMetadata?: Record<string, unknown> | null } = {},
) {
  const existing = await store.load(accountId);
  const identity = existing?.gatewayKeyPair ?? (await generateGatewayIdentity()).serialized;
  const account = await ensureEnabledAccountConfig(existing ? { ...existing, gatewayKeyPair: identity } : undefined, server);
  const peerDiscovery: PeerDiscoveryConfig = {
    enabled: options.discoverable ?? account.peerDiscovery?.enabled ?? false,
    ...(options.discoveryMetadata === undefined
      ? account.peerDiscovery?.metadata
        ? { metadata: structuredClone(account.peerDiscovery.metadata) as Record<string, unknown> }
        : {}
      : options.discoveryMetadata === null
        ? {}
        : { metadata: structuredClone(options.discoveryMetadata) as Record<string, unknown> }),
  };
  const next = {
    ...account,
    peerDiscovery,
  };
  await store.save(accountId, next);
  return next;
}
