import { b64Decode, b64Encode, concatBuffers, getWebCrypto, randomBytes, sha256Hex, toArrayBuffer } from './utils.js';

const HKDF_INFO = new TextEncoder().encode('openclaw-relay-v1');
const REPLAY_WINDOW = 64;

export const DIRECTION_CLIENT_TO_GATEWAY = 1;
export const DIRECTION_GATEWAY_TO_CLIENT = 2;

export interface RelayIdentity {
  publicKey: string;
  privateKeyPkcs8: string;
  fingerprint?: string;
  createdAt?: string;
}

export class IdentityKeyPair {
  public readonly publicKey: CryptoKey;
  public readonly privateKey: CryptoKey;
  public readonly publicKeyBytes: Uint8Array;

  private constructor(publicKey: CryptoKey, privateKey: CryptoKey, publicKeyBytes: Uint8Array) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.publicKeyBytes = publicKeyBytes;
  }

  static async generate(): Promise<IdentityKeyPair> {
    const keyPair = await getWebCrypto().subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const publicKeyBytes = new Uint8Array(await getWebCrypto().subtle.exportKey('raw', keyPair.publicKey));
    return new IdentityKeyPair(keyPair.publicKey, keyPair.privateKey, publicKeyBytes);
  }

  static async fromIdentity(identity: RelayIdentity): Promise<IdentityKeyPair> {
    if (!identity?.publicKey || !identity?.privateKeyPkcs8) {
      throw new Error('Identity payload missing publicKey/privateKeyPkcs8');
    }
    const publicKeyBytes = b64Decode(identity.publicKey);
    const privateKeyBytes = b64Decode(identity.privateKeyPkcs8);

    const [publicKey, privateKey] = await Promise.all([
      getWebCrypto().subtle.importKey('raw', toArrayBuffer(publicKeyBytes), { name: 'X25519' }, true, []),
      getWebCrypto().subtle.importKey('pkcs8', toArrayBuffer(privateKeyBytes), { name: 'X25519' }, true, ['deriveBits']),
    ]);

    return new IdentityKeyPair(publicKey, privateKey, publicKeyBytes);
  }

  async exportIdentity(): Promise<RelayIdentity> {
    const publicKey = b64Encode(this.publicKeyBytes);
    const privateKeyPkcs8 = b64Encode(new Uint8Array(await getWebCrypto().subtle.exportKey('pkcs8', this.privateKey)));
    return {
      publicKey,
      privateKeyPkcs8,
      fingerprint: await publicKeyFingerprint(this.publicKeyBytes),
      createdAt: new Date().toISOString(),
    };
  }

  async fingerprint(): Promise<string> {
    return await publicKeyFingerprint(this.publicKeyBytes);
  }
}

export async function publicKeyFingerprint(publicKeyBytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(publicKeyBytes)}`;
}

export function generateSessionNonce(): Uint8Array {
  return randomBytes(32);
}

export async function deriveSessionKey(options: {
  privateKey: CryptoKey;
  clientPublicKey: Uint8Array;
  gatewayPublicKey: Uint8Array;
  clientSessionNonce: Uint8Array;
  gatewaySessionNonce: Uint8Array;
}): Promise<CryptoKey> {
  const gatewayPubKey = await getWebCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(options.gatewayPublicKey),
    { name: 'X25519' },
    true,
    [],
  );

  const sharedSecret = await getWebCrypto().subtle.deriveBits(
    { name: 'X25519', public: gatewayPubKey },
    options.privateKey,
    256,
  );

  const saltInput = concatBuffers(
    options.clientPublicKey,
    options.gatewayPublicKey,
    options.clientSessionNonce,
    options.gatewaySessionNonce,
  );
  const salt = new Uint8Array(await getWebCrypto().subtle.digest('SHA-256', toArrayBuffer(saltInput)));

  const hkdfKey = await getWebCrypto().subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return await getWebCrypto().subtle.deriveKey(
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
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return await getWebCrypto().subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export class SessionCipher {
  private sendCounter = 0;
  private recvCounter = -1;
  private recvWindow = new Set<number>();
  private readonly recvDirection: number;

  constructor(private readonly sessionKey: CryptoKey, private readonly sendDirection: number) {
    if (![DIRECTION_CLIENT_TO_GATEWAY, DIRECTION_GATEWAY_TO_CLIENT].includes(sendDirection)) {
      throw new Error('sendDirection must be 1 (client->gateway) or 2 (gateway->client)');
    }
    this.recvDirection = sendDirection === DIRECTION_CLIENT_TO_GATEWAY
      ? DIRECTION_GATEWAY_TO_CLIENT
      : DIRECTION_CLIENT_TO_GATEWAY;
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = new Uint8Array(12);
    const dv = new DataView(nonce.buffer);
    dv.setUint32(0, this.sendDirection);
    const counter = this.sendCounter++;
    dv.setUint32(4, Math.floor(counter / 0x100000000));
    dv.setUint32(8, counter >>> 0);

    const ciphertext = await getWebCrypto().subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      this.sessionKey,
      toArrayBuffer(plaintext),
    );

    return concatBuffers(nonce, new Uint8Array(ciphertext));
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 12 + 16) {
      throw new Error('Ciphertext too short');
    }

    const nonce = data.slice(0, 12);
    const ciphertextAndTag = data.slice(12);

    const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    const direction = dv.getUint32(0);
    if (direction !== this.recvDirection) {
      throw new Error(`Wrong nonce direction prefix: expected ${this.recvDirection}, got ${direction}`);
    }

    const high = dv.getUint32(4);
    const low = dv.getUint32(8);
    const counter = high * 0x100000000 + low;

    if (this.recvCounter >= 0 || this.recvWindow.size > 0) {
      if (counter <= this.recvCounter - REPLAY_WINDOW) {
        throw new Error('Replay detected: counter too old');
      }
      if (counter <= this.recvCounter && this.recvWindow.has(counter)) {
        throw new Error('Replay detected: duplicate counter');
      }
    }

    const plaintext = await getWebCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      this.sessionKey,
      toArrayBuffer(ciphertextAndTag),
    );

    if (counter > this.recvCounter) {
      this.recvCounter = counter;
    }
    this.recvWindow.add(counter);

    const cutoff = this.recvCounter - REPLAY_WINDOW;
    for (const value of this.recvWindow) {
      if (value <= cutoff) this.recvWindow.delete(value);
    }

    return new Uint8Array(plaintext);
  }
}
