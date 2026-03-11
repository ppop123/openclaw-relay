import { Layer2Message, RelayRequestContext, RelayRuntimeAdapter, RelayStreamResult, RequestMessage } from './types.js';
import { handleAgentsInfo, handleAgentsList } from './handlers/agents.js';
import {
  handleConfigApply,
  handleConfigGet,
  handleConfigSet,
  handleGatewayRestart,
  handleLogsTail,
  handleSkillsInstall,
  handleSkillsStatus,
  handleSkillsUpdate,
  handleUpdateRun,
} from './handlers/admin.js';
import { handleChatHistory, handleChatSend } from './handlers/chat.js';
import { handleCronList, handleCronToggle } from './handlers/cron.js';
import { handleSessionsHistory, handleSessionsList } from './handlers/sessions.js';
import { handleSystemStatus } from './handlers/system.js';

export async function dispatchRequest(
  runtime: RelayRuntimeAdapter,
  msg: RequestMessage,
  ctx: RelayRequestContext,
): Promise<Record<string, unknown> | RelayStreamResult> {
  switch (msg.method) {
    case 'chat.send':
      return handleChatSend(runtime, msg.params, ctx);
    case 'chat.history':
      return handleChatHistory(runtime, msg.params, ctx);
    case 'agents.list':
      return handleAgentsList(runtime, msg.params, ctx);
    case 'agents.info':
      return handleAgentsInfo(runtime, msg.params, ctx);
    case 'sessions.list':
      return handleSessionsList(runtime, msg.params, ctx);
    case 'sessions.history':
      return handleSessionsHistory(runtime, msg.params, ctx);
    case 'cron.list':
      return handleCronList(runtime, msg.params, ctx);
    case 'cron.toggle':
      return handleCronToggle(runtime, msg.params, ctx);
    case 'system.status':
      return handleSystemStatus(runtime, msg.params, ctx);
    case 'config.get':
      return handleConfigGet(runtime, msg.params, ctx);
    case 'config.set':
      return handleConfigSet(runtime, msg.params, ctx);
    case 'config.apply':
      return handleConfigApply(runtime, msg.params, ctx);
    case 'logs.tail':
      return handleLogsTail(runtime, msg.params, ctx);
    case 'skills.status':
      return handleSkillsStatus(runtime, msg.params, ctx);
    case 'skills.update':
      return handleSkillsUpdate(runtime, msg.params, ctx);
    case 'skills.install':
      return handleSkillsInstall(runtime, msg.params, ctx);
    case 'update.run':
      return handleUpdateRun(runtime, msg.params, ctx);
    case 'gateway.restart':
      return handleGatewayRestart(runtime, msg.params, ctx);
    default:
      throw new MethodNotFoundError(msg.method);
  }
}

export function isRequestMessage(msg: Layer2Message): msg is RequestMessage {
  return msg.type === 'request' && typeof msg.id === 'string' && typeof msg.method === 'string';
}

export class MethodNotFoundError extends Error {
  constructor(method: string) {
    super(`Unknown method: ${method}`);
    this.name = 'MethodNotFoundError';
  }
}
