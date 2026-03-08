import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    click: vi.fn(),
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
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
  getElementById: (id) => getElement(id),
  createElement: () => createElement(),
  addEventListener: vi.fn(),
});

vi.stubGlobal('window', {
  app: null,
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

  app.connection.exportIdentityBundle = defaultExportIdentityBundle;
  app.connection.importIdentityBundle = defaultImportIdentityBundle;
  app.connection.resetIdentity = defaultResetIdentity;

  app.connection.crypto.clearIdentity();
  app.connection.identityPersistence = 'unsupported';
  app.connection.identityFingerprint = '';
  app.connection.identityCreatedAt = '';
  app.connection._storedIdentityRecord = null;
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
    expect(getElement('resetIdentityBtn').disabled).toBe(true);
    expect(getElement('exportIdentityBtn').disabled).toBe(true);
    expect(getElement('importIdentityBtn').disabled).toBe(false);
  });

  it('shows persisted identity fingerprint when transport exposes one', () => {
    app.connection.identityPersistence = 'persisted';
    app.connection.identityFingerprint = 'sha256:1234567890abcdef1234567890abcdef';
    app.connection.identityCreatedAt = '2026-03-08T00:00:00.000Z';
    app.connection._storedIdentityRecord = {
      fingerprint: app.connection.identityFingerprint,
      createdAt: app.connection.identityCreatedAt,
    };

    app._updateIdentityStatus();

    expect(getElement('identityMode').textContent).toBe('Persistent browser identity');
    expect(getElement('identityFingerprint').textContent).toMatch(/Fingerprint:/);
    expect(getElement('identityMeta').textContent).toMatch(/Created:/);
    expect(getElement('resetIdentityBtn').disabled).toBe(false);
    expect(getElement('exportIdentityBtn').disabled).toBe(false);
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

    await app.exportIdentity();

    expect(app.connection.exportIdentityBundle).toHaveBeenCalled();
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
    expect(createdElements.some((element) => element.download.includes('openclaw-relay-'))).toBe(true);
    expect(createdElements.some((element) => element.click.mock.calls.length > 0)).toBe(true);
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
