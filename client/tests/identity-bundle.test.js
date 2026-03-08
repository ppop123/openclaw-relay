import { describe, expect, it } from 'vitest';

import {
  isProtectedIdentityBundle,
  protectIdentityBundle,
  PROTECTED_IDENTITY_FORMAT,
  PROTECTED_IDENTITY_VERSION,
  unprotectIdentityBundle,
} from '../js/identity-bundle.js';

const plainBundle = {
  format: 'openclaw-relay-browser-identity',
  version: 1,
  algorithm: 'X25519',
  publicKey: 'PUB',
  privateKeyPkcs8: 'PRIV',
  fingerprint: 'sha256:testfingerprint',
  createdAt: '2026-03-08T00:00:00.000Z',
};

describe('identity-bundle protection helpers', () => {
  it('encrypts and decrypts an identity bundle with a passphrase', async () => {
    const protectedBundle = await protectIdentityBundle(plainBundle, 'top-secret');
    const decrypted = await unprotectIdentityBundle(protectedBundle, 'top-secret');

    expect(protectedBundle).toMatchObject({
      format: PROTECTED_IDENTITY_FORMAT,
      version: PROTECTED_IDENTITY_VERSION,
      encrypted: true,
      fingerprint: plainBundle.fingerprint,
    });
    expect(decrypted).toEqual(plainBundle);
  });

  it('marks protected bundles explicitly', async () => {
    const protectedBundle = await protectIdentityBundle(plainBundle, 'top-secret');

    expect(isProtectedIdentityBundle(protectedBundle)).toBe(true);
    expect(isProtectedIdentityBundle(plainBundle)).toBe(false);
  });

  it('rejects decryption with the wrong passphrase', async () => {
    const protectedBundle = await protectIdentityBundle(plainBundle, 'top-secret');

    await expect(unprotectIdentityBundle(protectedBundle, 'wrong-passphrase'))
      .rejects.toThrow(/incorrect|corrupted/i);
  });

  it('requires a passphrase for protected bundles', async () => {
    const protectedBundle = await protectIdentityBundle(plainBundle, 'top-secret');

    await expect(unprotectIdentityBundle(protectedBundle, ''))
      .rejects.toThrow(/passphrase is required/i);
  });

  it('rejects protected bundles that weaken the PBKDF2 iteration count', async () => {
    const protectedBundle = await protectIdentityBundle(plainBundle, 'top-secret');
    protectedBundle.kdf.iterations = 1;

    await expect(unprotectIdentityBundle(protectedBundle, 'top-secret'))
      .rejects.toThrow(/iterations are too weak/i);
  });
});
