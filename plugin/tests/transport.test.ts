import { describe, expect, it, vi } from 'vitest';
import { generateGatewayIdentity, SessionCipher } from '../src/crypto.js';
import { MemoryRelayConfigStore } from '../src/config.js';
import { PairingManager } from '../src/pairing.js';
import { GatewayTransport } from '../src/transport.js';
import { RelayGatewayAdapter } from '../src/gateway-adapter.js';
import type { DataFrame, RelayAccountConfig, RequestMessage } from '../src/types.js';

async function createClientHello() {
  const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const clientNonce = crypto.getRandomValues(new Uint8Array(32));
  return { keyPair, publicKeyBytes, clientNonce };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function helloPayload(client: { publicKeyBytes: Uint8Array; clientNonce: Uint8Array }): string {
  return JSON.stringify({
    type: 'hello',
    client_public_key: encodeBase64(client.publicKeyBytes),
    session_nonce: encodeBase64(client.clientNonce),
    protocol_version: 1,
    capabilities: ['chat'],
  });
}

async function deriveClientCipher(gatewayPublicKeyBytes: Uint8Array, gatewayNonce: Uint8Array, clientNonce: Uint8Array, clientKeyPair: CryptoKeyPair, clientPublicKeyBytes: Uint8Array) {
  const gatewayPublicKey = await crypto.subtle.importKey('raw', gatewayPublicKeyBytes, { name: 'X25519' }, true, []);
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: gatewayPublicKey },
    clientKeyPair.privateKey,
    256,
  );
  const saltInput = new Uint8Array([
    ...clientPublicKeyBytes,
    ...gatewayPublicKeyBytes,
    ...clientNonce,
    ...gatewayNonce,
  ]);
  const salt = await crypto.subtle.digest('SHA-256', saltInput);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const sessionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info: new TextEncoder().encode('openclaw-relay-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return new SessionCipher(sessionKey, SessionCipher.DIRECTION_CLIENT_TO_GATEWAY);
}

function makeAccountConfig(serialized: { privateKey: string; publicKey: string }): RelayAccountConfig {
  return {
    enabled: true,
    server: 'ws://relay.example.test/ws',
    channelToken: 'demo-token',
    gatewayKeyPair: serialized,
    approvedClients: {},
  };
}

describe('GatewayTransport', () => {
  it('updates approved client lastSeen metadata without persisting config', async () => {
    const savedConfigs = [];
    const account = {
      enabled: true,
      server: 'ws://relay.example/ws',
      channelToken: 'token',
      gatewayKeyPair: { privateKey: 'priv', publicKey: 'pub' },
      approvedClients: {
        'sha256:test': {
          publicKey: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
          firstPairedAt: '2026-03-08T00:00:00.000Z',
        },
      },
    };
    const configStore = {
      load: vi.fn(async () => account),
      save: vi.fn(async (accountId, next) => { savedConfigs.push([accountId, next]); }),
      listAccountIds: vi.fn(async () => ['default']),
      inspectAccount: vi.fn(async () => undefined),
    };
    const runtime = { systemStatus: async () => ({ version: 'test' }) };
    const adapter = new RelayGatewayAdapter({ accountId: 'default', configStore, runtime });
    adapter['currentConfig'] = account;
    const identity = await generateGatewayIdentity();
    const transport = new GatewayTransport({
      accountId: 'default',
      identity,
      accountConfig: () => adapter['currentConfig'],
      pairingActive: () => false,
      endPairing: () => undefined,
      capabilities: () => ['system'],
      sendFrame: () => undefined,
      touchApprovedClient: async (fingerprint, clientId) => {
        const current = adapter['currentConfig'];
        const record = current.approvedClients[fingerprint];
        adapter['currentConfig'] = {
          ...current,
          approvedClients: {
            ...current.approvedClients,
            [fingerprint]: { ...record, lastSeenClientId: clientId, lastSeenAt: '2026-03-08T01:02:03.000Z' },
          },
        };
      },
      onRequest: () => undefined,
    });
    await transport['options'].touchApprovedClient?.('sha256:test', 'client-1');
    expect(adapter['currentConfig'].approvedClients['sha256:test'].lastSeenClientId).toBe('client-1');
    expect(savedConfigs).toEqual([]);
  });

  it('drops unknown hello outside pairing mode', async () => {
    const identity = await generateGatewayIdentity();
    const account = makeAccountConfig(identity.serialized);
    const sentFrames: DataFrame[] = [];

    const transport = new GatewayTransport({
      accountId: 'default',
      identity,
      accountConfig: () => account,
      pairingActive: () => false,
      endPairing: () => {},
      capabilities: () => ['chat', 'stream'],
      sendFrame: async (frame) => sentFrames.push(frame),
      onRequest: async () => {},
    });

    const client = await createClientHello();
    await transport.handleDataFrame({
      type: 'data',
      from: 'client-1',
      to: 'gateway',
      payload: helloPayload(client),
    });

    expect(sentFrames).toHaveLength(1);
    expect(JSON.parse(sentFrames[0].payload)).toMatchObject({ type: 'hello_reject', code: 'pairing_required' });
    expect(transport.sessionCount).toBe(0);
  });

  it('accepts an invite-authorized peer hello outside pairing mode', async () => {
    const identity = await generateGatewayIdentity();
    const account = makeAccountConfig(identity.serialized);
    const sentFrames: DataFrame[] = [];
    const authorizePeerClient = vi.fn(async () => true);
    const touchApprovedClient = vi.fn(async () => undefined);

    const transport = new GatewayTransport({
      accountId: 'default',
      identity,
      accountConfig: () => account,
      pairingActive: () => false,
      endPairing: () => {},
      capabilities: () => ['chat', 'stream'],
      sendFrame: async (frame) => sentFrames.push(frame),
      authorizePeerClient,
      touchApprovedClient,
      onRequest: async () => {},
    });

    const client = await createClientHello();
    await transport.handleDataFrame({
      type: 'data',
      from: 'peer-client-1',
      to: 'gateway',
      payload: helloPayload(client),
    });

    expect(authorizePeerClient).toHaveBeenCalledTimes(1);
    expect(touchApprovedClient).not.toHaveBeenCalled();
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({ type: 'data', from: 'gateway', to: 'peer-client-1' });
    expect(transport.sessionCount).toBe(1);
  });

  it('pairs unknown client during pairing mode and dispatches encrypted request', async () => {
    const identity = await generateGatewayIdentity();
    let account = makeAccountConfig(identity.serialized);
    const sentFrames: DataFrame[] = [];
    const pairing = new PairingManager();
    pairing.begin();
    const onRequest = vi.fn();

    const transport = new GatewayTransport({
      accountId: 'default',
      identity,
      accountConfig: () => account,
      pairingActive: () => pairing.isActive(),
      endPairing: () => pairing.end(),
      capabilities: () => ['chat', 'stream'],
      sendFrame: async (frame) => sentFrames.push(frame),
      approveUnknownClient: async (publicKey, clientId) => {
        const store = new MemoryRelayConfigStore({ default: account });
        const { approveClient } = await import('../src/pairing.js');
        const fingerprint = await approveClient(store, 'default', publicKey, clientId);
        account = (await store.load('default'))!;
        return fingerprint;
      },
      touchApprovedClient: async () => {},
      onRequest: async (session, message) => {
        onRequest(session, message);
      },
    });

    const client = await createClientHello();
    await transport.handleDataFrame({ type: 'data', from: 'client-1', to: 'gateway', payload: helloPayload(client) });
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({ type: 'data', from: 'gateway', to: 'client-1' });
    expect(pairing.isActive()).toBe(false);
    expect(transport.sessionCount).toBe(1);

    const helloAck = JSON.parse(sentFrames[0].payload) as { gateway_public_key: string; session_nonce: string };
    const clientCipher = await deriveClientCipher(
      new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey)),
      Uint8Array.from(atob(helloAck.session_nonce), (char) => char.charCodeAt(0)),
      client.clientNonce,
      client.keyPair,
      client.publicKeyBytes,
    );

    const request: RequestMessage = {
      id: 'msg_1',
      type: 'request',
      method: 'system.status',
      params: {},
    };
    const encrypted = await clientCipher.encryptText(JSON.stringify(request));
    await transport.handleDataFrame({ type: 'data', from: 'client-1', to: 'gateway', payload: encrypted });

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0][1]).toEqual(request);

    await transport.sendLayer2('client-1', { id: 'msg_2', type: 'response', result: { ok: true } });
    expect(sentFrames[1]).toMatchObject({ type: 'data', from: 'gateway', to: 'client-1' });
  });

  it('consumes the pairing window only once for concurrent unknown clients', async () => {
    const identity = await generateGatewayIdentity();
    let account = makeAccountConfig(identity.serialized);
    const sentFrames: DataFrame[] = [];
    let pairingActive = true;
    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const approveUnknownClient = vi.fn(async (publicKey: string, clientId: string) => {
      await approvalGate;
      const store = new MemoryRelayConfigStore({ default: account });
      const { approveClient } = await import('../src/pairing.js');
      const fingerprint = await approveClient(store, 'default', publicKey, clientId);
      account = (await store.load('default'))!;
      return fingerprint;
    });

    const transport = new GatewayTransport({
      accountId: 'default',
      identity,
      accountConfig: () => account,
      pairingActive: () => pairingActive,
      endPairing: () => {
        pairingActive = false;
      },
      capabilities: () => ['chat'],
      sendFrame: async (frame) => sentFrames.push(frame),
      approveUnknownClient,
      onRequest: async () => {},
    });

    const client1 = await createClientHello();
    const client2 = await createClientHello();
    const first = transport.handleDataFrame({ type: 'data', from: 'client-1', to: 'gateway', payload: helloPayload(client1) });
    const second = transport.handleDataFrame({ type: 'data', from: 'client-2', to: 'gateway', payload: helloPayload(client2) });

    await vi.waitFor(() => {
      expect(approveUnknownClient).toHaveBeenCalledTimes(1);
    });
    expect(sentFrames).toHaveLength(1);
    expect(JSON.parse(sentFrames[0].payload)).toMatchObject({ type: 'hello_reject', code: 'pairing_required' });

    releaseApproval();
    await Promise.all([first, second]);

    expect(pairingActive).toBe(false);
    expect(transport.sessionCount).toBe(1);
    expect(sentFrames).toHaveLength(2);
    expect(sentFrames[0]).toMatchObject({ type: 'data', from: 'gateway', to: 'client-2' });
    expect(JSON.parse(sentFrames[0].payload)).toMatchObject({ type: 'hello_reject', code: 'pairing_required' });
    expect(sentFrames[1]).toMatchObject({ type: 'data', from: 'gateway', to: 'client-1' });
  });
});
