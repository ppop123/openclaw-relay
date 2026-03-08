import { describe, expect, it } from 'vitest';
import { createRelayPlugin } from '../src/channel.js';
import { MemoryRelayConfigStore } from '../src/config.js';
import { handleRelayEnable } from '../src/commands/enable.js';
import type { WebSocketLike } from '../src/types.js';

class MockRelayWebSocket implements WebSocketLike {
  readyState = 1;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.type === 'register') {
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify({ type: 'registered', channel: frame.channel, clients: 0 }) });
      });
    }
  }

  close(): void {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', {}));
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    if (type === 'open') {
      queueMicrotask(() => listener({}));
    }
  }

  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('relay plugin factory', () => {
  it('does not retain failed adapters', async () => {
    const store = new MemoryRelayConfigStore();
    const plugin = createRelayPlugin({
      configStore: store,
      runtime: {},
      webSocketFactory: () => new MockRelayWebSocket(),
    });

    await expect(plugin.gateway.startAccount('missing')).rejects.toThrow("account 'missing' not found");
    expect(plugin.gateway.getAdapter('missing')).toBeUndefined();
  });

  it('starts and stops an account adapter', async () => {
    const store = new MemoryRelayConfigStore();
    await handleRelayEnable(store, 'ws://relay.example.com/ws', 'default');

    const plugin = createRelayPlugin({
      configStore: store,
      runtime: {},
      webSocketFactory: () => new MockRelayWebSocket(),
    });

    const adapter = await plugin.gateway.startAccount('default');
    expect(plugin.gateway.getAdapter('default')).toBe(adapter);

    await plugin.gateway.stopAccount('default');
    expect(plugin.gateway.getAdapter('default')).toBeUndefined();
  });
});
