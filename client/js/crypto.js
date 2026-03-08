/**
 * Layer 1: X25519 key exchange + AES-256-GCM encryption.
 *
 * Handles identity key generation, session key derivation via HKDF,
 * directional nonce construction, and anti-replay protection.
 */

import { b64Encode, b64Decode, concatBuffers } from './utils.js';

export { b64Encode, b64Decode };

const REPLAY_WINDOW = 64;

export class RelayCrypto {
  constructor() {
    this.keyPair = null;
    this.sessionKey = null;
    this.sendCounter = 0;
    this.recvCounterMax = -1;
    this.recvWindow = new Set();
    this.clientNonce = null;
    this.publicKeyBytes = null;
  }

  async generateKeyPair() {
    this.keyPair = await crypto.subtle.generateKey(
      { name: 'X25519' }, true, ['deriveBits']
    );
    const rawPub = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
    this.publicKeyBytes = new Uint8Array(rawPub);
    this.clientNonce = crypto.getRandomValues(new Uint8Array(32));
  }

  /**
   * Regenerate only the session nonce (for reconnections with the same identity keypair).
   * The keypair stays the same; a fresh nonce ensures a unique session key.
   */
  regenerateNonce() {
    this.clientNonce = crypto.getRandomValues(new Uint8Array(32));
  }

  async deriveSessionKey(gatewayPubKeyBytes, gatewayNonce) {
    // Import the gateway's public key
    const gatewayPubKey = await crypto.subtle.importKey(
      'raw', gatewayPubKeyBytes, { name: 'X25519' }, true, []
    );

    // X25519 ECDH
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: 'X25519', public: gatewayPubKey },
      this.keyPair.privateKey, 256
    );

    // salt = SHA-256(clientPub || gatewayPub || clientNonce || gatewayNonce)
    const saltInput = concatBuffers(
      this.publicKeyBytes,
      gatewayPubKeyBytes,
      this.clientNonce,
      gatewayNonce
    );
    const salt = await crypto.subtle.digest('SHA-256', saltInput);

    // HKDF key derivation
    const hkdfKey = await crypto.subtle.importKey(
      'raw', sharedSecret, 'HKDF', false, ['deriveKey']
    );
    this.sessionKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(salt),
        info: new TextEncoder().encode('openclaw-relay-v1')
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.sendCounter = 0;
    this.recvCounterMax = -1;
    this.recvWindow.clear();
  }

  async encrypt(plaintext) {
    const nonce = new Uint8Array(12);
    const dv = new DataView(nonce.buffer);
    dv.setUint32(0, 1); // direction: client -> gateway
    const counter = this.sendCounter++;
    const high = Math.floor(counter / 0x100000000);
    const low = counter >>> 0;
    dv.setUint32(4, high);
    dv.setUint32(8, low);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      this.sessionKey,
      new TextEncoder().encode(plaintext)
    );

    // nonce(12) || ciphertext+tag
    return b64Encode(concatBuffers(nonce, new Uint8Array(ciphertext)));
  }

  async decrypt(payload) {
    const raw = b64Decode(payload);
    if (raw.length < 12 + 16) {
      throw new Error('Ciphertext too short');
    }

    const nonce = raw.slice(0, 12);
    const ciphertextAndTag = raw.slice(12);

    // Validate direction prefix: client must receive direction 2 (gateway->client)
    const dv = new DataView(nonce.buffer, nonce.byteOffset, 12);
    const direction = dv.getUint32(0);
    if (direction !== 2) {
      throw new Error(`Wrong nonce direction: expected 2 (gw->client), got ${direction}`);
    }

    // Extract counter from nonce bytes 4-11
    const high = dv.getUint32(4);
    const low = dv.getUint32(8);
    const counter = high * 0x100000000 + low;

    // Anti-replay check
    if (this.recvCounterMax < 0) {
      if (counter !== 0) {
        throw new Error('Replay detected: first counter must be zero');
      }
    } else {
      if (counter <= this.recvCounterMax - REPLAY_WINDOW) {
        throw new Error('Replay detected: counter too old');
      }
      if (counter <= this.recvCounterMax && this.recvWindow.has(counter)) {
        throw new Error('Replay detected: duplicate counter');
      }
    }

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      this.sessionKey,
      ciphertextAndTag
    );

    // Update replay bookkeeping after successful decryption
    if (counter > this.recvCounterMax) {
      this.recvCounterMax = counter;
    }
    this.recvWindow.add(counter);
    const cutoff = this.recvCounterMax - REPLAY_WINDOW;
    for (const c of this.recvWindow) {
      if (c <= cutoff) this.recvWindow.delete(c);
    }

    return new TextDecoder().decode(plaintext);
  }
}

/**
 * Build a 12-byte GCM nonce: [4-byte direction][8-byte counter].
 * Exported for testing.
 */
export function buildNonce(direction, counter) {
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer);
  dv.setUint32(0, direction);
  dv.setUint32(4, Math.floor(counter / 0x100000000));
  dv.setUint32(8, counter >>> 0);
  return nonce;
}

/**
 * Check whether a counter passes the anti-replay window.
 * Returns 'ok', 'too_old', or 'duplicate'.
 * Exported for testing.
 */
export function checkReplay(counter, recvCounterMax, recvWindow) {
  if (recvCounterMax < 0) {
    return counter === 0 ? 'ok' : 'invalid_first_counter';
  }
  if (counter <= recvCounterMax - REPLAY_WINDOW) return 'too_old';
  if (counter <= recvCounterMax && recvWindow.has(counter)) return 'duplicate';
  return 'ok';
}
