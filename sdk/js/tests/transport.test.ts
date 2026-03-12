import { describe, expect, it } from 'vitest';
import { ChannelReconnected } from '../src/channel.js';
import type { ChannelConnection } from '../src/channel.js';
import { DIRECTION_CLIENT_TO_GATEWAY, DIRECTION_GATEWAY_TO_CLIENT, SessionCipher, importAesKey } from '../src/crypto.js';
import { TransportError, TransportLayer } from '../src/transport.js';
import { b64Decode, b64Encode, randomBytes } from '../src/utils.js';

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async shift(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }
    return await new Promise((resolve) => this.waiters.push(resolve));
  }
}

class MockChannel {
  private incoming = new AsyncQueue<Record<string, unknown>>();
  outgoing: Array<Record<string, unknown>> = [];
  throwOnNext = false;

  async recv(): Promise<Record<string, unknown>> {
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new ChannelReconnected();
    }
    return await this.incoming.shift();
  }

  async sendData(to: string, payload: string): Promise<void> {
    this.outgoing.push({ to, payload });
  }

  inject(frame: Record<string, unknown>): void {
    this.incoming.push(frame);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout waiting for condition');
}

function makeCipherPair() {
  return importAesKey(randomBytes(32)).then((key) => ({
    client: new SessionCipher(key, DIRECTION_CLIENT_TO_GATEWAY),
    gateway: new SessionCipher(key, DIRECTION_GATEWAY_TO_CLIENT),
  }));
}

describe('TransportLayer', () => {
  it('sends encrypted requests and returns decrypted responses', async () => {
    const channel = new MockChannel();
    const { client, gateway } = await makeCipherPair();
    const transport = new TransportLayer(channel as unknown as ChannelConnection, client, 'client-1', 'gateway-1');

    await transport.start();

    const requestPromise = transport.request('greet', { msg: 'hi' }, 2000);

    await waitFor(() => channel.outgoing.length > 0);

    const sent = channel.outgoing[0];
    const payloadBytes = b64Decode(String(sent.payload));
    const plaintext = await gateway.decrypt(payloadBytes);
    const requestMsg = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;

    expect(requestMsg.type).toBe('request');
    expect(requestMsg.method).toBe('greet');

    const responseMsg = {
      id: requestMsg.id,
      type: 'response',
      result: { greeting: 'hello back' },
    };

    const responsePlain = new TextEncoder().encode(JSON.stringify(responseMsg));
    const responseCipher = await gateway.encrypt(responsePlain);
    channel.inject({ type: 'data', from: 'gateway-1', payload: b64Encode(responseCipher) });

    const result = await requestPromise;
    expect(result.greeting).toBe('hello back');
  });

  it('fails pending requests on ChannelReconnected', async () => {
    const channel = new MockChannel();
    const { client } = await makeCipherPair();
    const transport = new TransportLayer(channel as unknown as ChannelConnection, client, 'client-1', 'gateway-1');

    await transport.start();

    const requestPromise = transport.request('echo', { msg: 'hi' }, 2000)
      .then(() => null)
      .catch((err) => err as TransportError);

    channel.throwOnNext = true;
    channel.inject({ type: 'ping' });

    await transport.waitDone();
    const error = await requestPromise;
    expect(error).toMatchObject({ code: 'reconnected' });
  });
});
