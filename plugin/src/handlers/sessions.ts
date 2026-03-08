import { InvalidParamsError, UnsupportedRuntimeMethodError } from '../errors.js';
import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleSessionsList(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (params.agent !== undefined && typeof params.agent !== 'string') {
    throw new InvalidParamsError('agent must be a string when provided');
  }
  if (params.limit !== undefined && typeof params.limit !== 'number') {
    throw new InvalidParamsError('limit must be numeric when provided');
  }
  if (params.offset !== undefined && typeof params.offset !== 'number') {
    throw new InvalidParamsError('offset must be numeric when provided');
  }
  if (!runtime.sessionsList) {
    throw new UnsupportedRuntimeMethodError('sessions.list');
  }
  return runtime.sessionsList(params, ctx);
}

export async function handleSessionsHistory(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
    throw new InvalidParamsError('session_id is required');
  }
  if (params.limit !== undefined && typeof params.limit !== 'number') {
    throw new InvalidParamsError('limit must be numeric when provided');
  }
  if (params.before !== undefined && params.before !== null && typeof params.before !== 'string') {
    throw new InvalidParamsError('before must be string or null');
  }
  if (!runtime.sessionsHistory) {
    throw new UnsupportedRuntimeMethodError('sessions.history');
  }
  return runtime.sessionsHistory(params, ctx);
}
