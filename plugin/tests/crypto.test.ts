import { describe, expect, it } from 'vitest';
import { arrayBufferFrom } from '../src/utils.js';
import { buildNonce, deriveGatewaySession, generateGatewayIdentity, SessionCipher } from '../src/crypto.js';

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

describe('plugin crypto', () => {
  it('generates importable gateway identity', async () => {
    const identity = await generateGatewayIdentity();
    expect(identity.publicKeyBytes).toBeInstanceOf(Uint8Array);
    expect(identity.publicKeyBytes.length).toBe(32);
    expect(identity.serialized.privateKey.length).toBeGreaterThan(10);
    expect(identity.serialized.publicKey.length).toBeGreaterThan(10);
  });

  it('derives matching session keys for gateway and client', async () => {
    const gateway = await generateGatewayIdentity();
    const clientKeyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const clientPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', clientKeyPair.publicKey));
    const clientNonce = crypto.getRandomValues(new Uint8Array(32));

    const { gatewayNonce, cipher: gatewayCipher } = await deriveGatewaySession(gateway, clientPublicKeyBytes, clientNonce);
    const clientCipher = await deriveClientCipher(gateway.publicKeyBytes, gatewayNonce, clientNonce, clientKeyPair, clientPublicKeyBytes);

    const encrypted = await clientCipher.encryptText(JSON.stringify({ ok: true }));
    const decrypted = await gatewayCipher.decryptToText(encrypted);
    expect(JSON.parse(decrypted)).toEqual({ ok: true });
  });

  it('rejects wrong nonce direction', async () => {
    const gateway = await generateGatewayIdentity();
    const clientKeyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const clientPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', clientKeyPair.publicKey));
    const clientNonce = crypto.getRandomValues(new Uint8Array(32));

    const { gatewayNonce, cipher: gatewayCipher } = await deriveGatewaySession(gateway, clientPublicKeyBytes, clientNonce);
    await deriveClientCipher(gateway.publicKeyBytes, gatewayNonce, clientNonce, clientKeyPair, clientPublicKeyBytes);

    const encrypted = await gatewayCipher.encryptText('gateway-send-frame');
    await expect(gatewayCipher.decryptToText(encrypted)).rejects.toThrow('Wrong nonce direction');
  });

  it('builds a 12-byte directional nonce', () => {
    const nonce = buildNonce(2, 42);
    expect(nonce).toHaveLength(12);
    const view = new DataView(nonce.buffer);
    expect(view.getUint32(0)).toBe(2);
    expect(view.getUint32(8)).toBe(42);
  });
});
