/**
 * Browser persistence for the web client's long-lived X25519 identity.
 *
 * This store keeps only the browser identity keypair material needed to
 * preserve the same cryptographic client identity across page reloads.
 * Session keys and channel secrets are never persisted here.
 */

export const IDENTITY_DB_NAME = 'openclaw-relay-browser';
export const IDENTITY_DB_VERSION = 1;
export const IDENTITY_STORE_NAME = 'identity';
export const IDENTITY_RECORD_ID = 'default';

function isIndexedDbSupported() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null && typeof indexedDB.open === 'function';
}

export function supportsPersistentIdentity() {
  return isIndexedDbSupported();
}

function fail(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  return error;
}

function normalizeIdentityRecord(record) {
  if (!record || typeof record !== 'object') {
    throw fail('Identity record must be an object');
  }
  if (typeof record.publicKey !== 'string' || !record.publicKey) {
    throw fail('Identity record missing publicKey');
  }
  if (typeof record.privateKeyPkcs8 !== 'string' || !record.privateKeyPkcs8) {
    throw fail('Identity record missing privateKeyPkcs8');
  }
  if (typeof record.fingerprint !== 'string' || !record.fingerprint) {
    throw fail('Identity record missing fingerprint');
  }

  const now = new Date().toISOString();
  return {
    id: IDENTITY_RECORD_ID,
    version: 1,
    algorithm: 'X25519',
    publicKey: record.publicKey,
    privateKeyPkcs8: record.privateKeyPkcs8,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
}

async function openIdentityDb() {
  if (!isIndexedDbSupported()) return null;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDENTITY_DB_NAME, IDENTITY_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE_NAME)) {
        db.createObjectStore(IDENTITY_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(fail('Failed to open identity store', request.error));
  });
}

export async function loadStoredIdentity() {
  const db = await openIdentityDb();
  if (!db) return null;

  const closeDb = () => {
    try {
      db.close();
    } catch {}
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE_NAME, 'readonly');
    const store = tx.objectStore(IDENTITY_STORE_NAME);
    const request = store.get(IDENTITY_RECORD_ID);

    tx.oncomplete = () => closeDb();
    tx.onabort = () => {
      closeDb();
      reject(fail('Identity store transaction aborted', tx.error));
    };
    tx.onerror = () => {
      closeDb();
      reject(fail('Identity store transaction failed', tx.error));
    };

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => {
      closeDb();
      reject(fail('Failed to read stored identity', request.error));
    };
  });
}

export async function saveStoredIdentity(record) {
  if (!isIndexedDbSupported()) {
    throw fail('Persistent identity storage is unavailable in this browser');
  }

  const next = normalizeIdentityRecord(record);
  const db = await openIdentityDb();
  if (!db) {
    throw fail('Persistent identity storage is unavailable in this browser');
  }

  const closeDb = () => {
    try {
      db.close();
    } catch {}
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDENTITY_STORE_NAME);
    const request = store.put(next);

    tx.oncomplete = () => {
      closeDb();
      resolve(next);
    };
    tx.onabort = () => {
      closeDb();
      reject(fail('Identity store transaction aborted', tx.error));
    };
    tx.onerror = () => {
      closeDb();
      reject(fail('Identity store transaction failed', tx.error));
    };
    request.onerror = () => {
      closeDb();
      reject(fail('Failed to save identity', request.error));
    };
  });
}

export async function deleteStoredIdentity() {
  if (!isIndexedDbSupported()) return false;

  const db = await openIdentityDb();
  if (!db) return false;

  const closeDb = () => {
    try {
      db.close();
    } catch {}
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDENTITY_STORE_NAME);
    const request = store.delete(IDENTITY_RECORD_ID);

    tx.oncomplete = () => {
      closeDb();
      resolve(true);
    };
    tx.onabort = () => {
      closeDb();
      reject(fail('Identity store transaction aborted', tx.error));
    };
    tx.onerror = () => {
      closeDb();
      reject(fail('Identity store transaction failed', tx.error));
    };
    request.onerror = () => {
      closeDb();
      reject(fail('Failed to delete identity', request.error));
    };
  });
}
