import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const cryptoApi = globalThis.crypto ?? webcrypto;
const requireFromPlugin = createRequire(new URL('../plugin/package.json', import.meta.url));
const { WebSocketServer } = requireFromPlugin('ws');
const { chromium } = requireFromPlugin('playwright-core');

const CLIENT_ROOT = resolve(fileURLToPath(new URL('../client/', import.meta.url)));
const CHANNEL_TOKEN = 'browser-e2e-channel-token';
const SESSION_ID = 'sess_browser_e2e';
const chromeCandidates = [
  process.env.OPENCLAW_E2E_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function log(step) {
  console.log(`\n[web-client-e2e] ${step}`);
}

async function captureConfirm(page, action, expectedPattern) {
  const countBefore = await page.evaluate(() => window.__testDialogs?.length || 0);
  await action();
  await page.waitForFunction((count) => (window.__testDialogs?.length || 0) > count, countBefore);
  const message = await page.evaluate(() => window.__testDialogs.at(-1) || '');
  if (expectedPattern) {
    assert.match(message, expectedPattern, 'unexpected dialog text');
  }
  return message;
}

async function getIdentityFingerprint(page) {
  return page.evaluate(() => window.app.connection.identityFingerprint || '');
}

async function waitForIdentityFingerprint(page, expected) {
  await page.waitForFunction((value) => window.app.connection.identityFingerprint === value, expected);
}

function makeMismatchedPinnedKey(value) {
  const last = value.slice(-1);
  const replacement = last === 'A' ? 'B' : 'A';
  return `${value.slice(0, -1)}${replacement}`;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromePath() {
  for (const candidate of chromeCandidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error('Google Chrome was not found. Set OPENCLAW_E2E_CHROME to a Chromium-based browser binary.');
}

function contentType(pathname) {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'text/plain; charset=utf-8';
  }
}

function b64Encode(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function b64Decode(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function arrayBufferFrom(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function concat(...arrays) {
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function buildNonce(direction, counter) {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, direction);
  view.setUint32(4, Math.floor(counter / 0x100000000));
  view.setUint32(8, counter >>> 0);
  return nonce;
}

async function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

class SessionCipher {
  static DIRECTION_CLIENT_TO_GATEWAY = 1;
  static DIRECTION_GATEWAY_TO_CLIENT = 2;

  constructor(sessionKey, sendDirection) {
    this.sessionKey = sessionKey;
    this.sendDirection = sendDirection;
    this.recvDirection = sendDirection === SessionCipher.DIRECTION_GATEWAY_TO_CLIENT
      ? SessionCipher.DIRECTION_CLIENT_TO_GATEWAY
      : SessionCipher.DIRECTION_GATEWAY_TO_CLIENT;
    this.sendCounter = 0;
    this.recvCounterMax = -1;
    this.recvWindow = new Set();
  }

  async encryptObject(value) {
    const nonce = buildNonce(this.sendDirection, this.sendCounter++);
    const ciphertext = await cryptoApi.subtle.encrypt(
      { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
      this.sessionKey,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return b64Encode(concat(nonce, new Uint8Array(ciphertext)));
  }

  async decryptObject(payload) {
    const raw = b64Decode(payload);
    const nonce = raw.slice(0, 12);
    const view = new DataView(arrayBufferFrom(nonce));
    const direction = view.getUint32(0);
    if (direction !== this.recvDirection) {
      throw new Error(`wrong nonce direction ${direction}`);
    }
    const counter = view.getUint32(4) * 0x100000000 + view.getUint32(8);
    if (this.recvCounterMax < 0) {
      if (counter !== 0) throw new Error('first counter must be zero');
    } else {
      if (counter <= this.recvCounterMax - 64) throw new Error('counter too old');
      if (counter <= this.recvCounterMax && this.recvWindow.has(counter)) throw new Error('duplicate counter');
    }
    const plaintext = await cryptoApi.subtle.decrypt(
      { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
      this.sessionKey,
      arrayBufferFrom(raw.slice(12)),
    );
    if (counter > this.recvCounterMax) this.recvCounterMax = counter;
    this.recvWindow.add(counter);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
}

async function createGatewayIdentity() {
  const keyPair = await cryptoApi.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKeyBytes = new Uint8Array(await cryptoApi.subtle.exportKey('raw', keyPair.publicKey));
  return {
    keyPair,
    publicKeyBytes,
    publicKeyB64: b64Encode(publicKeyBytes),
  };
}

async function deriveGatewaySessionKey(gatewayIdentity, hello) {
  const clientPublicKeyBytes = b64Decode(hello.client_public_key);
  const clientNonce = b64Decode(hello.session_nonce);
  const gatewayNonce = cryptoApi.getRandomValues(new Uint8Array(32));
  const clientPublicKey = await cryptoApi.subtle.importKey('raw', arrayBufferFrom(clientPublicKeyBytes), { name: 'X25519' }, true, []);
  const sharedSecret = await cryptoApi.subtle.deriveBits(
    { name: 'X25519', public: clientPublicKey },
    gatewayIdentity.keyPair.privateKey,
    256,
  );
  const saltInput = concat(clientPublicKeyBytes, gatewayIdentity.publicKeyBytes, clientNonce, gatewayNonce);
  const salt = await cryptoApi.subtle.digest('SHA-256', arrayBufferFrom(saltInput));
  const hkdfKey = await cryptoApi.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const sessionKey = await cryptoApi.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('openclaw-relay-v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { sessionKey, gatewayNonce };
}

function createMockRelayServer() {
  const connections = new Set();
  let gatewayIdentity;
  let expectedChannelHash;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const filePath = resolve(CLIENT_ROOT, `.${pathname}`);
      if (!filePath.startsWith(CLIENT_ROOT + '/') && filePath !== join(CLIENT_ROOT, 'index.html')) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentType(filePath) });
      res.end(data);
    } catch (error) {
      res.writeHead(error?.code === 'ENOENT' ? 404 : 500);
      res.end(error?.code === 'ENOENT' ? 'not found' : String(error));
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const session = {
      joined: false,
      cipher: null,
      clientId: '',
    };
    connections.add(ws);

    ws.on('message', (data) => {
      void handleFrame(String(data), ws, session).catch((error) => {
        console.error('[web-client-e2e] mock server error:', error);
        try { ws.close(); } catch {}
      });
    });
    ws.on('close', () => connections.delete(ws));
  });

  async function handleFrame(raw, ws, session) {
    const frame = JSON.parse(raw);

    if (frame.type === 'join') {
      assert.equal(frame.channel, expectedChannelHash, 'browser used the expected channel hash');
      session.joined = true;
      session.clientId = frame.client_id;
      ws.send(JSON.stringify({ type: 'joined', channel: frame.channel, gateway_online: true }));
      return;
    }

    assert.equal(frame.type, 'data', 'expected data frame after join');

    if (!session.cipher) {
      const hello = JSON.parse(frame.payload);
      assert.equal(hello.type, 'hello');
      const { sessionKey, gatewayNonce } = await deriveGatewaySessionKey(gatewayIdentity, hello);
      session.cipher = new SessionCipher(sessionKey, SessionCipher.DIRECTION_GATEWAY_TO_CLIENT);
      ws.send(JSON.stringify({
        type: 'data',
        from: 'gateway',
        payload: JSON.stringify({
          type: 'hello_ack',
          gateway_public_key: gatewayIdentity.publicKeyB64,
          session_nonce: b64Encode(gatewayNonce),
        }),
      }));
      return;
    }

    const message = await session.cipher.decryptObject(frame.payload);
    if (message.type !== 'request') {
      throw new Error(`unexpected message type ${message.type}`);
    }

    if (message.method === 'agents.list') {
      await sendEncrypted(ws, session.cipher, {
        id: message.id,
        type: 'response',
        result: {
          agents: [
            { name: 'scout', display_name: 'Scout', status: 'ready', description: 'Fast general help' },
            { name: 'analyst', display_name: 'Analyst', status: 'busy', description: 'Deep research' },
          ],
        },
      });
      return;
    }

    if (message.method === 'chat.send') {
      await sendEncrypted(ws, session.cipher, { id: message.id, type: 'stream_start' });
      await sendEncrypted(ws, session.cipher, { id: message.id, type: 'stream_chunk', data: { delta: 'Hello from ' } });
      await sendEncrypted(ws, session.cipher, { id: message.id, type: 'stream_chunk', data: { delta: 'browser E2E.' , session_id: SESSION_ID } });
      await sendEncrypted(ws, session.cipher, { id: message.id, type: 'stream_end' });
      await sendEncrypted(ws, session.cipher, { id: message.id, type: 'response', result: { session_id: SESSION_ID } });
      return;
    }

    throw new Error(`unexpected request method ${message.method}`);
  }

  async function sendEncrypted(ws, cipher, payload) {
    ws.send(JSON.stringify({
      type: 'data',
      from: 'gateway',
      payload: await cipher.encryptObject(payload),
    }));
  }

  return {
    async start() {
      gatewayIdentity = await createGatewayIdentity();
      expectedChannelHash = await sha256Hex(CHANNEL_TOKEN);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = address.port;
      return {
        origin: `http://127.0.0.1:${port}`,
        relayUrl: `ws://127.0.0.1:${port}`,
        gatewayPubKey: gatewayIdentity.publicKeyB64,
      };
    },
    async stop() {
      for (const ws of connections) {
        try { ws.close(); } catch {}
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function run() {
  const chromePath = await resolveChromePath();
  const mock = createMockRelayServer();
  const runtime = await mock.start();
  const userDataDir = await mkdtemp(join(tmpdir(), 'openclaw-web-e2e-user-'));
  const downloadDir = await mkdtemp(join(tmpdir(), 'openclaw-web-e2e-downloads-'));

  let context;
  try {
    log('launching headless Chrome');
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: chromePath,
      headless: true,
      acceptDownloads: true,
      downloadsPath: downloadDir,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__testDialogs = [];
      window.confirm = (message) => {
        window.__testDialogs.push(String(message));
        return true;
      };
    });
    const response = await page.goto(`${runtime.origin}/index.html`, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200, 'browser should load the client page');
    try {
      await page.waitForSelector('#relayUrl', { timeout: 10_000 });
    } catch (error) {
      console.error('[web-client-e2e] page url:', page.url());
      console.error('[web-client-e2e] page content snippet:', (await page.content()).slice(0, 500));
      throw error;
    }

    log('rejecting a mismatched pinned gateway key');
    await page.fill('#relayUrl', runtime.relayUrl);
    await page.fill('#channelToken', CHANNEL_TOKEN);
    await page.fill('#gatewayPubKey', makeMismatchedPinnedKey(runtime.gatewayPubKey));
    await page.click('#connectBtn');
    await page.waitForFunction(() => {
      const errorEl = document.getElementById('connectError');
      return errorEl.style.display === 'block' && errorEl.textContent.includes('Gateway public key does not match');
    });
    assert.equal(
      await page.evaluate(() => document.getElementById('connectPanel').style.display !== 'none'),
      true,
      'mismatched pinned gateway key should keep the connect panel visible',
    );

    log('connecting the browser client');
    await page.fill('#relayUrl', runtime.relayUrl);
    await page.fill('#channelToken', CHANNEL_TOKEN);
    await page.fill('#gatewayPubKey', runtime.gatewayPubKey);
    await page.click('#connectBtn');
    await page.waitForFunction(() => document.getElementById('chatPanel').classList.contains('active'));
    await page.waitForFunction(() => document.getElementById('agentSelect').options.length >= 2);

    const fingerprintBeforeReload = await page.locator('#identityFingerprint').evaluate((el) => el.title);
    assert.match(fingerprintBeforeReload, /^sha256:/, 'browser exposes the client fingerprint');

    log('sending a streamed chat request');
    await page.selectOption('#agentSelect', 'analyst');
    await page.fill('#messageInput', 'Ping from browser E2E');
    await page.click('#sendBtn');
    await page.waitForFunction(() => document.getElementById('messages').textContent.includes('Hello from browser E2E.'));
    await page.click('#connDetailsToggle');
    await page.waitForFunction(() => document.getElementById('detailSession').textContent === 'sess_browser_e2e');
    await page.waitForFunction(() => document.getElementById('detailProfile').textContent === 'Custom / unsaved');

    log('exporting the current transcript');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportChatBtn'),
    ]);
    const downloadPath = join(downloadDir, 'chat-export.json');
    await download.saveAs(downloadPath);
    const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
    assert.equal(exported.sessionId, SESSION_ID, 'export keeps the active session id');
    assert.equal(exported.clientId?.startsWith('web_'), true, 'export includes the client id');
    assert.equal(exported.messages.some((entry) => entry.role === 'user' && entry.text === 'Ping from browser E2E'), true, 'export includes the user message');
    assert.equal(exported.messages.some((entry) => entry.role === 'assistant' && entry.text.includes('Hello from browser E2E.')), true, 'export includes the assistant transcript');

    log('reloading and verifying persisted browser identity');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('connectPanel').style.display !== 'none');
    assert.equal(await page.inputValue('#relayUrl'), `${runtime.relayUrl}/ws`, 'relay url persists across reload');
    assert.equal(await page.inputValue('#gatewayPubKey'), runtime.gatewayPubKey, 'gateway key persists across reload');
    assert.equal(await page.inputValue('#channelToken'), '', 'channel token is not persisted');
    const persistedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('openclaw-relay-settings') || '{}'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(persistedSettings, 'channelToken'),
      false,
      'channel token is absent from persisted settings',
    );
    const fingerprintAfterReload = await page.locator('#identityFingerprint').evaluate((el) => el.title);
    assert.equal(fingerprintAfterReload, fingerprintBeforeReload, 'fingerprint stays stable across reload');

    log('exporting a protected identity backup');
    const identityPassphrase = 'browser-e2e-passphrase';
    await page.click('#identityToggle');
    await page.fill('#identityPassphrase', identityPassphrase);
    const [identityDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportIdentityBtn'),
    ]);
    const identityDownloadPath = join(downloadDir, 'identity.protected.json');
    await identityDownload.saveAs(identityDownloadPath);
    const protectedIdentity = JSON.parse(await readFile(identityDownloadPath, 'utf8'));
    assert.equal(protectedIdentity.encrypted, true, 'identity export should be protected');
    assert.equal(typeof protectedIdentity.ciphertext, 'string', 'protected identity should include ciphertext');
    assert.equal(await page.inputValue('#identityPassphrase'), '', 'identity export clears the passphrase field');

    log('resetting the identity and verifying rotation');
    await captureConfirm(page, () => page.click('#resetIdentityBtn'), /Reset/i);
    await page.waitForFunction(() => document.getElementById('identityMode').textContent === 'Not created yet');
    await page.fill('#channelToken', CHANNEL_TOKEN);
    await page.click('#connectBtn');
    await page.waitForFunction(() => document.getElementById('chatPanel').classList.contains('active'));
    const rotatedFingerprint = await getIdentityFingerprint(page);
    assert.notEqual(rotatedFingerprint, fingerprintBeforeReload, 'reset should rotate the browser identity');

    log('disconnecting and importing the protected identity backup');
    await page.click('#disconnectBtn');
    await page.waitForFunction(() => document.getElementById('connectPanel').style.display !== 'none');
    await page.fill('#identityPassphrase', identityPassphrase);
    await captureConfirm(
      page,
      () => page.setInputFiles('#identityImportInput', identityDownloadPath),
      /replace the current browser identity/i,
    );
    await waitForIdentityFingerprint(page, fingerprintBeforeReload);
    assert.equal(await page.locator('#identityFingerprint').evaluate((el) => el.title), fingerprintBeforeReload, 'identity import restores the original fingerprint');
    assert.equal(await page.inputValue('#identityPassphrase'), '', 'identity import clears the passphrase field');

    log('reconnecting and restoring the preferred agent');
    await page.fill('#channelToken', CHANNEL_TOKEN);
    await page.click('#connectBtn');
    await page.waitForFunction(() => document.getElementById('chatPanel').classList.contains('active'));
    await page.waitForFunction(() => document.getElementById('agentSelect').options.length >= 2);
    assert.equal(await page.inputValue('#agentSelect'), 'analyst', 'preferred agent is restored after reconnect');
    assert.equal(await getIdentityFingerprint(page), fingerprintBeforeReload, 'reimported identity stays active after reconnect');

    log('browser E2E passed');
  } finally {
    if (context) await context.close();
    await mock.stop().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((error) => {
  console.error('\n[web-client-e2e] failed');
  console.error(error);
  process.exitCode = 1;
});
