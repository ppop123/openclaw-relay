import { generateGatewayIdentity } from '../crypto.js';
import { RelayConfigStore } from '../types.js';
import { ensureEnabledAccountConfig } from '../pairing.js';

export async function handleRelayEnable(store: RelayConfigStore, server: string, accountId = 'default') {
  const existing = await store.load(accountId);
  const identity = existing?.gatewayKeyPair ?? (await generateGatewayIdentity()).serialized;
  const account = await ensureEnabledAccountConfig(existing ? { ...existing, gatewayKeyPair: identity } : undefined, server);
  await store.save(accountId, account);
  return account;
}
