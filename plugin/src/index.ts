import { createRelayPlugin, RelayPluginFactoryOptions } from './channel.js';
import { createOpenClawRelayPlugin, createRelayChannelDefinition } from './openclaw-host.js';
import type { OpenClawPluginApi } from './host-types.js';

export * from './channel.js';
export * from './commands/clients.js';
export * from './commands/disable.js';
export * from './commands/enable.js';
export * from './commands/pair.js';
export * from './config.js';
export * from './crypto.js';
export * from './errors.js';
export * from './gateway-adapter.js';
export * from './host-types.js';
export * from './openclaw-host.js';
export * from './outbound.js';
export * from './outbound-peer-session.js';
export * from './pairing.js';
export * from './peer-agent-service.js';
export * from './peer-discovery.js';
export * from './relay-connection.js';
export * from './status.js';
export * from './transport.js';
export * from './types.js';

const relayPlugin = {
  id: 'relay',
  name: 'OpenClaw Relay',
  description: 'OpenClaw Relay channel plugin',
  configSchema: {
    parse(value: unknown) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    },
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  register(api: OpenClawPluginApi) {
    const preview = createRelayChannelDefinition();
    const { channelPlugin, registerCli } = createOpenClawRelayPlugin(api, preview);
    api.registerChannel({ plugin: channelPlugin });
    registerCli();
  },
};

export default relayPlugin;

export function createPreviewRelayPlugin(options: RelayPluginFactoryOptions) {
  return createRelayPlugin(options);
}
