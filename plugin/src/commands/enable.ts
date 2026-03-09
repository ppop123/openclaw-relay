import { generateGatewayIdentity } from '../crypto.js';
import { RelayConfigStore, type PeerDiscoveryConfig } from '../types.js';
import { ensureEnabledAccountConfig } from '../pairing.js';

export async function handleRelayEnable(
  store: RelayConfigStore,
  server: string,
  accountId = 'default',
  options: {
    discoverable?: boolean;
    discoveryMetadata?: Record<string, unknown> | null;
    autoAcceptRequestsEnabled?: boolean;
    autoAcceptTtlSeconds?: number;
    autoAcceptMaxUses?: number;
  } = {},
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
    ...((options.autoAcceptRequestsEnabled !== undefined || options.autoAcceptTtlSeconds !== undefined || options.autoAcceptMaxUses !== undefined || account.peerDiscovery?.autoAcceptRequests)
      ? {
          autoAcceptRequests: {
            enabled: options.autoAcceptRequestsEnabled ?? account.peerDiscovery?.autoAcceptRequests?.enabled ?? false,
            ...(options.autoAcceptTtlSeconds !== undefined
              ? { ttlSeconds: options.autoAcceptTtlSeconds }
              : account.peerDiscovery?.autoAcceptRequests?.ttlSeconds !== undefined
                ? { ttlSeconds: account.peerDiscovery.autoAcceptRequests.ttlSeconds }
                : {}),
            ...(options.autoAcceptMaxUses !== undefined
              ? { maxUses: options.autoAcceptMaxUses }
              : account.peerDiscovery?.autoAcceptRequests?.maxUses !== undefined
                ? { maxUses: account.peerDiscovery.autoAcceptRequests.maxUses }
                : {}),
          },
        }
      : {}),
  };
  const next = {
    ...account,
    peerDiscovery,
  };
  await store.save(accountId, next);
  return next;
}
