import { InvalidParamsError, UnsupportedRuntimeMethodError } from '../errors.js';
import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new InvalidParamsError(`${label} must be a string when provided`);
  }
}

function assertOptionalNumber(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'number') {
    throw new InvalidParamsError(`${label} must be numeric when provided`);
  }
}

function assertOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new InvalidParamsError(`${label} must be boolean when provided`);
  }
}

function assertStringRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParamsError(`${label} must be an object when provided`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw new InvalidParamsError(`${label}.${key} must be a string`);
    }
  }
}

export async function handleConfigGet(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new InvalidParamsError('config.get does not accept parameters');
  }
  if (!runtime.configGet) {
    throw new UnsupportedRuntimeMethodError('config.get');
  }
  return runtime.configGet(params, ctx);
}

export async function handleConfigSet(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.raw !== 'string') {
    throw new InvalidParamsError('raw is required');
  }
  assertOptionalString(params.baseHash, 'baseHash');
  if (!runtime.configSet) {
    throw new UnsupportedRuntimeMethodError('config.set');
  }
  return runtime.configSet(params, ctx);
}

export async function handleConfigApply(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.raw !== 'string') {
    throw new InvalidParamsError('raw is required');
  }
  assertOptionalString(params.baseHash, 'baseHash');
  assertOptionalString(params.sessionKey, 'sessionKey');
  assertOptionalString(params.note, 'note');
  assertOptionalNumber(params.restartDelayMs, 'restartDelayMs');
  if (!runtime.configApply) {
    throw new UnsupportedRuntimeMethodError('config.apply');
  }
  return runtime.configApply(params, ctx);
}

export async function handleLogsTail(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  assertOptionalNumber(params.cursor, 'cursor');
  assertOptionalNumber(params.limit, 'limit');
  assertOptionalNumber(params.maxBytes, 'maxBytes');
  if (!runtime.logsTail) {
    throw new UnsupportedRuntimeMethodError('logs.tail');
  }
  return runtime.logsTail(params, ctx);
}

export async function handleSkillsStatus(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  assertOptionalString(params.agentId, 'agentId');
  if (!runtime.skillsStatus) {
    throw new UnsupportedRuntimeMethodError('skills.status');
  }
  return runtime.skillsStatus(params, ctx);
}

export async function handleSkillsUpdate(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.skillKey !== 'string' || params.skillKey.length === 0) {
    throw new InvalidParamsError('skillKey is required');
  }
  assertOptionalBoolean(params.enabled, 'enabled');
  assertOptionalString(params.apiKey, 'apiKey');
  assertStringRecord(params.env, 'env');
  if (!runtime.skillsUpdate) {
    throw new UnsupportedRuntimeMethodError('skills.update');
  }
  return runtime.skillsUpdate(params, ctx);
}

export async function handleSkillsInstall(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.name !== 'string' || params.name.length === 0) {
    throw new InvalidParamsError('name is required');
  }
  if (typeof params.installId !== 'string' || params.installId.length === 0) {
    throw new InvalidParamsError('installId is required');
  }
  assertOptionalNumber(params.timeoutMs, 'timeoutMs');
  if (!runtime.skillsInstall) {
    throw new UnsupportedRuntimeMethodError('skills.install');
  }
  return runtime.skillsInstall(params, ctx);
}

export async function handleUpdateRun(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  assertOptionalString(params.sessionKey, 'sessionKey');
  assertOptionalString(params.note, 'note');
  assertOptionalNumber(params.restartDelayMs, 'restartDelayMs');
  assertOptionalNumber(params.timeoutMs, 'timeoutMs');
  if (!runtime.updateRun) {
    throw new UnsupportedRuntimeMethodError('update.run');
  }
  return runtime.updateRun(params, ctx);
}

export async function handleGatewayRestart(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new InvalidParamsError('gateway.restart does not accept parameters');
  }
  if (!runtime.gatewayRestart) {
    throw new UnsupportedRuntimeMethodError('gateway.restart');
  }
  return runtime.gatewayRestart(params, ctx);
}
