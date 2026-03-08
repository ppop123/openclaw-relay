import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const cryptoApi = globalThis.crypto ?? webcrypto;
const requireFromPlugin = createRequire(new URL('../plugin/package.json', import.meta.url));
const { chromium } = requireFromPlugin('playwright-core');

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CLIENT_ROOT = resolve(fileURLToPath(new URL('../client/', import.meta.url)));
const RELAY_ROOT = resolve(fileURLToPath(new URL('../relay/', import.meta.url)));
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../plugin/', import.meta.url)));
const RUN_ROOT = join(ROOT, '.tmp', `web-client-live-e2e-${Date.now()}`);
const IDENTITY_FORMAT = 'openclaw-relay-browser-identity';
const E2E_CLIENT_ID = 'web_client_live_e2e';
const chromeCandidates = [
  process.env.OPENCLAW_E2E_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function log(step) {
  console.log(`\n[web-client-live-e2e] ${step}`);
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

async function sha256Fingerprint(bytes) {
  return `sha256:${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`;
}

function randomToken(bytes = 24) {
  return Buffer.from(cryptoApi.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function createX25519Identity() {
  const keyPair = await cryptoApi.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKeyBytes = new Uint8Array(await cryptoApi.subtle.exportKey('raw', keyPair.publicKey));
  const privateKeyBytes = new Uint8Array(await cryptoApi.subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    publicKey: b64Encode(publicKeyBytes),
    privateKeyPkcs8: b64Encode(privateKeyBytes),
    fingerprint: await sha256Fingerprint(publicKeyBytes),
    publicKeyBytes,
  };
}

async function writeBrowserIdentity(path) {
  const identity = await createX25519Identity();
  const now = new Date().toISOString();
  const payload = {
    format: IDENTITY_FORMAT,
    version: 1,
    algorithm: 'X25519',
    publicKey: identity.publicKey,
    privateKeyPkcs8: identity.privateKeyPkcs8,
    fingerprint: identity.fingerprint,
    createdAt: now,
    exportedAt: now,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function buildConfig({ relayPort, gatewayIdentity, browserIdentity }) {
  const now = new Date().toISOString();
  return {
    meta: {
      lastTouchedVersion: '2026.3.2',
      lastTouchedAt: now,
    },
    agents: {
      defaults: {
        compaction: { mode: 'safeguard' },
      },
    },
    commands: {
      native: 'auto',
      nativeSkills: 'auto',
      restart: true,
      ownerDisplay: 'raw',
    },
    channels: {
      relay: {
        accounts: {
          default: {
            enabled: true,
            server: `ws://127.0.0.1:${relayPort}/ws`,
            channelToken: randomToken(24),
            gatewayKeyPair: {
              privateKey: gatewayIdentity.privateKeyPkcs8,
              publicKey: gatewayIdentity.publicKey,
            },
            approvedClients: {
              [browserIdentity.fingerprint]: {
                publicKey: browserIdentity.publicKey,
                label: 'web-client-live-e2e',
                firstPairedAt: now,
                lastSeenClientId: E2E_CLIENT_ID,
                lastSeenAt: now,
              },
            },
          },
        },
      },
    },
    gateway: {
      auth: {
        mode: 'none',
      },
    },
    plugins: {
      load: {
        paths: [PLUGIN_ROOT],
      },
      entries: {
        relay: { enabled: true },
      },
      installs: {
        relay: {
          source: 'path',
          sourcePath: PLUGIN_ROOT,
          installPath: PLUGIN_ROOT,
          version: '0.1.0',
          installedAt: now,
        },
      },
    },
  };
}

function startStaticServer() {
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
  return {
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function spawnLoggedProcess(name, command, args, { cwd, env, logPath }) {
  const stream = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.on('exit', (code, signal) => {
    stream.write(`\n[${name}] exited code=${code} signal=${signal}\n`);
    stream.end();
  });
  return child;
}

async function stopChild(child, signal = 'SIGINT') {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(10_000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function waitForHttp(url, attempts = 60) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

async function runPreflight(configPath, identityPath, attempts = 30) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    const result = await new Promise((resolve) => {
      const child = spawn('node', [
        join(ROOT, 'scripts', 'e2e-relay-client.mjs'),
        'request',
        '--config', configPath,
        '--identity-file', identityPath,
        '--client-id', E2E_CLIENT_ID,
        '--timeout-ms', '5000',
      ], {
        cwd: ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });

    if (result.code === 0) {
      return JSON.parse(result.stdout);
    }
    lastError = new Error(result.stderr || result.stdout || 'preflight failed');
    await delay(1000);
  }
  throw lastError || new Error('preflight request failed');
}

async function callSystemStatus(page) {
  return page.evaluate(async () => {
    return await window.app.connection.sendRequest('system.status', {});
  });
}

async function run() {
  await mkdir(RUN_ROOT, { recursive: true });
  const relayPort = await allocatePort();
  const gatewayPort = await allocatePort();
  const chromePath = await resolveChromePath();
  const configPath = join(RUN_ROOT, 'openclaw.json');
  const stateDir = join(RUN_ROOT, 'openclaw-state');
  const browserIdentityPath = join(RUN_ROOT, 'browser-identity.json');
  const relayLog = join(RUN_ROOT, 'relay.log');
  const gatewayLog = join(RUN_ROOT, 'gateway.log');
  const userDataDir = await mkdir(join(RUN_ROOT, 'chrome-profile'), { recursive: true }).then(() => join(RUN_ROOT, 'chrome-profile'));
  const downloadDir = await mkdir(join(RUN_ROOT, 'downloads'), { recursive: true }).then(() => join(RUN_ROOT, 'downloads'));

  const gatewayIdentity = await createX25519Identity();
  const browserIdentity = await writeBrowserIdentity(browserIdentityPath);
  const config = buildConfig({ relayPort, gatewayIdentity, browserIdentity });
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const staticServer = startStaticServer();
  const pageOrigin = await staticServer.start();
  const pageOriginHost = new URL(pageOrigin).host;
  const relay = spawnLoggedProcess('relay', 'go', ['run', '.', '-port', String(relayPort), '-tls', 'off', '--allow-origin', pageOriginHost], {
    cwd: RELAY_ROOT,
    env: {},
    logPath: relayLog,
  });

  let gateway;
  let context;
  try {
    log(`starting relay on :${relayPort}`);
    await waitForHttp(`http://127.0.0.1:${relayPort}/status`);

    gateway = spawnLoggedProcess('gateway', 'openclaw', ['gateway', 'run', '--allow-unconfigured', '--port', String(gatewayPort), '--auth', 'none', '--verbose'], {
      cwd: ROOT,
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      logPath: gatewayLog,
    });

    log('waiting for a real encrypted preflight request');
    const preflight = await runPreflight(configPath, browserIdentityPath);
    assert.equal(preflight.ok, true, 'live preflight should succeed');

    log('launching headless Chrome');
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: chromePath,
      headless: true,
      acceptDownloads: true,
      downloadsPath: downloadDir,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
    });

    const page = await context.newPage();
    const response = await page.goto(`${pageOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200, 'browser should load the live client page');
    await page.waitForSelector('#relayUrl', { timeout: 10_000 });

    log('importing the pre-approved browser identity');
    await page.setInputFiles('#identityImportInput', browserIdentityPath);
    await page.waitForFunction((fp) => window.app.connection.identityFingerprint === fp, browserIdentity.fingerprint);

    log('connecting through the real relay and gateway');
    await page.fill('#relayUrl', `ws://127.0.0.1:${relayPort}`);
    await page.fill('#channelToken', config.channels.relay.accounts.default.channelToken);
    await page.fill('#gatewayPubKey', gatewayIdentity.publicKey);
    await page.click('#connectBtn');
    await page.waitForFunction(() => window.app.connection.state === 'connected');
    assert.equal(await page.evaluate(() => window.app.connection.identityFingerprint), browserIdentity.fingerprint, 'browser should use the seeded approved identity');

    const liveStatus = await callSystemStatus(page);
    assert.equal(typeof liveStatus?.version, 'string', 'system.status should return a version');

    log('reloading and reconnecting with the same persisted identity');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction((fp) => window.app.connection.identityFingerprint === fp, browserIdentity.fingerprint);
    assert.equal(await page.inputValue('#channelToken'), '', 'live browser must not persist channelToken');
    await page.fill('#channelToken', config.channels.relay.accounts.default.channelToken);
    await page.click('#connectBtn');
    await page.waitForFunction(() => window.app.connection.state === 'connected');
    const liveStatusAfterReload = await callSystemStatus(page);
    assert.equal(typeof liveStatusAfterReload?.version, 'string', 'system.status should still work after reload');

    log('live browser E2E passed');
    console.log(`\n[web-client-live-e2e] artifacts: ${RUN_ROOT}`);
  } finally {
    if (context) await context.close().catch(() => {});
    await stopChild(gateway).catch(() => {});
    await stopChild(relay).catch(() => {});
    await staticServer.stop().catch(() => {});
  }
}

run().catch((error) => {
  console.error('\n[web-client-live-e2e] failed');
  console.error(error);
  console.error(`[web-client-live-e2e] artifacts: ${RUN_ROOT}`);
  process.exitCode = 1;
});
