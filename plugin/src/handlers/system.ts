import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleSystemStatus(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new Error('system.status does not accept parameters');
  }
  if (!runtime.systemStatus) {
    throw new Error('system.status is not supported by this runtime');
  }
  return runtime.systemStatus(params, ctx);
}
