import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteStoredIdentity,
  IDENTITY_DB_NAME,
  IDENTITY_RECORD_ID,
  IDENTITY_STORE_NAME,
  loadStoredIdentity,
  saveStoredIdentity,
  supportsPersistentIdentity,
} from '../js/identity-store.js';

function createRequest(executor) {
  const request = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  };

  queueMicrotask(() => executor(request));
  return request;
}

function createFakeIndexedDb() {
  const databases = new Map();

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function createDbHandle(state) {
    return {
      objectStoreNames: {
        contains(name) {
          return state.stores.has(name);
        },
      },
      createObjectStore(name, options = {}) {
        if (!state.stores.has(name)) {
          state.stores.set(name, {
            keyPath: options.keyPath || 'id',
            records: new Map(),
          });
        }
        return {};
      },
      transaction(storeName) {
        const tx = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(name = storeName) {
            const storeState = state.stores.get(name);
            return {
              get(key) {
                return createRequest((request) => {
                  request.result = clone(storeState.records.get(key));
                  request.onsuccess?.({ target: request });
                  tx.oncomplete?.();
                });
              },
              put(value) {
                return createRequest((request) => {
                  const record = clone(value);
                  storeState.records.set(record[storeState.keyPath], record);
                  request.result = record[storeState.keyPath];
                  request.onsuccess?.({ target: request });
                  tx.oncomplete?.();
                });
              },
              delete(key) {
                return createRequest((request) => {
                  storeState.records.delete(key);
                  request.result = undefined;
                  request.onsuccess?.({ target: request });
                  tx.oncomplete?.();
                });
              },
            };
          },
        };
        return tx;
      },
      close() {},
    };
  }

  return {
    open(name, version) {
      return createRequest((request) => {
        let state = databases.get(name);
        const oldVersion = state?.version || 0;
        const targetVersion = version || 1;

        if (!state) {
          state = { version: targetVersion, stores: new Map() };
          databases.set(name, state);
        }

        request.result = createDbHandle(state);

        if (oldVersion < targetVersion) {
          state.version = targetVersion;
          request.onupgradeneeded?.({ target: request, oldVersion, newVersion: targetVersion });
        }

        request.onsuccess?.({ target: request });
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDb());
});

describe('identity-store', () => {
  it('reports support when indexedDB is available', () => {
    expect(supportsPersistentIdentity()).toBe(true);
  });

  it('saves and loads a persistent identity record', async () => {
    const saved = await saveStoredIdentity({
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
      fingerprint: 'sha256:test',
      createdAt: '2026-03-08T00:00:00.000Z',
    });

    const loaded = await loadStoredIdentity();

    expect(saved.id).toBe(IDENTITY_RECORD_ID);
    expect(saved.algorithm).toBe('X25519');
    expect(loaded).toMatchObject({
      id: IDENTITY_RECORD_ID,
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
      fingerprint: 'sha256:test',
      createdAt: '2026-03-08T00:00:00.000Z',
    });
  });

  it('deletes the stored identity record', async () => {
    await saveStoredIdentity({
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
      fingerprint: 'sha256:test',
    });

    const deleted = await deleteStoredIdentity();
    const loaded = await loadStoredIdentity();

    expect(deleted).toBe(true);
    expect(loaded).toBeNull();
  });

  it('uses the expected database layout constants', () => {
    expect(IDENTITY_DB_NAME).toBe('openclaw-relay-browser');
    expect(IDENTITY_STORE_NAME).toBe('identity');
    expect(IDENTITY_RECORD_ID).toBe('default');
  });
});
