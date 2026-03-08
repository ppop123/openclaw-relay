import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * App module tests — channelToken migration & settings persistence.
 *
 * app.js is a browser module (uses document, localStorage, WebSocket via
 * transport.js).  We stub all browser globals before dynamically importing
 * the module so that its top-level code (new RelayConnection(), window.app,
 * DOMContentLoaded listener) executes without errors.
 */

// ── Browser global stubs (must be set before app.js is imported) ──

const store = new Map();

vi.stubGlobal('localStorage', {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, val) => store.set(key, val),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
});

vi.stubGlobal('document', {
  getElementById: () => ({
    value: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    style: {},
    classList: { add: vi.fn(), remove: vi.fn() },
    focus: vi.fn(),
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
  }),
  createElement: () => ({
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    appendChild: vi.fn(),
    remove: vi.fn(),
  }),
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

// ── Import app after globals are in place ──

const { app } = await import('../js/app.js');

const STORAGE_KEY = 'openclaw-relay-settings';

// ── Tests ──

describe('channelToken migration', () => {
  beforeEach(() => {
    store.clear();
  });

  it('deletes channelToken from saved settings on init()', () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        relayUrl: 'wss://relay.test',
        channelToken: 'secret-token',
        gatewayPubKey: 'abc123',
      }),
    );

    app.init();

    const result = JSON.parse(store.get(STORAGE_KEY));
    expect(result).not.toHaveProperty('channelToken');
    expect(result.relayUrl).toBe('wss://relay.test');
    expect(result.gatewayPubKey).toBe('abc123');
  });

  it('leaves settings unchanged when no channelToken exists', () => {
    const original = { relayUrl: 'wss://relay.test', gatewayPubKey: 'abc123' };
    store.set(STORAGE_KEY, JSON.stringify(original));

    app.init();

    const result = JSON.parse(store.get(STORAGE_KEY));
    expect(result).toEqual(original);
  });

  it('does not throw when localStorage is empty', () => {
    expect(() => app.init()).not.toThrow();
  });
});

describe('_saveSettings strips channelToken', () => {
  beforeEach(() => {
    store.clear();
  });

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
