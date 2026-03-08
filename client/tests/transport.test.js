import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Transport module tests.
 *
 * Tests the real RelayConnection class from transport.js — specifically
 * the frame handling, L2 message routing, and state management logic.
 * No WebSocket or crypto mocking needed since we test methods directly.
 */

// Mock the crypto module so `new RelayCrypto()` in the constructor doesn't
// pull in Web Crypto APIs. We never exercise encryption in these tests.
vi.mock('../js/crypto.js', () => ({
  RelayCrypto: class {
    constructor() {
      this.sessionKey = null;
      this.publicKeyBytes = new Uint8Array(0);
      this.clientNonce = new Uint8Array(0);
    }
  },
  b64Encode: (buf) => '',
  b64Decode: (str) => new Uint8Array(0),
}));

vi.mock('../js/utils.js', () => ({
  randomHex: (n) => 'deadbeef',
  generateMsgId: () => 'test_' + Math.random().toString(36).slice(2, 8),
}));

import { RelayConnection } from '../js/transport.js';

// ─── Helpers ─────────────────────────────────────────────────────

function createConnection() {
  const conn = new RelayConnection();
  conn.onToast = vi.fn();
  conn.onNotify = vi.fn();
  conn.onStateChange = vi.fn();
  return conn;
}

function makePending(overrides = {}) {
  return {
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => {}, 30000),
    streaming: false,
    ...overrides,
  };
}

// ─── Constructor ─────────────────────────────────────────────────

describe('RelayConnection constructor', () => {
  it('initializes all fields correctly', () => {
    const conn = new RelayConnection();

    expect(conn.ws).toBeNull();
    expect(conn.state).toBe('disconnected');
    expect(conn.relayUrl).toBe('');
    expect(conn.channelHash).toBe('');
    expect(conn.clientId).toBe('');
    expect(conn.gatewayPubKeyB64).toBe('');
    expect(conn.channelToken).toBe('');
    expect(conn.encrypted).toBe(false);

    expect(conn.pendingRequests).toBeInstanceOf(Map);
    expect(conn.pendingRequests.size).toBe(0);
    expect(conn.activeStreams).toBeInstanceOf(Map);
    expect(conn.activeStreams.size).toBe(0);

    expect(conn.onStateChange).toBeNull();
    expect(conn.onNotify).toBeNull();
    expect(conn.onToast).toBeNull();

    expect(conn._backoff).toBe(1000);
    expect(conn._maxBackoff).toBe(60000);
    expect(conn._reconnecting).toBe(false);
    expect(conn._closed).toBe(false);

    expect(conn._frameWaiters).toBeInstanceOf(Map);
    expect(conn._frameWaiters.size).toBe(0);
    expect(conn._dataWaiters).toBeInstanceOf(Map);
    expect(conn._dataWaiters.size).toBe(0);
  });
});

// ─── _handleL2Message ────────────────────────────────────────────

describe('_handleL2Message', () => {
  let conn;

  beforeEach(() => {
    conn = createConnection();
  });

  it('resolves pending request on successful response', () => {
    const pending = makePending();
    conn.pendingRequests.set('req_1', pending);

    conn._handleL2Message({ id: 'req_1', type: 'response', result: { data: 'ok' } });

    expect(pending.resolve).toHaveBeenCalledWith({ data: 'ok' });
    expect(pending.reject).not.toHaveBeenCalled();
    expect(conn.pendingRequests.size).toBe(0);
  });

  it('rejects pending request on error response', () => {
    const pending = makePending();
    conn.pendingRequests.set('req_2', pending);

    conn._handleL2Message({
      id: 'req_2',
      type: 'response',
      error: { code: 'not_found', message: 'Agent not found' },
    });

    expect(pending.reject).toHaveBeenCalled();
    expect(pending.reject.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(pending.reject.mock.calls[0][0].message).toBe('Agent not found');
    expect(pending.resolve).not.toHaveBeenCalled();
    expect(conn.pendingRequests.size).toBe(0);
  });

  it('cleans up activeStreams on streaming response', () => {
    const pending = makePending({ streaming: true });
    conn.pendingRequests.set('req_3', pending);
    conn.activeStreams.set('req_3', { onChunk: vi.fn(), buffer: '' });

    conn._handleL2Message({ id: 'req_3', type: 'response', result: { done: true } });

    expect(pending.resolve).toHaveBeenCalledWith({ done: true });
    expect(conn.activeStreams.size).toBe(0);
    expect(conn.pendingRequests.size).toBe(0);
  });

  it('routes stream_chunk to onChunk callback', () => {
    const onChunk = vi.fn();
    conn.activeStreams.set('req_4', { onChunk, buffer: '' });

    conn._handleL2Message({ id: 'req_4', type: 'stream_chunk', data: { delta: 'hello ' } });
    conn._handleL2Message({ id: 'req_4', type: 'stream_chunk', data: { delta: 'world' } });

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenCalledWith({ delta: 'hello ' });
    expect(onChunk).toHaveBeenCalledWith({ delta: 'world' });
  });

  it('stream_end does NOT resolve (waits for final response)', () => {
    const pending = makePending({ streaming: true });
    conn.pendingRequests.set('req_5', pending);
    conn.activeStreams.set('req_5', { onChunk: vi.fn(), buffer: '' });

    conn._handleL2Message({ id: 'req_5', type: 'stream_end' });

    expect(pending.resolve).not.toHaveBeenCalled();
    expect(pending.reject).not.toHaveBeenCalled();
    expect(conn.pendingRequests.size).toBe(1);
    expect(conn.activeStreams.size).toBe(1);
  });

  it('ignores chunks for unknown stream ids', () => {
    // Should not throw
    expect(() => {
      conn._handleL2Message({ id: 'unknown', type: 'stream_chunk', data: { delta: 'x' } });
    }).not.toThrow();
  });

  it('routes notify to onNotify callback', () => {
    conn._handleL2Message({
      id: 'n_1',
      type: 'notify',
      event: 'agent_status',
      data: { agent: 'wukong', status: 'busy' },
    });

    expect(conn.onNotify).toHaveBeenCalledWith('agent_status', {
      agent: 'wukong',
      status: 'busy',
    });
  });
});

// ─── _handleFrame ────────────────────────────────────────────────

describe('_handleFrame', () => {
  let conn;

  beforeEach(() => {
    conn = createConnection();
    // Stub _sendRaw so ping->pong doesn't hit a real WebSocket
    conn._sendRaw = vi.fn();
  });

  it('resolves frame waiters for Layer 0 types (joined)', async () => {
    const waiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 30000) };
    conn._frameWaiters.set('joined', waiter);

    const frame = { type: 'joined', channel: 'abc', gateway_online: true };
    await conn._handleFrame(frame);

    expect(waiter.resolve).toHaveBeenCalledWith(frame);
    expect(conn._frameWaiters.size).toBe(0);
  });

  it('resolves frame waiters for registered type', async () => {
    const waiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 30000) };
    conn._frameWaiters.set('registered', waiter);

    const frame = { type: 'registered', client_id: 'web_abc' };
    await conn._handleFrame(frame);

    expect(waiter.resolve).toHaveBeenCalledWith(frame);
    expect(conn._frameWaiters.size).toBe(0);
  });

  it('resolves frame waiters for presence type', async () => {
    const waiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 30000) };
    conn._frameWaiters.set('presence', waiter);

    const frame = { type: 'presence', role: 'gateway', status: 'online' };
    await conn._handleFrame(frame);

    // When a waiter is present, it resolves and returns before reaching toast logic
    expect(waiter.resolve).toHaveBeenCalledWith(frame);
    expect(conn._frameWaiters.size).toBe(0);
  });

  it('responds to ping with pong', async () => {
    await conn._handleFrame({ type: 'ping', ts: 1234567890 });

    expect(conn._sendRaw).toHaveBeenCalledWith({ type: 'pong', ts: 1234567890 });
  });

  it('relay error rejects all pending requests AND all frame/data waiters', async () => {
    // Set up frame waiters
    const frameWaiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 30000) };
    conn._frameWaiters.set('joined', frameWaiter);

    // Set up data waiters
    const dataWaiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 30000) };
    conn._dataWaiters.set('hello_ack', dataWaiter);

    // Set up pending requests
    const pending1 = makePending();
    const pending2 = makePending();
    conn.pendingRequests.set('req_a', pending1);
    conn.pendingRequests.set('req_b', pending2);
    conn.activeStreams.set('req_b', { onChunk: vi.fn() });

    await conn._handleFrame({ type: 'error', code: 'rate_limited', message: 'Too many requests' });

    // All frame waiters rejected
    expect(frameWaiter.reject).toHaveBeenCalled();
    expect(frameWaiter.reject.mock.calls[0][0].message).toMatch(/Relay error: rate_limited/);
    expect(conn._frameWaiters.size).toBe(0);

    // All data waiters rejected
    expect(dataWaiter.reject).toHaveBeenCalled();
    expect(dataWaiter.reject.mock.calls[0][0].message).toMatch(/Relay error: rate_limited/);
    expect(conn._dataWaiters.size).toBe(0);

    // All pending requests rejected
    expect(pending1.reject).toHaveBeenCalled();
    expect(pending1.reject.mock.calls[0][0].message).toMatch(/Relay error: rate_limited/);
    expect(pending2.reject).toHaveBeenCalled();
    expect(conn.pendingRequests.size).toBe(0);
    expect(conn.activeStreams.size).toBe(0);

    // Toast fired
    expect(conn.onToast).toHaveBeenCalledWith('Too many requests', 'error');
  });

  it('calls onToast for gateway offline presence event (no waiter)', async () => {
    // No waiter registered — should fall through to toast logic
    await conn._handleFrame({ type: 'presence', role: 'gateway', status: 'offline' });
    expect(conn.onToast).toHaveBeenCalledWith('Gateway went offline', 'warning');
  });

  it('calls onToast for gateway online presence event (no waiter)', async () => {
    await conn._handleFrame({ type: 'presence', role: 'gateway', status: 'online' });
    expect(conn.onToast).toHaveBeenCalledWith('Gateway is back online', 'info');
  });

  it('ignores pong frames silently', async () => {
    await conn._handleFrame({ type: 'pong', ts: 999 });
    // No error, no callbacks
    expect(conn.onToast).not.toHaveBeenCalled();
    expect(conn._sendRaw).not.toHaveBeenCalled();
  });
});

// ─── _handleDataFrame ────────────────────────────────────────────

describe('_handleDataFrame', () => {
  let conn;

  beforeEach(() => {
    conn = createConnection();
  });

  it('resolves data waiter for hello_ack during handshake (unencrypted)', async () => {
    // encrypted = false by default (handshake in progress)
    const waiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 30000) };
    conn._dataWaiters.set('hello_ack', waiter);

    const helloAckPayload = {
      type: 'hello_ack',
      gateway_public_key: 'AAAA',
      session_nonce: 'BBBB',
    };

    await conn._handleDataFrame({ type: 'data', payload: JSON.stringify(helloAckPayload) });

    expect(waiter.resolve).toHaveBeenCalledWith(helloAckPayload);
    expect(conn._dataWaiters.size).toBe(0);
  });

  it('routes L2 messages through to _handleL2Message when not hello_ack', async () => {
    const pending = makePending();
    conn.pendingRequests.set('req_x', pending);

    const l2Msg = { id: 'req_x', type: 'response', result: { ok: true } };
    await conn._handleDataFrame({ type: 'data', payload: JSON.stringify(l2Msg) });

    expect(pending.resolve).toHaveBeenCalledWith({ ok: true });
  });

  it('drops frames with unparseable payload during handshake', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await conn._handleDataFrame({ type: 'data', payload: '{invalid json' });

    // Should not throw — just logs and returns
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── disconnect ──────────────────────────────────────────────────

describe('disconnect', () => {
  it('rejects all pending requests, clears state, sets state to disconnected', () => {
    const conn = createConnection();

    // Set up some state
    conn.state = 'connected';
    conn.encrypted = true;
    conn.ws = { close: vi.fn(), readyState: 1 };

    const pending1 = makePending();
    const pending2 = makePending();
    const pending3 = makePending();
    conn.pendingRequests.set('r1', pending1);
    conn.pendingRequests.set('r2', pending2);
    conn.pendingRequests.set('r3', pending3);
    conn.activeStreams.set('r2', { onChunk: vi.fn(), buffer: '' });

    conn.disconnect();

    // All pending requests rejected with 'Disconnected'
    for (const pending of [pending1, pending2, pending3]) {
      expect(pending.reject).toHaveBeenCalled();
      expect(pending.reject.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(pending.reject.mock.calls[0][0].message).toBe('Disconnected');
    }

    // State cleared
    expect(conn.pendingRequests.size).toBe(0);
    expect(conn.activeStreams.size).toBe(0);
    expect(conn.encrypted).toBe(false);
    expect(conn._closed).toBe(true);
    expect(conn.ws).toBeNull();
    expect(conn.state).toBe('disconnected');
    expect(conn.onStateChange).toHaveBeenCalledWith('disconnected');
  });

  it('handles disconnect when no pending requests exist', () => {
    const conn = createConnection();
    conn.ws = null;

    expect(() => conn.disconnect()).not.toThrow();
    expect(conn.state).toBe('disconnected');
    expect(conn._closed).toBe(true);
  });
});
