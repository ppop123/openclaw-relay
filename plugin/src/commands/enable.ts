import { generateGatewayIdentity } from '../crypto.js';
import { RelayConfigStore } from '../types.js';
import { ensureEnabledAccountConfig } from '../pairing.js';

export async function handleRelayEnable(
  store: RelayConfigStore,
  server: string,
  accountId = 'default',
  options: { discoverable?: boolean } = {},
) {
  const existing = await store.load(accountId);
  const identity = existing?.gatewayKeyPair ?? (await generateGatewayIdentity()).serialized;
  const account = await ensureEnabledAccountConfig(existing ? { ...existing, gatewayKeyPair: identity } : undefined, server);
  const next = options.discoverable === undefined
    ? account
    : {
        ...account,
        peerDiscovery: {
          ...(account.peerDiscovery ?? { enabled: false }),
          enabled: options.discoverable,
        },
      };
  await store.save(accountId, next);
  return next;
}
