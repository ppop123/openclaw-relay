import { PairingManager, listApprovedClients, revokeClient } from '../pairing.js';
import { RelayConfigStore } from '../types.js';

export async function handleRelayClients(store: RelayConfigStore, accountId = 'default') {
  return listApprovedClients(store, accountId);
}

export async function handleRelayRevoke(store: RelayConfigStore, pairing: PairingManager, fingerprint: string, accountId = 'default') {
  await revokeClient(store, accountId, fingerprint);
  pairing.end();
}
