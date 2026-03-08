import { describe, expect, it, vi } from 'vitest';
import relayPlugin from '../src/index.js';
import { createOpenClawRelayPlugin, createRelayChannelDefinition } from '../src/openclaw-host.js';
import { RelayGatewayAdapter } from '../src/gateway-adapter.js';
import type { OpenClawConfig, OpenClawPluginApi } from '../src/host-types.js';

function buildApi(config: OpenClawConfig = {}): OpenClawPluginApi & {
  registeredChannel?: unknown;
  registeredCli?: unknown;
} {
  return {
    id: 'relay',
    name: 'OpenClaw Relay',
    config,
    runtime: {
      version: 'test',
      config: {
        loadConfig: () => config,
        writeConfigFile: vi.fn(async () => undefined),
      },
      system: {},
      state: {
        resolveStateDir: () => '/tmp/openclaw-test',
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerChannel(registration) {
      this.registeredChannel = registration;
    },
    registerCli(registrar) {
      this.registeredCli = registrar;
    },
  };
}


class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  actionHandler: ((options: any) => Promise<void> | void) | undefined;

  constructor(readonly name: string) {}

  command(name: string) {
    const child = new FakeCommand(name);
    this.children.set(name, child);
    return child;
  }

  description() { return this; }
  option() { return this; }
  requiredOption() { return this; }
  action(handler: (options: any) => Promise<void> | void) {
    this.actionHandler = handler;
    return this;
  }
}

function buildProgram() {
  return new FakeCommand('root');
}

describe('openclaw host bridge', () => {
  it('registers channel and CLI with the real plugin entry', () => {
    const api = buildApi();
    relayPlugin.register(api);
    expect(api.registeredChannel).toBeTruthy();
    expect(api.registeredCli).toBeTypeOf('function');
  });

  it('resolves configured relay accounts from OpenClaw config', () => {
    const config: OpenClawConfig = {
      channels: {
        relay: {
          accounts: {
            default: {
              enabled: true,
              server: 'ws://relay.example/ws',
              channelToken: 'token',
              gatewayKeyPair: {
                privateKey: 'priv',
                publicKey: 'pub',
              },
              approvedClients: {},
              discovery: { enabled: true },
            },
          },
        },
      },
    };
    const api = buildApi(config);
    const preview = createRelayChannelDefinition();
    const { channelPlugin } = createOpenClawRelayPlugin(api, preview);

    expect(channelPlugin.config.listAccountIds(config)).toEqual(['default']);
    const account = channelPlugin.config.resolveAccount(config, 'default');
    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
    expect(account.server).toBe('ws://relay.example/ws');

    const snapshot = channelPlugin.config.describeAccount?.(account, config);
    expect(snapshot).toMatchObject({
      accountId: 'default',
      configured: true,
      enabled: true,
      publicKey: 'pub',
      discoveryEnabled: true,
    });
  });

  it('keeps gateway startAccount pending until abort', async () => {
    const config: OpenClawConfig = {
      channels: {
        relay: {
          accounts: {
            default: {
              enabled: true,
              server: 'ws://relay.example/ws',
              channelToken: 'token-123',
              gatewayKeyPair: {
                privateKey: 'priv',
                publicKey: 'pub',
              },
              approvedClients: {},
            },
          },
        },
      },
    };
    const startSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'stop').mockResolvedValue(undefined);
    const statusSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'getStatus').mockResolvedValue({
      state: 'registered',
      health: 'healthy',
      approvedClients: 0,
      activeSessions: 0,
    });

    try {
      const api = buildApi(config);
      const preview = createRelayChannelDefinition();
      const { channelPlugin } = createOpenClawRelayPlugin(api, preview);

      const snapshots: Array<Record<string, unknown>> = [];
      const abortController = new AbortController();
      const pending = channelPlugin.gateway!.startAccount!({
        cfg: config,
        accountId: 'default',
        account: channelPlugin.config.resolveAccount(config, 'default'),
        runtime: {} as never,
        abortSignal: abortController.signal,
        log: { info() {}, warn() {}, error() {}, debug() {} },
        getStatus: () => ({ accountId: 'default' }),
        setStatus: (next) => {
          snapshots.push(next as unknown as Record<string, unknown>);
        },
      });

      await Promise.resolve();
      await Promise.resolve();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(snapshots.some((snapshot) => snapshot.running === true)).toBe(true);

      abortController.abort();
      await pending;
      expect(settled).toBe(true);
      expect(startSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  it('uses adapter inspection to detect pairing completion', async () => {
    const publicKey = Buffer.alloc(32).toString('base64');
    const config: OpenClawConfig = {
      channels: {
        relay: {
          accounts: {
            default: {
              enabled: true,
              server: 'ws://relay.example/ws',
              channelToken: 'token-123',
              gatewayKeyPair: {
                privateKey: 'priv',
                publicKey,
              },
              approvedClients: {},
            },
          },
        },
      },
    };
    const startSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'stop').mockResolvedValue(undefined);
    const statusSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'getStatus').mockResolvedValue({
      state: 'registered',
      health: 'healthy',
      approvedClients: 0,
      activeSessions: 0,
    });
    const inspectSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'inspectAccount')
      .mockResolvedValue({
        enabled: true,
        server: 'ws://relay.example/ws',
        channel: 'channel-hash',
        gatewayPublicKey: publicKey,
        approvedClients: [{ fingerprint: 'sha256:test' }],
      });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''));
    });

    try {
      const api = buildApi(config);
      const preview = createRelayChannelDefinition();
      const { registerCli } = createOpenClawRelayPlugin(api, preview);
      const program = buildProgram();
      registerCli();
      const registrar = api.registeredCli as (ctx: { program: FakeCommand; logger: any }) => void;
      registrar({ program, logger: { info() {}, warn() {}, error() {}, debug() {} } });
      const pairAction = program.children.get('relay')?.children.get('pair')?.actionHandler;
      expect(pairAction).toBeTypeOf('function');

      await pairAction?.({ account: 'default', wait: '5' });

      expect(inspectSpy).toHaveBeenCalled();
      expect(logs.some((line) => line.includes('"paired": true'))).toBe(true);
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      statusSpy.mockRestore();
      inspectSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

});
