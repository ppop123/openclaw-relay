import { InvalidParamsError, UnsupportedRuntimeMethodError } from '../errors.js';
import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleCronList(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new InvalidParamsError('cron.list does not accept parameters');
  }
  if (!runtime.cronList) {
    throw new UnsupportedRuntimeMethodError('cron.list');
  }
  return runtime.cronList(params, ctx);
}

export async function handleCronToggle(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.id !== 'string' || params.id.length === 0) {
    throw new InvalidParamsError('id is required');
  }
  if (typeof params.enabled !== 'boolean') {
    throw new InvalidParamsError('enabled must be boolean');
  }
  if (!runtime.cronToggle) {
    throw new UnsupportedRuntimeMethodError('cron.toggle');
  }
  return runtime.cronToggle(params, ctx);
}
