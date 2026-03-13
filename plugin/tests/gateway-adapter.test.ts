import { describe, expect, it, vi } from 'vitest';
import { RelayGatewayAdapter } from '../src/gateway-adapter.js';
import type { GatewaySession, } from '../src/transport.js';
import type { RequestMessage } from '../src/types.js';

function makeSession(clientId = 'client-1'): GatewaySession {
  return {
    clientId,
    fingerprint: 'sha256:test',
    publicKey: new Uint8Array(32),
    capabilities: ['system'],
    connectedAt: new Date('2026-03-08T00:00:00.000Z'),
    lastActivity: new Date('2026-03-08T00:00:00.000Z'),
    cipher: {} as never,
  };
}

describe('RelayGatewayAdapter request limiting', () => {
  it('maps concurrency rejection to rate_limited', async () => {
    const adapter = new RelayGatewayAdapter({
      accountId: 'default',
      configStore: {
        load: async () => undefined,
        save: async () => undefined,
        listAccountIds: async () => [],
        inspectAccount: async () => undefined,
      },
      runtime: {},
      maxConcurrentPerClient: 1,
      maxConcurrentGlobal: 1,
    });

    const sendError = vi.fn(async () => undefined);
    adapter['outbound'] = {
      sendError,
      sendResponse: vi.fn(),
      sendStreamStart: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendNotify: vi.fn(),
    } as never;
    adapter['pendingRequests'].set('existing', {
      clientId: 'client-1',
      abortController: new AbortController(),
      cancelled: false,
      terminalSent: false,
    });

    const request: RequestMessage = {
      id: 'msg_2',
      type: 'request',
      method: 'system.status',
      params: {},
    };

    await adapter['handleRequest'](makeSession(), request);

    expect(sendError).toHaveBeenCalledWith('client-1', 'msg_2', 'rate_limited', 'gateway request limit reached');
  });
});

describe('RelayGatewayAdapter admin auth', () => {
  function makeApprovedConfig() {
    return {
      enabled: true,
      server: 'ws://relay.example.test/ws',
      channelToken: 'token',
      gatewayKeyPair: { publicKey: 'pub', privateKey: 'priv' },
      approvedClients: {
        'sha256:test': { publicKey: 'pub', firstPairedAt: '2026-03-12T00:00:00.000Z' },
      },
    };
  }

  it('allows admin methods without an admin key', async () => {
    const runtime = {
      configGet: vi.fn(async (params: Record<string, unknown>) => {
        expect(params.admin_session_key).toBeUndefined();
        return { ok: true };
      }),
    };
    const adapter = new RelayGatewayAdapter({
      accountId: 'default',
      configStore: {
        load: async () => undefined,
        save: async () => undefined,
        listAccountIds: async () => [],
        inspectAccount: async () => undefined,
      },
      runtime,
    });

    adapter['currentConfig'] = makeApprovedConfig();

    const sendResponse = vi.fn(async () => undefined);
    const sendError = vi.fn(async () => undefined);
    adapter['outbound'] = {
      sendError,
      sendResponse,
      sendStreamStart: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendNotify: vi.fn(),
    } as never;

    const request: RequestMessage = {
      id: 'msg_admin_1',
      type: 'request',
      method: 'config.get',
      params: {},
    };

    await adapter['handleRequest'](makeSession(), request);

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith('client-1', 'msg_admin_1', { ok: true });
  });

  it('strips admin_session_key from admin params', async () => {
    const runtime = {
      configGet: vi.fn(async (params: Record<string, unknown>) => {
        expect(params.admin_session_key).toBeUndefined();
        return { ok: true };
      }),
    };
    const adapter = new RelayGatewayAdapter({
      accountId: 'default',
      configStore: {
        load: async () => undefined,
        save: async () => undefined,
        listAccountIds: async () => [],
        inspectAccount: async () => undefined,
      },
      runtime,
    });

    adapter['currentConfig'] = makeApprovedConfig();

    const sendResponse = vi.fn(async () => undefined);
    const sendError = vi.fn(async () => undefined);
    adapter['outbound'] = {
      sendError,
      sendResponse,
      sendStreamStart: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendNotify: vi.fn(),
    } as never;

    const request: RequestMessage = {
      id: 'msg_admin_2',
      type: 'request',
      method: 'config.get',
      params: { admin_session_key: 'not-required-anymore' },
    };

    await adapter['handleRequest'](makeSession(), request);

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith('client-1', 'msg_admin_2', { ok: true });
  });
});
