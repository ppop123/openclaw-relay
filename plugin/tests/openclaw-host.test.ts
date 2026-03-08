import { describe, expect, it, vi } from 'vitest';
import relayPlugin from '../src/index.js';
import { createOpenClawRelayPlugin, createRelayAgentBridge, createRelayChannelDefinition } from '../src/openclaw-host.js';
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
              peerDiscovery: { enabled: true },
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
      peerDiscoveryEnabled: true,
    });
  });

  it('provides a host-only agent bridge for peer discovery controls', async () => {
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
              peerDiscovery: { enabled: true },
            },
          },
        },
      },
    };

    const peers = [{ public_key: 'peer-key', metadata: { label: 'Peer' }, online_since: '2026-03-09T00:00:00.000Z' }];
    const signals = [{
      source: 'peer-key',
      envelope: { version: 1 as const, kind: 'invite_request', body: { hello: 'world' } },
      receivedAt: '2026-03-09T00:00:00.000Z',
      raw: { type: 'signal', source: 'peer-key', ephemeral_key: 'ephemeral', payload: 'payload' },
    }];
    const signalErrors = [{ type: 'signal_error', code: 'peer_offline', message: 'offline', target: 'peer-key' }];

    const startSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'stop').mockResolvedValue(undefined);
    const statusSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'getStatus').mockResolvedValue({
      state: 'registered',
      health: 'healthy',
      approvedClients: 0,
      activeSessions: 0,
      peerDiscovery: { enabled: true, publicKey: 'pub', pendingSignals: 1, pendingSignalErrors: 1 },
    });
    const discoverSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'discoverPeers').mockResolvedValue(peers as any);
    const sendSignalSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'sendPeerSignal').mockResolvedValue(undefined);
    const authorizePeerSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'authorizePeerPublicKey').mockResolvedValue({
      fingerprint: 'sha256:peer',
      expiresAt: '2026-03-09T00:05:00.000Z',
    });
    const createInviteSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'createPeerInvite').mockResolvedValue({
      inviteToken: 'invite-token',
      inviteHash: 'invite-hash',
      expiresAt: '2026-03-09T00:05:00.000Z',
    });
    const fakePeerSession = { request: vi.fn(), requestStream: vi.fn(), close: vi.fn(), isConnected: true };
    const dialPeerSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'dialPeerInvite').mockResolvedValue(fakePeerSession as any);
    const drainSignalsSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'drainPeerSignals').mockReturnValue(signals as any);
    const drainSignalErrorsSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'drainPeerSignalErrors').mockReturnValue(signalErrors as any);

    try {
      const api = buildApi(config);
      const bridge = createRelayAgentBridge(api);

      await expect(bridge.discoverPeers()).resolves.toEqual(peers);
      await expect(bridge.ensureStarted()).resolves.toMatchObject({ state: 'registered' });
      await bridge.sendPeerSignal('peer-key', { version: 1, kind: 'invite_request', body: { hello: 'world' } });
      await expect(bridge.createPeerInvite({ ttlSeconds: 90 })).resolves.toEqual({
        inviteToken: 'invite-token',
        inviteHash: 'invite-hash',
        expiresAt: '2026-03-09T00:05:00.000Z',
      });
      await expect(bridge.acceptPeerSignal('peer-key', { ttlSeconds: 45, maxUses: 1 })).resolves.toEqual({
        sourcePublicKey: 'peer-key',
        fingerprint: 'sha256:peer',
        peerAuthorizedUntil: '2026-03-09T00:05:00.000Z',
        inviteToken: 'invite-token',
        inviteHash: 'invite-hash',
        expiresAt: '2026-03-09T00:05:00.000Z',
      });
      await expect(bridge.dialPeerInvite('invite-token', 'peer-key', { clientId: 'peer-client-9' })).resolves.toBe(fakePeerSession);
      expect(bridge.drainPeerSignals()).toEqual(signals);
      expect(bridge.drainPeerSignalErrors()).toEqual(signalErrors);
      await expect(bridge.getStatus()).resolves.toMatchObject({ state: 'registered' });

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      expect(sendSignalSpy).toHaveBeenCalledWith('peer-key', { version: 1, kind: 'invite_request', body: { hello: 'world' } });
      expect(authorizePeerSpy).toHaveBeenCalledWith('peer-key', 45, 1);
      expect(createInviteSpy).toHaveBeenNthCalledWith(1, 90);
      expect(createInviteSpy).toHaveBeenNthCalledWith(2, 45);
      expect(dialPeerSpy).toHaveBeenCalledWith('invite-token', 'peer-key', 'peer-client-9');
      await bridge.stopAccount();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      statusSpy.mockRestore();
      discoverSpy.mockRestore();
      sendSignalSpy.mockRestore();
      authorizePeerSpy.mockRestore();
      createInviteSpy.mockRestore();
      dialPeerSpy.mockRestore();
      drainSignalsSpy.mockRestore();
      drainSignalErrorsSpy.mockRestore();
    }
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
