import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryRelayConfigStore } from '../src/config.js';
import { RelayGatewayAdapter } from '../src/gateway-adapter.js';
import { handleRelayEnable } from '../src/commands/enable.js';
import { SessionCipher } from '../src/crypto.js';
import type { RelayRuntimeAdapter } from '../src/types.js';
import { arrayBufferFrom } from '../src/utils.js';

function isLocalListenBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'EPERM' || code === 'EACCES';
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForStatus(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await delay(200);
  }
  throw new Error('relay did not become ready in time');
}

async function waitForMessage(ws: WebSocket, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage as EventListener);
      resolve(JSON.parse(String(event.data)));
    };
    ws.addEventListener('message', onMessage as EventListener);
  });
}

async function deriveClientCipher(gatewayPublicKeyBytes: Uint8Array, gatewayNonce: Uint8Array, clientNonce: Uint8Array, clientKeyPair: CryptoKeyPair, clientPublicKeyBytes: Uint8Array) {
  const gatewayPublicKey = await crypto.subtle.importKey('raw', arrayBufferFrom(gatewayPublicKeyBytes), { name: 'X25519' }, true, []);
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
  const salt = await crypto.subtle.digest('SHA-256', arrayBufferFrom(saltInput));
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const sessionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('openclaw-relay-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return new SessionCipher(sessionKey, SessionCipher.DIRECTION_CLIENT_TO_GATEWAY);
}

describe('plugin integration with real relay', () => {
  it('registers as gateway, pairs a client, and serves system.status', async () => {
    let relayProcess: ChildProcessWithoutNullStreams | undefined;
    let adapter: RelayGatewayAdapter | undefined;
    let ws: WebSocket | undefined;

    try {
      let relayPort = 0;
      try {
        relayPort = await getFreePort();
      } catch (error) {
        if (isLocalListenBlocked(error)) {
          return;
        }
        throw error;
      }

      relayProcess = spawn('go', ['run', '.', '-port', String(relayPort), '-tls', 'off'], {
        cwd: 'relay',
        stdio: 'pipe',
      });
      await waitForStatus(`http://127.0.0.1:${relayPort}/status`);

      const store = new MemoryRelayConfigStore();
      const runtime: RelayRuntimeAdapter = {
        systemStatus: async () => ({
          version: 'test-runtime',
          uptime_seconds: 12,
          agents_active: 1,
          cron_tasks: 0,
          channels: { relay: 'running' },
        }),
      };

      await handleRelayEnable(store, `ws://127.0.0.1:${relayPort}/ws`, 'default');
      adapter = new RelayGatewayAdapter({ accountId: 'default', configStore: store, runtime });
      await adapter.start();
      await adapter.beginPairing();

      const account = (await store.load('default'))!;
      const channelHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account.channelToken));
      const channel = Array.from(new Uint8Array(channelHash), (byte) => byte.toString(16).padStart(2, '0')).join('');

      ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener('open', () => resolve(), { once: true });
        ws!.addEventListener('error', () => reject(new Error('client websocket error')), { once: true });
      });

      ws.send(JSON.stringify({ type: 'join', channel, version: 1, client_id: 'client-1' }));
      const joined = await waitForMessage(ws);
      expect(joined.type).toBe('joined');
      expect(joined.gateway_online).toBe(true);

      const clientKeyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
      const clientPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', clientKeyPair.publicKey));
      const clientNonce = crypto.getRandomValues(new Uint8Array(32));

      ws.send(JSON.stringify({
        type: 'data',
        to: 'gateway',
        payload: JSON.stringify({
          type: 'hello',
          client_public_key: btoa(String.fromCharCode(...clientPublicKeyBytes)),
          session_nonce: btoa(String.fromCharCode(...clientNonce)),
          protocol_version: 1,
          capabilities: ['system'],
        }),
      }));

      const helloAckFrame = await waitForMessage(ws);
      expect(helloAckFrame.type).toBe('data');
      const helloAck = JSON.parse(helloAckFrame.payload);
      expect(helloAck.type).toBe('hello_ack');

      const clientCipher = await deriveClientCipher(
        Uint8Array.from(atob(helloAck.gateway_public_key), (char) => char.charCodeAt(0)),
        Uint8Array.from(atob(helloAck.session_nonce), (char) => char.charCodeAt(0)),
        clientNonce,
        clientKeyPair,
        clientPublicKeyBytes,
      );

      const requestPayload = await clientCipher.encryptText(JSON.stringify({
        id: 'msg_1',
        type: 'request',
        method: 'system.status',
        params: {},
      }));
      ws.send(JSON.stringify({ type: 'data', to: 'gateway', payload: requestPayload }));

      const responseFrame = await waitForMessage(ws);
      const decrypted = await clientCipher.decryptToText(responseFrame.payload);
      const response = JSON.parse(decrypted);
      expect(response.type).toBe('response');
      expect(response.result.version).toBe('test-runtime');
    } finally {
      ws?.close();
      if (adapter) {
        await adapter.stop();
      }
      relayProcess?.kill('SIGTERM');
      await delay(200);
    }
  }, 30_000);
});
