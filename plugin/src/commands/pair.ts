import { PairingManager, buildPairingInfo } from '../pairing.js';
import { PairingSessionInfo, RelayConfigStore } from '../types.js';

export function buildPairingWebUrl(pairing: PairingSessionInfo, base: string): string {
  const url = new URL(base);
  const params = new URLSearchParams({
    relay: pairing.relayUrl,
    token: pairing.channelToken,
    key: pairing.gatewayPublicKey,
  });
  url.hash = params.toString();
  return url.toString();
}

export async function handleRelayPair(store: RelayConfigStore, pairing: PairingManager, accountId = 'default') {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  pairing.begin();
  return buildPairingInfo(accountId, account, pairing);
}
