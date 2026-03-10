import { PairingManager, buildPairingInfo } from '../pairing.js';
import { PairingSessionInfo, RelayConfigStore } from '../types.js';
import { randomHex } from '../utils.js';

type PairingWebUrlOptions = {
  autoConnect?: boolean;
};

export function buildPairingWebUrl(pairing: PairingSessionInfo, base: string, options: PairingWebUrlOptions = {}): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && !url.hostname.endsWith('.local')) {
    console.warn(`[relay] WARNING: pairing URL base uses ${url.protocol} — channelToken may be exposed in transit. Use HTTPS for production.`);
  }
  const params = new URLSearchParams({
    relay: pairing.relayUrl,
    token: pairing.channelToken,
    key: pairing.gatewayPublicKey,
  });
  if (options.autoConnect === true) {
    params.set('auto', '1');
  }

  // Always include a nonce so that repeated pairing calls produce a fresh URL.
  // This avoids "same link" confusion and ensures clients re-run onboarding
  // even if a browser tab is already open.
  params.set('t', String(Date.now()));
  params.set('nonce', randomHex(4));

  url.hash = params.toString();
  return url.toString();
}

export function buildDefaultPairingWebBase(pairing: PairingSessionInfo): string {
  const relay = new URL(pairing.relayUrl);
  const scheme = relay.protocol === 'ws:' ? 'http:' : 'https:';
  return `${scheme}//${relay.host}/client/`;
}

export async function handleRelayPair(store: RelayConfigStore, pairing: PairingManager, accountId = 'default') {
  const account = await store.load(accountId);
  if (!account) throw new Error(`account '${accountId}' not found`);
  pairing.begin();
  return buildPairingInfo(accountId, account, pairing);
}
