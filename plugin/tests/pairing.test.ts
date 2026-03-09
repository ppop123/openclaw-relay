import { describe, expect, it } from 'vitest';
import { MemoryRelayConfigStore } from '../src/config.js';
import { handleRelayDisable, handleRelayRotateToken } from '../src/commands/disable.js';
import { handleRelayEnable } from '../src/commands/enable.js';
import { buildPairingWebUrl, handleRelayPair } from '../src/commands/pair.js';
import { handleRelayClients, handleRelayRevoke } from '../src/commands/clients.js';
import { PairingManager, approveClient } from '../src/pairing.js';

const sampleClientKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('pairing and config commands', () => {
  it('enables relay, opens pairing, and redacts inspect output', async () => {
    const store = new MemoryRelayConfigStore();
    const pairing = new PairingManager(60_000);

    const account = await handleRelayEnable(store, 'wss://relay.example.com', 'default', { discoverable: true });
    expect(account.enabled).toBe(true);
    expect(account.channelToken.length).toBeGreaterThan(10);
    expect(account.peerDiscovery?.enabled).toBe(true);

    const info = await handleRelayPair(store, pairing, 'default');
    expect(pairing.isActive()).toBe(true);
    expect(info.relayUrl).toBe('wss://relay.example.com');
    expect(info.channelToken).toBe(account.channelToken);
    expect(info.uri.startsWith('openclaw-relay://relay.example.com/')).toBe(true);
    expect(buildPairingWebUrl(info, 'http://localhost:8080/client/')).toBe(
      `http://localhost:8080/client/#relay=${encodeURIComponent(info.relayUrl)}&token=${encodeURIComponent(info.channelToken)}&key=${encodeURIComponent(info.gatewayPublicKey)}`
    );

    const inspect = await store.inspectAccount('default');
    expect(inspect?.gatewayPublicKey).toBe(account.gatewayKeyPair.publicKey);
    expect(inspect?.peerDiscoveryEnabled).toBe(true);
    expect(JSON.stringify(inspect)).not.toContain(account.channelToken);
    expect(JSON.stringify(inspect)).not.toContain(account.gatewayKeyPair.privateKey);
  });

  it('stores, inspects, and clears operator discovery metadata', async () => {
    const store = new MemoryRelayConfigStore();

    const account = await handleRelayEnable(store, 'wss://relay.example.com', 'default', {
      discoverable: true,
      discoveryMetadata: { label: 'Ops Gateway', region: 'apac', capabilities: ['peer-discovery'] },
    });

    expect(account.peerDiscovery).toEqual({
      enabled: true,
      metadata: { label: 'Ops Gateway', region: 'apac', capabilities: ['peer-discovery'] },
    });

    const inspect = await store.inspectAccount('default');
    expect(inspect?.peerDiscoveryEnabled).toBe(true);
    expect(inspect?.peerDiscoveryMetadata).toEqual({
      label: 'Ops Gateway',
      region: 'apac',
      capabilities: ['peer-discovery'],
    });

    await handleRelayEnable(store, 'wss://relay.example.com', 'default', {
      discoveryMetadata: { label: 'Ops Gateway CN', region: 'cn-sha' },
    });

    const updated = await store.load('default');
    expect(updated?.peerDiscovery).toEqual({
      enabled: true,
      metadata: { label: 'Ops Gateway CN', region: 'cn-sha' },
    });

    await handleRelayEnable(store, 'wss://relay.example.com', 'default', { discoveryMetadata: null });

    const cleared = await store.load('default');
    expect(cleared?.peerDiscovery).toEqual({ enabled: true });
    const inspectCleared = await store.inspectAccount('default');
    expect(inspectCleared?.peerDiscoveryEnabled).toBe(true);
    expect(inspectCleared?.peerDiscoveryMetadata).toBeUndefined();
  });

  it('persists auto-accept peer settings in discovery config', async () => {
    const store = new MemoryRelayConfigStore();

    const account = await handleRelayEnable(store, 'wss://relay.example.com', 'default', {
      discoverable: true,
      autoAcceptRequestsEnabled: true,
      autoAcceptTtlSeconds: 90,
      autoAcceptMaxUses: 1,
    });

    expect(account.peerDiscovery).toEqual({
      enabled: true,
      autoAcceptRequests: { enabled: true, ttlSeconds: 90, maxUses: 1 },
    });

    const inspect = await store.inspectAccount('default');
    expect(inspect?.peerDiscoveryEnabled).toBe(true);
    expect(inspect?.peerDiscoveryAutoAcceptEnabled).toBe(true);
  });

  it('approves, lists, revokes, rotates token, and disables', async () => {
    const store = new MemoryRelayConfigStore();
    const pairing = new PairingManager();
    await handleRelayEnable(store, 'wss://relay.example.com', 'default');

    const fingerprint = await approveClient(store, 'default', sampleClientKey, 'client-1', 'Phone');
    const listBefore = await handleRelayClients(store, 'default');
    expect(listBefore).toHaveLength(1);
    expect(listBefore[0].fingerprint).toBe(fingerprint);

    const beforeRotate = (await store.load('default'))!.channelToken;
    const afterRotate = await handleRelayRotateToken(store, 'default');
    expect(afterRotate).not.toBe(beforeRotate);

    await handleRelayRevoke(store, pairing, fingerprint, 'default');
    const listAfter = await handleRelayClients(store, 'default');
    expect(listAfter).toHaveLength(0);

    await handleRelayDisable(store, 'default');
    expect((await store.load('default'))?.enabled).toBe(false);
  });
});
