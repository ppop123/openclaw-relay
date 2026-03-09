import { InvalidParamsError, UnsupportedRuntimeMethodError } from '../errors.js';
import { RelayRuntimeAdapter, RelayRequestContext, RelayStreamResult } from '../types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStreamResult(value: unknown): value is RelayStreamResult {
  return isObject(value) && typeof (value as { stream?: unknown }).stream === 'object' && 'final' in value;
}

export async function handleChatSend(
  runtime: RelayRuntimeAdapter,
  params: Record<string, unknown>,
  ctx: RelayRequestContext,
): Promise<Record<string, unknown> | RelayStreamResult> {
  if (typeof params.message !== 'string' || params.message.length === 0) {
    throw new InvalidParamsError('message is required');
  }
  if (params.agent !== undefined && typeof params.agent !== 'string') {
    throw new InvalidParamsError('agent must be a string when provided');
  }
  if (params.session_id !== undefined && params.session_id !== null && typeof params.session_id !== 'string') {
    throw new InvalidParamsError('session_id must be string or null');
  }
  if (params.sessionKey !== undefined && params.sessionKey !== null && typeof params.sessionKey !== 'string') {
    throw new InvalidParamsError('sessionKey must be string or null');
  }
  if (params.stream !== undefined && typeof params.stream !== 'boolean') {
    throw new InvalidParamsError('stream must be boolean when provided');
  }

  if (!runtime.chatSend) {
    throw new UnsupportedRuntimeMethodError('chat.send');
  }

  const normalizedParams = {
    ...params,
    ...(typeof params.session_id === 'string' && params.session_id
      ? { session_id: params.session_id }
      : typeof params.sessionKey === 'string' && params.sessionKey
        ? { session_id: params.sessionKey }
        : {}),
  };

  const result = await runtime.chatSend(normalizedParams, ctx);
  if (isStreamResult(result) || isObject(result)) {
    return result;
  }
  throw new Error('chat.send returned unsupported result type');
}

export async function handleChatHistory(
  runtime: RelayRuntimeAdapter,
  params: Record<string, unknown>,
  ctx: RelayRequestContext,
): Promise<Record<string, unknown>> {
  if (typeof params.sessionKey !== 'string' || params.sessionKey.length === 0) {
    throw new InvalidParamsError('sessionKey is required');
  }
  if (params.limit !== undefined && typeof params.limit !== 'number') {
    throw new InvalidParamsError('limit must be numeric when provided');
  }
  if (!runtime.sessionsHistory) {
    throw new UnsupportedRuntimeMethodError('chat.history');
  }
  return runtime.sessionsHistory({
    session_id: params.sessionKey,
    ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
  }, ctx);
}
