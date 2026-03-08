import { describe, expect, it } from 'vitest';
import { dispatchRequest, MethodNotFoundError } from '../src/dispatch.js';
import type { RelayRequestContext, RelayRuntimeAdapter, RequestMessage } from '../src/types.js';

const ctx: RelayRequestContext = {
  accountId: 'default',
  clientId: 'client-1',
  fingerprint: 'sha256:test',
  signal: new AbortController().signal,
};

function request(method: string, params: Record<string, unknown>): RequestMessage {
  return { id: 'msg_1', type: 'request', method, params };
}

describe('request dispatch', () => {
  it('routes standard methods to runtime handlers', async () => {
    const runtime: RelayRuntimeAdapter = {
      agentsList: async () => ({ agents: [{ name: 'demo', display_name: 'Demo', status: 'idle', description: 'ok' }] }),
      systemStatus: async () => ({ version: '1.0.0' }),
    };

    await expect(dispatchRequest(runtime, request('agents.list', {}), ctx)).resolves.toEqual({
      agents: [{ name: 'demo', display_name: 'Demo', status: 'idle', description: 'ok' }],
    });
    await expect(dispatchRequest(runtime, request('system.status', {}), ctx)).resolves.toEqual({ version: '1.0.0' });
  });

  it('throws MethodNotFoundError for unknown methods', async () => {
    await expect(dispatchRequest({}, request('x.unknown', {}), ctx)).rejects.toBeInstanceOf(MethodNotFoundError);
  });

  it('validates request parameters', async () => {
    const runtime: RelayRuntimeAdapter = { cronToggle: async () => ({ ok: true }) };
    await expect(dispatchRequest(runtime, request('cron.toggle', { id: 123, enabled: true }), ctx)).rejects.toThrow('id is required');
  });

  it('supports chat streaming return type', async () => {
    const runtime: RelayRuntimeAdapter = {
      chatSend: async () => ({
        stream: (async function* () { yield { delta: 'hi' }; })(),
        final: { session_id: 'sess_1', agent: 'demo', tokens: { input: 1, output: 1 } },
      }),
    };
    const result = await dispatchRequest(runtime, request('chat.send', { message: 'hello', stream: true }), ctx);
    expect('stream' in result).toBe(true);
  });
});
