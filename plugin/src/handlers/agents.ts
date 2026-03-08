import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleAgentsList(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new Error('agents.list does not accept parameters');
  }
  if (!runtime.agentsList) {
    throw new Error('agents.list is not supported by this runtime');
  }
  return runtime.agentsList(params, ctx);
}

export async function handleAgentsInfo(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.agent !== 'string' || params.agent.length === 0) {
    throw new Error('agent is required');
  }
  if (!runtime.agentsInfo) {
    throw new Error('agents.info is not supported by this runtime');
  }
  return runtime.agentsInfo(params, ctx);
}
