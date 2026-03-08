import { InvalidParamsError, UnsupportedRuntimeMethodError } from '../errors.js';
import { RelayRuntimeAdapter, RelayRequestContext } from '../types.js';

export async function handleAgentsList(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (Object.keys(params).length > 0) {
    throw new InvalidParamsError('agents.list does not accept parameters');
  }
  if (!runtime.agentsList) {
    throw new UnsupportedRuntimeMethodError('agents.list');
  }
  return runtime.agentsList(params, ctx);
}

export async function handleAgentsInfo(runtime: RelayRuntimeAdapter, params: Record<string, unknown>, ctx: RelayRequestContext): Promise<Record<string, unknown>> {
  if (typeof params.agent !== 'string' || params.agent.length === 0) {
    throw new InvalidParamsError('agent is required');
  }
  if (!runtime.agentsInfo) {
    throw new UnsupportedRuntimeMethodError('agents.info');
  }
  return runtime.agentsInfo(params, ctx);
}
