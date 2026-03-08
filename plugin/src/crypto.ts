import { GatewayKeyPairConfig } from './types.js';
import { arrayBufferFrom, b64Decode, b64Encode, concatBuffers, publicKeyFingerprint } from './utils.js';

const REPLAY_WINDOW = 64;
const HKDF_INFO = new TextEncoder().encode('openclaw-relay-v1');

export interface GatewayIdentity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  serialized: GatewayKeyPairConfig;
}

function x25519Algorithm(): AlgorithmIdentifier {
  return { name: 'X25519' };
}

async function generateX25519KeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(x25519Algorithm(), true, ['deriveBits']) as Promise<CryptoKeyPair>;
}

export class SessionCipher {
  static readonly DIRECTION_CLIENT_TO_GATEWAY = 1;
  static readonly DIRECTION_GATEWAY_TO_CLIENT = 2;

  private readonly sessionKey: CryptoKey;
  private readonly sendDirection: number;
  private readonly recvDirection: number;
  private sendCounter = 0;
  private recvCounterMax = -1;
  private readonly recvWindow = new Set<number>();

  constructor(sessionKey: CryptoKey, sendDirection: number) {
    this.sessionKey = sessionKey;
    this.sendDirection = sendDirection;
    this.recvDirection = sendDirection === SessionCipher.DIRECTION_GATEWAY_TO_CLIENT
      ? SessionCipher.DIRECTION_CLIENT_TO_GATEWAY
      : SessionCipher.DIRECTION_GATEWAY_TO_CLIENT;
  }

  async encryptJson(value: Record<string, unknown>): Promise<string> {
    return this.encryptText(JSON.stringify(value));
  }

  async encryptText(value: string): Promise<string> {
    const nonce = buildNonce(this.sendDirection, this.sendCounter++);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
      this.sessionKey,
      new TextEncoder().encode(value),
    );
    return b64Encode(concatBuffers(nonce, new Uint8Array(ciphertext)));
  }

  async decryptToText(payload: string): Promise<string> {
    const raw = b64Decode(payload);
    if (raw.length < 12 + 16) {
      throw new Error('Ciphertext too short');
    }

    const nonce = raw.slice(0, 12);
    const view = new DataView(arrayBufferFrom(nonce));
    const direction = view.getUint32(0);
    if (direction !== this.recvDirection) {
      throw new Error(`Wrong nonce direction: expected ${this.recvDirection}, got ${direction}`);
    }

    const counter = view.getUint32(4) * 0x100000000 + view.getUint32(8);
    if (this.recvCounterMax >= 0) {
      if (counter <= this.recvCounterMax - REPLAY_WINDOW) {
        throw new Error('Replay detected: counter too old');
      }
      if (counter <= this.recvCounterMax && this.recvWindow.has(counter)) {
        throw new Error('Replay detected: duplicate counter');
      }
    }

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
      this.sessionKey,
      arrayBufferFrom(raw.slice(12)),
    );

    if (counter > this.recvCounterMax) {
      this.recvCounterMax = counter;
    }
    this.recvWindow.add(counter);
    const cutoff = this.recvCounterMax - REPLAY_WINDOW;
    for (const seen of [...this.recvWindow]) {
      if (seen <= cutoff) this.recvWindow.delete(seen);
    }

    return new TextDecoder().decode(plaintext);
  }
}

export async function generateGatewayIdentity(): Promise<GatewayIdentity> {
  const keyPair = await generateX25519KeyPair();
  const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes,
    serialized: {
      privateKey: b64Encode(privateKeyBytes),
      publicKey: b64Encode(publicKeyBytes),
    },
  };
}

export async function importGatewayIdentity(config: GatewayKeyPairConfig): Promise<GatewayIdentity> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    arrayBufferFrom(b64Decode(config.privateKey)),
    x25519Algorithm(),
    true,
    ['deriveBits'],
  );
  const publicKeyBytes = b64Decode(config.publicKey);
  const publicKey = await crypto.subtle.importKey(
    'raw',
    arrayBufferFrom(publicKeyBytes),
    x25519Algorithm(),
    true,
    [],
  );
  return {
    privateKey,
    publicKey,
    publicKeyBytes,
    serialized: config,
  };
}

export async function deriveGatewaySession(identity: GatewayIdentity, clientPublicKeyBytes: Uint8Array, clientNonce: Uint8Array) {
  const gatewayNonce = crypto.getRandomValues(new Uint8Array(32));
  const clientPublicKey = await crypto.subtle.importKey('raw', arrayBufferFrom(clientPublicKeyBytes), x25519Algorithm(), true, []);
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: clientPublicKey },
    identity.privateKey,
    256,
  );

  const saltInput = concatBuffers(
    clientPublicKeyBytes,
    identity.publicKeyBytes,
    clientNonce,
    gatewayNonce,
  );
  const salt = await crypto.subtle.digest('SHA-256', arrayBufferFrom(saltInput));
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const sessionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: HKDF_INFO,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return {
    gatewayNonce,
    cipher: new SessionCipher(sessionKey, SessionCipher.DIRECTION_GATEWAY_TO_CLIENT),
  };
}

export function buildNonce(direction: number, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, direction);
  view.setUint32(4, Math.floor(counter / 0x100000000));
  view.setUint32(8, counter >>> 0);
  return nonce;
}

export async function fingerprintFromPublicKeyBase64(publicKey: string): Promise<string> {
  return publicKeyFingerprint(b64Decode(publicKey));
}
