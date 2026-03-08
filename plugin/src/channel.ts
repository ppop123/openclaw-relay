import { inspectAccount } from './config.js';
import { RelayGatewayAdapter } from './gateway-adapter.js';
import { PairingManager } from './pairing.js';
import { RelayConfigStore, RelayRuntimeAdapter, WebSocketFactory } from './types.js';

export interface RelayPluginFactoryOptions {
  configStore: RelayConfigStore;
  runtime: RelayRuntimeAdapter;
  webSocketFactory?: WebSocketFactory;
  pairingManager?: PairingManager;
}

export function createRelayPlugin(options: RelayPluginFactoryOptions) {
  const adapters = new Map<string, RelayGatewayAdapter>();
  const pairingManager = options.pairingManager ?? new PairingManager();

  return {
    id: 'relay',
    name: 'OpenClaw Relay',
    config: {
      listAccountIds: async () => options.configStore.listAccountIds(),
      resolveAccount: async (accountId: string) => options.configStore.load(accountId),
      inspectAccount: async (accountId: string) => {
        const account = await options.configStore.load(accountId);
        return account ? inspectAccount(account) : undefined;
      },
    },
    gateway: {
      startAccount: async (accountId = 'default') => {
        const existing = adapters.get(accountId);
        if (existing) return existing;
        const adapter = new RelayGatewayAdapter({
          accountId,
          configStore: options.configStore,
          runtime: options.runtime,
          pairingManager,
          ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
        });
        try {
          await adapter.start();
          adapters.set(accountId, adapter);
          return adapter;
        } catch (error) {
          await adapter.stop().catch(() => undefined);
          adapters.delete(accountId);
          throw error;
        }
      },
      stopAccount: async (accountId = 'default') => {
        const adapter = adapters.get(accountId);
        if (!adapter) return;
        await adapter.stop();
        adapters.delete(accountId);
      },
      getAdapter: (accountId = 'default') => adapters.get(accountId),
    },
    status: {
      get: async (accountId = 'default') => adapters.get(accountId)?.getStatus(),
    },
    pairing: pairingManager,
  };
}
