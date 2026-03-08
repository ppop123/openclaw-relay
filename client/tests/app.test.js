import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * App module tests — settings migration, storage safety, and identity UI state.
 *
 * app.js is a browser module, so browser globals must be stubbed before import.
 */

const store = new Map();
const elements = new Map();

function createElement(overrides = {}) {
  return {
    value: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    classList: { add: vi.fn(), remove: vi.fn() },
    focus: vi.fn(),
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => createElement()),
    remove: vi.fn(),
    ...overrides,
  };
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

vi.stubGlobal('WebSocket', class MockWebSocket {
  static OPEN = 1;
  close() {}
  send() {}
});

vi.stubGlobal('requestAnimationFrame', (cb) => cb());
vi.stubGlobal('setTimeout', globalThis.setTimeout);
vi.stubGlobal('clearTimeout', globalThis.clearTimeout);

const { app } = await import('../js/app.js');

const STORAGE_KEY = 'openclaw-relay-settings';

beforeEach(() => {
  store.clear();
  elements.clear();
  app.connection.crypto.clearIdentity();
  app.connection.identityPersistence = 'unsupported';
  app.connection.identityFingerprint = '';
  app.connection.identityCreatedAt = '';
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
    expect(getElement('resetIdentityBtn').disabled).toBe(true);
  });

  it('shows persisted identity fingerprint when transport exposes one', () => {
    app.connection.identityPersistence = 'persisted';
    app.connection.identityFingerprint = 'sha256:1234567890abcdef1234567890abcdef';
    app.connection.identityCreatedAt = '2026-03-08T00:00:00.000Z';
    app.connection.crypto.keyPair = { publicKey: {}, privateKey: {} };

    app._updateIdentityStatus();

    expect(getElement('identityMode').textContent).toBe('Persistent browser identity');
    expect(getElement('identityFingerprint').textContent).toMatch(/Fingerprint:/);
    expect(getElement('resetIdentityBtn').disabled).toBe(false);
  });
});
