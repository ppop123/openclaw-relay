import { beforeEach, describe, expect, it, vi } from 'vitest';

import { protectIdentityBundle } from '../js/identity-bundle.js';

/*
 * App module tests — settings migration, storage safety, identity UI state,
 * and identity management actions.
 */

const store = new Map();
const elements = new Map();
const createdElements = [];
const confirmMock = vi.fn(() => true);

function createElement(overrides = {}) {
  const element = {
    value: '',
    files: [],
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    href: '',
    download: '',
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    classList: { add: vi.fn(), remove: vi.fn() },
    focus: vi.fn(),
    select: vi.fn(),
    click: vi.fn(),
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    querySelector: vi.fn(() => createElement()),
    remove: vi.fn(),
    ...overrides,
  };
  createdElements.push(element);
  return element;
}

function getElement(id) {
  if (!elements.has(id)) {
    elements.set(id, createElement());
  }
  return elements.get(id);
}

vi.stubGlobal('localStorage', {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, val) => store.set(key, val),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
});

vi.stubGlobal('document', {
  body: { appendChild: vi.fn() },
  getElementById: (id) => getElement(id),
  createElement: () => createElement(),
  addEventListener: vi.fn(),
  execCommand: vi.fn(() => true),
});

vi.stubGlobal('window', {
  app: null,
});

vi.stubGlobal('navigator', {
  clipboard: {
    writeText: vi.fn(async () => undefined),
  },
});

vi.stubGlobal('confirm', confirmMock);
vi.stubGlobal('WebSocket', class MockWebSocket {
  static OPEN = 1;
  close() {}
  send() {}
});
vi.stubGlobal('requestAnimationFrame', (cb) => cb());
vi.stubGlobal('setTimeout', globalThis.setTimeout);
vi.stubGlobal('clearTimeout', globalThis.clearTimeout);

globalThis.URL.createObjectURL = vi.fn(() => 'blob:test-identity');
globalThis.URL.revokeObjectURL = vi.fn();

const { app } = await import('../js/app.js');

const STORAGE_KEY = 'openclaw-relay-settings';
const PROFILES_KEY = 'openclaw-relay-profiles';
const defaultExportIdentityBundle = app.connection.exportIdentityBundle.bind(app.connection);
const defaultImportIdentityBundle = app.connection.importIdentityBundle.bind(app.connection);
const defaultResetIdentity = app.connection.resetIdentity.bind(app.connection);

beforeEach(() => {
  store.clear();
  elements.clear();
  createdElements.length = 0;
  confirmMock.mockReset();
  confirmMock.mockReturnValue(true);
  globalThis.URL.createObjectURL.mockClear();
  globalThis.URL.revokeObjectURL.mockClear();
  globalThis.navigator.clipboard.writeText.mockClear();

  app.connection.exportIdentityBundle = defaultExportIdentityBundle;
  app.connection.importIdentityBundle = defaultImportIdentityBundle;
  app.connection.resetIdentity = defaultResetIdentity;

  app.profiles = [];
  app.connection.crypto.clearIdentity();
  app.connection.identityPersistence = 'unsupported';
  app.connection.identityFingerprint = '';
  app.connection.identityCreatedAt = '';
  app.connection._storedIdentityRecord = null;
  app.connection._identityLoadFailed = false;
  app.connection._closed = false;
  app.connection.state = 'disconnected';
});

describe('channelToken migration', () => {
  it('deletes channelToken from saved settings on init()', async () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        relayUrl: 'wss://relay.test',
        channelToken: 'secret-token',
        gatewayPubKey: 'abc123',
      }),
    );

    await app.init();

    const result = JSON.parse(store.get(STORAGE_KEY));
    expect(result).not.toHaveProperty('channelToken');
    expect(result.relayUrl).toBe('wss://relay.test');
    expect(result.gatewayPubKey).toBe('abc123');
  });

  it('leaves settings unchanged when no channelToken exists', async () => {
    const original = { relayUrl: 'wss://relay.test', gatewayPubKey: 'abc123' };
    store.set(STORAGE_KEY, JSON.stringify(original));

    await app.init();

    const result = JSON.parse(store.get(STORAGE_KEY));
    expect(result).toEqual(original);
  });

  it('does not throw when localStorage is empty', async () => {
    await expect(app.init()).resolves.toBeUndefined();
  });
});

describe('_saveSettings strips channelToken', () => {
  it('never persists channelToken', () => {
    app._saveSettings({
      relayUrl: 'wss://test',
      channelToken: 'secret',
      gatewayPubKey: 'key',
    });

    const result = JSON.parse(store.get(STORAGE_KEY));
    expect(result).not.toHaveProperty('channelToken');
    expect(result.relayUrl).toBe('wss://test');
    expect(result.gatewayPubKey).toBe('key');
  });
});

describe('identity UI state', () => {
  it('shows unsupported persistence state when indexedDB is unavailable', async () => {
    await app.init();

    expect(getElement('identityMode').textContent).toBe('Persistence unavailable');
    expect(getElement('identityFingerprint').textContent).toMatch(/cannot persist/i);
    expect(getElement('identityMeta').textContent).toMatch(/current page session/i);
    expect(getElement('identityRecoveryHint').textContent).toMatch(/indexeddb identity storage is unavailable/i);
    expect(getElement('resetIdentityBtn').disabled).toBe(true);
    expect(getElement('exportIdentityBtn').disabled).toBe(true);
    expect(getElement('importIdentityBtn').disabled).toBe(false);
    expect(getElement('copyFingerprintBtn').disabled).toBe(true);
    expect(getElement('copyPublicKeyBtn').disabled).toBe(true);
  });

  it('shows persisted identity fingerprint when transport exposes one', () => {
    app.connection.identityPersistence = 'persisted';
    app.connection.identityFingerprint = 'sha256:1234567890abcdef1234567890abcdef';
    app.connection.identityCreatedAt = '2026-03-08T00:00:00.000Z';
    app.connection._storedIdentityRecord = {
      publicKey: 'PUBKEY123',
      fingerprint: app.connection.identityFingerprint,
      createdAt: app.connection.identityCreatedAt,
    };

    app._updateIdentityStatus();

    expect(getElement('identityMode').textContent).toBe('Persistent browser identity');
    expect(getElement('identityFingerprint').textContent).toMatch(/Fingerprint:/);
    expect(getElement('identityMeta').textContent).toMatch(/Created:/);
    expect(getElement('identityRecoveryHint').textContent).toMatch(/backup recommended/i);
    expect(getElement('resetIdentityBtn').disabled).toBe(false);
    expect(getElement('exportIdentityBtn').disabled).toBe(false);
    expect(getElement('copyFingerprintBtn').disabled).toBe(false);
    expect(getElement('copyPublicKeyBtn').disabled).toBe(false);
  });

  it('shows a recovery hint when the stored identity failed to load', () => {
    app.connection.identityPersistence = 'absent';
    app.connection._identityLoadFailed = true;

    app._updateIdentityStatus();

    expect(getElement('identityRecoveryHint').textContent).toMatch(/could not be loaded/i);
  });
});

describe('identity actions', () => {
  it('exports the current identity as a downloadable file', async () => {
    app.connection.exportIdentityBundle = vi.fn(async () => ({
      format: 'openclaw-relay-browser-identity',
      version: 1,
      fingerprint: 'sha256:abcdef',
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
      createdAt: '2026-03-08T00:00:00.000Z',
    }));
    confirmMock.mockReturnValue(true);

    await app.exportIdentity();

    expect(app.connection.exportIdentityBundle).toHaveBeenCalled();
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
    expect(createdElements.some((element) => element.download.includes('openclaw-relay-'))).toBe(true);
    expect(createdElements.some((element) => element.click.mock.calls.length > 0)).toBe(true);
  });

  it('exports a protected identity bundle when a passphrase is provided', async () => {
    app.connection.exportIdentityBundle = vi.fn(async () => ({
      format: 'openclaw-relay-browser-identity',
      version: 1,
      fingerprint: 'sha256:abcdef',
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
      createdAt: '2026-03-08T00:00:00.000Z',
    }));
    getElement('identityPassphrase').value = 'top-secret';
    const downloadSpy = vi.spyOn(app, '_downloadJsonFile').mockImplementation(() => {});

    await app.exportIdentity();

    expect(downloadSpy).toHaveBeenCalled();
    const exported = downloadSpy.mock.calls[0][1];
    expect(exported.encrypted).toBe(true);
    expect(exported.ciphertext).toBeTruthy();
    expect(getElement('identityPassphrase').value).toBe('');

    downloadSpy.mockRestore();
  });

  it('imports an identity file and refreshes the identity card', async () => {
    app.connection.importIdentityBundle = vi.fn(async () => {
      app.connection.identityPersistence = 'persisted';
      app.connection.identityFingerprint = 'sha256:imported';
      app.connection.identityCreatedAt = '2026-03-08T00:00:00.000Z';
      app.connection._storedIdentityRecord = {
        fingerprint: 'sha256:imported',
        createdAt: '2026-03-08T00:00:00.000Z',
      };
      app.connection.crypto.clearIdentity();
      return app.connection.getIdentitySummary();
    });

    await app.handleImportIdentity({
      target: {
        value: 'identity.json',
        files: [
          {
            text: async () => JSON.stringify({
              format: 'openclaw-relay-browser-identity',
              version: 1,
              publicKey: 'PUB',
              privateKeyPkcs8: 'PRIV',
            }),
          },
        ],
      },
    });

    expect(app.connection.importIdentityBundle).toHaveBeenCalled();
    expect(getElement('identityMode').textContent).toBe('Persistent browser identity');
    expect(getElement('identityFingerprint').textContent).toMatch(/Fingerprint:/);
  });

  it('imports a protected identity file when the passphrase is provided', async () => {
    const protectedBundle = await protectIdentityBundle({
      format: 'openclaw-relay-browser-identity',
      version: 1,
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
      fingerprint: 'sha256:imported',
      createdAt: '2026-03-08T00:00:00.000Z',
    }, 'top-secret');

    app.connection.importIdentityBundle = vi.fn(async () => {
      app.connection.identityPersistence = 'persisted';
      app.connection.identityFingerprint = 'sha256:imported';
      app.connection.identityCreatedAt = '2026-03-08T00:00:00.000Z';
      app.connection._storedIdentityRecord = {
        fingerprint: 'sha256:imported',
        createdAt: '2026-03-08T00:00:00.000Z',
      };
      app.connection.crypto.clearIdentity();
      return app.connection.getIdentitySummary();
    });
    getElement('identityPassphrase').value = 'top-secret';

    await app.handleImportIdentity({
      target: {
        value: 'identity.protected.json',
        files: [
          {
            text: async () => JSON.stringify(protectedBundle),
          },
        ],
      },
    });

    expect(app.connection.importIdentityBundle).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: 'PUB',
      privateKeyPkcs8: 'PRIV',
    }));
    expect(getElement('identityPassphrase').value).toBe('');
  });

  it('copies the current identity fingerprint to the clipboard', async () => {
    app.connection.identityPersistence = 'persisted';
    app.connection.identityFingerprint = 'sha256:copyme0123456789';
    app.connection._storedIdentityRecord = {
      publicKey: 'PUBKEY123',
      fingerprint: app.connection.identityFingerprint,
      createdAt: '2026-03-08T00:00:00.000Z',
    };

    await app.copyIdentityFingerprint();

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('sha256:copyme0123456789');
  });

  it('copies the current identity public key to the clipboard', async () => {
    app.connection.identityPersistence = 'persisted';
    app.connection.identityFingerprint = 'sha256:copyme0123456789';
    app.connection._storedIdentityRecord = {
      publicKey: 'PUBKEY123',
      fingerprint: app.connection.identityFingerprint,
      createdAt: '2026-03-08T00:00:00.000Z',
    };

    await app.copyIdentityPublicKey();

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('PUBKEY123');
  });

  it('does not reset the identity when the confirmation is canceled', async () => {
    app.connection.identityPersistence = 'persisted';
    app.connection.identityFingerprint = 'sha256:abcdef0123456789';
    app.connection._storedIdentityRecord = {
      fingerprint: app.connection.identityFingerprint,
      createdAt: '2026-03-08T00:00:00.000Z',
    };
    app.connection.resetIdentity = vi.fn(async () => app.connection.getIdentitySummary());
    confirmMock.mockReturnValue(false);

    await app.resetIdentity();

    expect(app.connection.resetIdentity).not.toHaveBeenCalled();
  });
});


describe('saved profiles', () => {
  it('saves a safe relay profile without persisting channelToken', () => {
    getElement('relayUrl').value = 'wss://relay.example.com';
    getElement('gatewayPubKey').value = 'BASE64KEY';
    getElement('profileName').value = 'Office relay';
    getElement('profileSelect').value = '';

    app.saveProfile();

    const profiles = JSON.parse(store.get(PROFILES_KEY));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: 'Office relay',
      relayUrl: 'wss://relay.example.com/ws',
      gatewayPubKey: 'BASE64KEY',
    });
    expect(JSON.stringify(profiles[0])).not.toMatch(/channelToken/);
  });

  it('restores the selected saved profile on init', async () => {
    store.set(PROFILES_KEY, JSON.stringify([
      {
        id: 'profile_saved',
        name: 'Saved relay',
        relayUrl: 'wss://saved.example.com/ws',
        gatewayPubKey: 'SAVEDKEY',
      },
    ]));
    store.set(STORAGE_KEY, JSON.stringify({
      relayUrl: 'wss://stale.example.com/ws',
      gatewayPubKey: 'STALEKEY',
      selectedProfileId: 'profile_saved',
    }));

    await app.init();

    expect(getElement('profileSelect').value).toBe('profile_saved');
    expect(getElement('profileName').value).toBe('Saved relay');
    expect(getElement('relayUrl').value).toBe('wss://saved.example.com/ws');
    expect(getElement('gatewayPubKey').value).toBe('SAVEDKEY');
    expect(getElement('deleteProfileBtn').disabled).toBe(false);
  });

  it('deletes the selected saved profile after confirmation', () => {
    app.profiles = [
      {
        id: 'profile_saved',
        name: 'Saved relay',
        relayUrl: 'wss://saved.example.com/ws',
        gatewayPubKey: 'SAVEDKEY',
      },
    ];
    app._renderProfiles('profile_saved');
    getElement('relayUrl').value = 'wss://saved.example.com/ws';
    getElement('gatewayPubKey').value = 'SAVEDKEY';

    app.deleteProfile();

    expect(app.profiles).toHaveLength(0);
    expect(JSON.parse(store.get(PROFILES_KEY))).toEqual([]);
    expect(getElement('profileSelect').value).toBe('');
  });
});


describe('diagnostics and session controls', () => {
  it('renders session, client, profile, and gateway diagnostics', () => {
    app.connection.clientId = 'web_deadbeef';
    app.sessionId = 'sess_123';
    app.profiles = [
      {
        id: 'profile_saved',
        name: 'Saved relay',
        relayUrl: 'wss://saved.example.com/ws',
        gatewayPubKey: 'SAVEDKEY1234567890',
      },
    ];
    getElement('profileSelect').value = 'profile_saved';
    getElement('gatewayPubKey').value = 'SAVEDKEY1234567890';

    app._updateDiagnostics();

    expect(getElement('sessionValue').textContent).toBe('sess_123');
    expect(getElement('clientValue').textContent).toBe('web_deadbeef');
    expect(getElement('profileValue').textContent).toBe('Saved relay');
    expect(getElement('gatewayValue').textContent).toMatch(/SAVEDKEY/);
  });

  it('starts a new chat without disconnecting', () => {
    app.connection.state = 'connected';
    app.sessionId = 'sess_123';
    const addSystemSpy = vi.spyOn(app, '_addSystemMessage').mockImplementation(() => {});
    const diagnosticsSpy = vi.spyOn(app, '_updateDiagnostics').mockImplementation(() => {});

    app.startNewChat();

    expect(app.sessionId).toBeNull();
    expect(addSystemSpy).toHaveBeenCalledWith('Started a new chat thread.');
    expect(diagnosticsSpy).toHaveBeenCalled();

    addSystemSpy.mockRestore();
    diagnosticsSpy.mockRestore();
  });
});
