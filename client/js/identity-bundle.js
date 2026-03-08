import { b64Decode, b64Encode } from './utils.js';

export const PROTECTED_IDENTITY_FORMAT = 'openclaw-relay-browser-identity';
export const PROTECTED_IDENTITY_VERSION = 2;
export const PROTECTED_IDENTITY_KDF_ITERATIONS = 200000;

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('A passphrase is required for this identity file');
  }
}

async function deriveBundleKey(passphrase, salt, iterations = PROTECTED_IDENTITY_KDF_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isProtectedIdentityBundle(bundle) {
  return Boolean(bundle && typeof bundle === 'object' && bundle.encrypted === true);
}

export async function protectIdentityBundle(bundle, passphrase) {
  requirePassphrase(passphrase);

  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Identity bundle must be an object');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBundleKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );

  return {
    format: PROTECTED_IDENTITY_FORMAT,
    version: PROTECTED_IDENTITY_VERSION,
    encrypted: true,
    algorithm: bundle.algorithm || 'X25519',
    fingerprint: bundle.fingerprint || '',
    createdAt: bundle.createdAt || '',
    exportedAt: new Date().toISOString(),
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PROTECTED_IDENTITY_KDF_ITERATIONS,
      salt: b64Encode(salt),
    },
    cipher: {
      name: 'AES-GCM',
      iv: b64Encode(iv),
    },
    ciphertext: b64Encode(new Uint8Array(ciphertext)),
  };
}

export async function unprotectIdentityBundle(bundle, passphrase) {
  if (!isProtectedIdentityBundle(bundle)) {
    return bundle;
  }

  requirePassphrase(passphrase);

  if (bundle.format !== PROTECTED_IDENTITY_FORMAT) {
    throw new Error('Unsupported identity file format');
  }

  if ((bundle.version ?? 0) > PROTECTED_IDENTITY_VERSION) {
    throw new Error('Identity file version is newer than this client supports');
  }

  const iterations = bundle.kdf?.iterations;
  const saltB64 = bundle.kdf?.salt;
  const ivB64 = bundle.cipher?.iv;
  const ciphertextB64 = bundle.ciphertext;

  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('Identity file is missing PBKDF2 parameters');
  }
  if (typeof saltB64 !== 'string' || !saltB64) {
    throw new Error('Identity file is missing PBKDF2 salt');
  }
  if (typeof ivB64 !== 'string' || !ivB64) {
    throw new Error('Identity file is missing AES-GCM IV');
  }
  if (typeof ciphertextB64 !== 'string' || !ciphertextB64) {
    throw new Error('Identity file is missing ciphertext');
  }

  const key = await deriveBundleKey(passphrase, b64Decode(saltB64), iterations);

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64Decode(ivB64) },
      key,
      b64Decode(ciphertextB64),
    );
  } catch {
    throw new Error('Identity file passphrase is incorrect or the file is corrupted');
  }

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Decrypted identity file is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Decrypted identity file must contain an object');
  }

  return parsed;
}
