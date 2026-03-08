import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleSessionsList(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (params.agent !== undefined && typeof params.agent !== 'string') {
    throw new Error('agent must be a string when provided');
  }
  if (params.limit !== undefined && typeof params.limit !== 'number') {
    throw new Error('limit must be numeric when provided');
  }
  if (params.offset !== undefined && typeof params.offset !== 'number') {
    throw new Error('offset must be numeric when provided');
  }
  if (!runtime.sessionsList) {
    throw new Error('sessions.list is not supported by this runtime');
  }
  return runtime.sessionsList(params, ctx);
}

export async function handleSessionsHistory(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
    throw new Error('session_id is required');
  }
  if (params.limit !== undefined && typeof params.limit !== 'number') {
    throw new Error('limit must be numeric when provided');
  }
  if (params.before !== undefined && params.before !== null && typeof params.before !== 'string') {
    throw new Error('before must be string or null');
  }
  if (!runtime.sessionsHistory) {
    throw new Error('sessions.history is not supported by this runtime');
  }
  return runtime.sessionsHistory(params, ctx);
}
