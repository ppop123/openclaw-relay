import { PairingManager, buildPairingInfo } from '../pairing.js';
import { RelayConfigStore } from '../types.js';

export async function handleRelayPair(store: RelayConfigStore, pairing: PairingManager, accountId = 'default') {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  pairing.begin();
  return buildPairingInfo(accountId, account, pairing);
}
