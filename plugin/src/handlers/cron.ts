import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleCronList(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new Error('cron.list does not accept parameters');
  }
  if (!runtime.cronList) {
    throw new Error('cron.list is not supported by this runtime');
  }
  return runtime.cronList(params, ctx);
}

export async function handleCronToggle(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.id !== 'string' || params.id.length === 0) {
    throw new Error('id is required');
  }
  if (typeof params.enabled !== 'boolean') {
    throw new Error('enabled must be boolean');
  }
  if (!runtime.cronToggle) {
    throw new Error('cron.toggle is not supported by this runtime');
  }
  return runtime.cronToggle(params, ctx);
}
