import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(value);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
if (!mode || !['pair', 'request'].includes(mode)) {
  throw new Error('usage: node scripts/e2e-relay-client.mjs <pair|request> --config <path> --identity-file <path> [--client-id <id>] [--timeout-ms <n>]');
}

const configPath = resolve(String(args.config ?? ''));
const identityPath = resolve(String(args['identity-file'] ?? ''));
const clientId = String(args['client-id'] ?? 'smoke-client');
const timeoutMsRaw = Number(args['timeout-ms'] ?? 10_000);
const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 10_000;
if (!configPath || !identityPath) {
  throw new Error('--config and --identity-file are required');
}

const b64Encode = (bytes) => Buffer.from(bytes).toString('base64');
const b64Decode = (value) => new Uint8Array(Buffer.from(value, 'base64'));
const arrayBufferFrom = (value) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
const concat = (...arrays) => {
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
};
const buildNonce = (direction, counter) => {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, direction);
  view.setUint32(4, Math.floor(counter / 0x100000000));
  view.setUint32(8, counter >>> 0);
  return nonce;
};

async function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256Fingerprint(bytes) {
  return `sha256:${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`;
}

class MessageQueue {
  constructor(ws) {
    this.items = [];
    this.waiters = [];
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.items.push(frame);
    });
  }

  async next(timeout = timeoutMs) {
    if (this.items.length > 0) return this.items.shift();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }
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

  async encryptText(value) {
    const nonce = buildNonce(this.sendDirection, this.sendCounter++);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
      this.sessionKey,
      new TextEncoder().encode(value),
    );
    return b64Encode(concat(nonce, new Uint8Array(ciphertext)));
  }

  async decryptToText(payload) {
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
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
      this.sessionKey,
      arrayBufferFrom(raw.slice(12)),
    );
    if (counter > this.recvCounterMax) this.recvCounterMax = counter;
    this.recvWindow.add(counter);
    return new TextDecoder().decode(plaintext);
  }
}

function normalizeIdentity(identity) {
  const candidate = identity?.identity && typeof identity.identity === 'object'
    ? identity.identity
    : identity;
  const privateKey = candidate.privateKey || candidate.privateKeyPkcs8;
  if (!candidate?.publicKey || !privateKey) {
    throw new Error('identity file must provide publicKey and private key material');
  }
  return {
    publicKey: candidate.publicKey,
    privateKey,
    fingerprint: candidate.fingerprint || '',
  };
}

async function loadOrCreateIdentity(path) {
  if (existsSync(path)) {
    const identity = normalizeIdentity(JSON.parse(await readFile(path, 'utf-8')));
    const publicKeyBytes = b64Decode(identity.publicKey);
    const privateKey = await crypto.subtle.importKey('pkcs8', arrayBufferFrom(b64Decode(identity.privateKey)), { name: 'X25519' }, true, ['deriveBits']);
    return { ...identity, publicKeyBytes, privateKey };
  }

  const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const identity = {
    publicKey: b64Encode(publicKeyBytes),
    privateKey: b64Encode(privateKeyBytes),
    fingerprint: await sha256Fingerprint(publicKeyBytes),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(identity, null, 2)}
`);
  return { ...identity, publicKeyBytes, privateKey: keyPair.privateKey };
}


const config = JSON.parse(await readFile(configPath, 'utf-8'));
const account = config.channels?.relay?.accounts?.default;
if (!account) throw new Error('relay default account missing');
const identity = await loadOrCreateIdentity(identityPath);
const channel = await sha256Hex(account.channelToken);

const ws = new WebSocket(account.server);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true });
  ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
});
const queue = new MessageQueue(ws);

ws.send(JSON.stringify({ type: 'join', channel, version: 1, client_id: clientId }));
const joined = await queue.next();
if (joined.type !== 'joined' || joined.gateway_online !== true) {
  throw new Error(`unexpected joined frame: ${JSON.stringify(joined)}`);
}

const clientNonce = crypto.getRandomValues(new Uint8Array(32));
ws.send(JSON.stringify({
  type: 'data',
  to: 'gateway',
  payload: JSON.stringify({
    type: 'hello',
    client_public_key: identity.publicKey,
    session_nonce: b64Encode(clientNonce),
    protocol_version: 1,
    capabilities: ['system'],
  }),
}));

let helloAckFrame;
while (true) {
  const frame = await queue.next();
  if (frame.type === 'presence' && frame.role === 'gateway' && frame.status === 'offline') {
    throw new Error('gateway went offline during handshake');
  }
  if (frame.type === 'data') {
    helloAckFrame = frame;
    break;
  }
}
if (helloAckFrame.from !== 'gateway') {
  throw new Error(`expected hello_ack from gateway, got ${JSON.stringify(helloAckFrame)}`);
}
const helloAck = JSON.parse(helloAckFrame.payload);
if (helloAck.type !== 'hello_ack') {
  throw new Error(`unexpected hello ack payload: ${helloAckFrame.payload}`);
}

const gatewayPublicKeyBytes = b64Decode(helloAck.gateway_public_key);
const gatewayNonce = b64Decode(helloAck.session_nonce);
const gatewayPublicKey = await crypto.subtle.importKey('raw', arrayBufferFrom(gatewayPublicKeyBytes), { name: 'X25519' }, true, []);
const sharedSecret = await crypto.subtle.deriveBits({ name: 'X25519', public: gatewayPublicKey }, identity.privateKey, 256);
const saltInput = concat(identity.publicKeyBytes, gatewayPublicKeyBytes, clientNonce, gatewayNonce);
const salt = await crypto.subtle.digest('SHA-256', arrayBufferFrom(saltInput));
const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
const sessionKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('openclaw-relay-v1') },
  hkdfKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
);
const cipher = new SessionCipher(sessionKey, SessionCipher.DIRECTION_CLIENT_TO_GATEWAY);

if (mode === 'pair') {
  console.log(JSON.stringify({ ok: true, pairedHandshake: true, clientId, fingerprint: identity.fingerprint }, null, 2));
  ws.close();
  process.exit(0);
}

const payload = await cipher.encryptText(JSON.stringify({
  id: 'msg_1',
  type: 'request',
  method: 'system.status',
  params: {},
}));
ws.send(JSON.stringify({ type: 'data', to: 'gateway', payload }));

let responseFrame;
while (true) {
  const frame = await queue.next();
  if (frame.type === 'presence' && frame.role === 'gateway' && frame.status === 'offline') {
    throw new Error('gateway went offline before response');
  }
  if (frame.type === 'data') {
    responseFrame = frame;
    break;
  }
}
if (responseFrame.from !== 'gateway') {
  throw new Error(`expected response from gateway, got ${JSON.stringify(responseFrame)}`);
}
const response = JSON.parse(await cipher.decryptToText(responseFrame.payload));
if (response.type !== 'response' || !response.result) {
  throw new Error(`unexpected response: ${JSON.stringify(response)}`);
}
console.log(JSON.stringify({ ok: true, version: response.result.version, channels: response.result.channels, clientId, fingerprint: identity.fingerprint }, null, 2));
ws.close();
