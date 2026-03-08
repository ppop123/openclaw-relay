import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const relayCwd = fileURLToPath(new URL('../../relay/', import.meta.url));

async function buildRelayBinary(): Promise<{ binaryPath: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'openclaw-relay-plugin-test-'));
  const binaryPath = join(tempDir, process.platform === 'win32' ? 'openclaw-relay.exe' : 'openclaw-relay');

  try {
    await new Promise<void>((resolve, reject) => {
      const build = spawn('go', ['build', '-o', binaryPath, '.'], {
        cwd: relayCwd,
        stdio: 'pipe',
      });
      let stderr = '';

      build.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      build.once('error', reject);
      build.once('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr.trim() ? `failed to build relay test binary: ${stderr.trim()}` : `failed to build relay test binary with exit code ${code}`));
      });
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return { binaryPath, tempDir };
}

async function waitForRelayReady(process: ChildProcessWithoutNullStreams, url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let processError: Error | undefined;
  let exited = false;
  let stderr = '';

  const onError = (error: Error) => {
    processError = error;
  };
  const onExit = () => {
    exited = true;
  };

  process.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  process.once('error', onError);
  process.once('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (processError) {
        throw processError;
      }
      if (exited) {
        throw new Error(stderr.trim() ? `relay exited before becoming ready: ${stderr.trim()}` : 'relay exited before becoming ready');
      }
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {
        // keep polling
      }
      await delay(200);
    }
  } finally {
    process.off('error', onError);
    process.off('exit', onExit);
  }

  throw new Error('relay did not become ready in time');
}

async function waitForValue<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await delay(intervalMs);
  }
  throw new Error('timed out waiting for expected value');
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
    let relayTempDir: string | undefined;

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

      const relayBuild = await buildRelayBinary();
      relayTempDir = relayBuild.tempDir;
      relayProcess = spawn(relayBuild.binaryPath, ['-port', String(relayPort), '-tls', 'off'], {
        cwd: relayCwd,
        stdio: 'pipe',
      });
      await waitForRelayReady(relayProcess, `http://127.0.0.1:${relayPort}/status`, 15_000);

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
      expect(helloAckFrame.from).toBe('gateway');
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
      expect(responseFrame.from).toBe('gateway');
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
      if (relayTempDir) {
        await rm(relayTempDir, { recursive: true, force: true });
      }
    }
  }, 45_000);

  it('discovers a peer gateway, signals it, accepts the invite, and dials a real peer session', async () => {
    let relayProcess: ChildProcessWithoutNullStreams | undefined;
    let adapterA: RelayGatewayAdapter | undefined;
    let adapterB: RelayGatewayAdapter | undefined;
    let peerSession: { request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => Promise<void> } | undefined;
    let relayTempDir: string | undefined;

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

      const relayBuild = await buildRelayBinary();
      relayTempDir = relayBuild.tempDir;
      relayProcess = spawn(relayBuild.binaryPath, ['-port', String(relayPort), '-tls', 'off'], {
        cwd: relayCwd,
        stdio: 'pipe',
      });
      await waitForRelayReady(relayProcess, `http://127.0.0.1:${relayPort}/status`, 15_000);

      const serverUrl = `ws://127.0.0.1:${relayPort}/ws`;
      const storeA = new MemoryRelayConfigStore();
      const storeB = new MemoryRelayConfigStore();
      const runtimeA: RelayRuntimeAdapter = {
        systemStatus: async () => ({ version: 'gateway-a', uptime_seconds: 1, agents_active: 1, cron_tasks: 0, channels: { relay: 'running' } }),
      };
      const runtimeB: RelayRuntimeAdapter = {
        systemStatus: async () => ({ version: 'gateway-b', uptime_seconds: 2, agents_active: 2, cron_tasks: 0, channels: { relay: 'running' } }),
      };

      await handleRelayEnable(storeA, serverUrl, 'default', { discoverable: true });
      await handleRelayEnable(storeB, serverUrl, 'default', { discoverable: true });

      adapterA = new RelayGatewayAdapter({ accountId: 'default', configStore: storeA, runtime: runtimeA });
      adapterB = new RelayGatewayAdapter({ accountId: 'default', configStore: storeB, runtime: runtimeB });
      await adapterA.start();
      await adapterB.start();

      const accountA = (await storeA.load('default'))!;
      const accountB = (await storeB.load('default'))!;

      const discovered = await waitForValue(async () => {
        const peers = await adapterA!.discoverPeers();
        const peer = peers.find((entry) => entry.public_key === accountB.gatewayKeyPair.publicKey);
        return peer ? peers : undefined;
      }, 10_000, 150);
      expect(discovered.some((entry) => entry.public_key === accountB.gatewayKeyPair.publicKey)).toBe(true);

      await adapterA.sendPeerSignal(accountB.gatewayKeyPair.publicKey, {
        version: 1,
        kind: 'invite_request',
        body: { reason: 'integration-test' },
      });

      const inboundSignal = await waitForValue(async () => {
        const signals = adapterB!.drainPeerSignals();
        return signals.length > 0 ? signals[0] : undefined;
      }, 10_000, 150);
      expect(inboundSignal.source).toBe(accountA.gatewayKeyPair.publicKey);
      expect(inboundSignal.envelope).toMatchObject({ version: 1, kind: 'invite_request', body: { reason: 'integration-test' } });

      await adapterB.authorizePeerPublicKey(inboundSignal.source, 60, 1);
      const invite = await adapterB.createPeerInvite(60);
      peerSession = await adapterA.dialPeerInvite(invite.inviteToken, accountB.gatewayKeyPair.publicKey);

      await expect(peerSession.request('system.status', {})).resolves.toMatchObject({ version: 'gateway-b', agents_active: 2 });
    } finally {
      await peerSession?.close().catch(() => undefined);
      if (adapterA) {
        await adapterA.stop();
      }
      if (adapterB) {
        await adapterB.stop();
      }
      relayProcess?.kill('SIGTERM');
      await delay(200);
      if (relayTempDir) {
        await rm(relayTempDir, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
