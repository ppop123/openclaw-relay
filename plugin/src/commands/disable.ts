import { disableRelay, rotateToken } from '../pairing.js';
import { RelayConfigStore } from '../types.js';

export async function handleRelayDisable(store: RelayConfigStore, accountId = 'default') {
  await disableRelay(store, accountId);
}

export async function handleRelayRotateToken(store: RelayConfigStore, accountId = 'default') {
  return rotateToken(store, accountId);
}
