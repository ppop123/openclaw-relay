import { describe, expect, it, vi } from 'vitest';
import { RelayConnection, computeReconnectDelay } from '../src/relay-connection.js';
import type { WebSocketLike } from '../src/types.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event?: any) => void>>();

  addEventListener(type: string, listener: (event?: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  emit(type: string, event?: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('RelayConnection heartbeat', () => {
  it('sends a ping 30 seconds after registration and keeps connection open after pong', async () => {
    vi.useFakeTimers();
    const ws = new FakeWebSocket();
    const connection = new RelayConnection({
      url: 'ws://relay.test/ws',
      channel: 'abcd',
      webSocketFactory: () => ws,
      onFrame: () => undefined,
    });

    const startPromise = connection.start();
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'registered', channel: 'abcd', clients: 0 }) });
    await startPromise;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.sent.some((item) => JSON.parse(item).type === 'ping')).toBe(true);

    ws.emit('message', { data: JSON.stringify({ type: 'pong', ts: Date.now() }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.readyState).toBe(1);

    vi.useRealTimers();
  });

  it('includes discovery fields in the initial register frame when configured', async () => {
    const ws = new FakeWebSocket();
    const discoveryKey = Buffer.alloc(32, 0x11).toString('base64');
    const connection = new RelayConnection({
      url: 'ws://relay.test/ws',
      channel: 'abcd',
      register: {
        discoverable: true,
        public_key: discoveryKey,
        metadata: { name: 'alpha' },
      },
      webSocketFactory: () => ws,
      onFrame: () => undefined,
    });

    const startPromise = connection.start();
    ws.emit('open');

    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'register',
      channel: 'abcd',
      version: 1,
      discoverable: true,
      public_key: discoveryKey,
      metadata: { name: 'alpha' },
    });

    ws.emit('message', { data: JSON.stringify({ type: 'registered', channel: 'abcd', clients: 0 }) });
    await startPromise;
  });
});

describe('computeReconnectDelay', () => {
  it('applies bounded jitter to reconnect backoff', () => {
    expect(computeReconnectDelay(1_000, 0)).toBe(800);
    expect(computeReconnectDelay(1_000, 0.5)).toBe(1000);
    expect(computeReconnectDelay(1_000, 1)).toBe(1200);
    expect(computeReconnectDelay(60_000, 1)).toBe(72_000);
  });
});
