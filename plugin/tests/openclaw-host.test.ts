import { describe, expect, it, vi } from 'vitest';
import relayPlugin from '../src/index.js';
import { createOpenClawRelayPlugin, createRelayAgentBridge, createRelayChannelDefinition } from '../src/openclaw-host.js';
import { RelayGatewayAdapter } from '../src/gateway-adapter.js';
import type { OpenClawConfig, OpenClawPluginApi } from '../src/host-types.js';

function buildApi(initialConfig: OpenClawConfig = {}): OpenClawPluginApi & {
  registeredChannel?: unknown;
  registeredCli?: unknown;
  registeredGatewayMethods: Map<string, (ctx: {
    req: Record<string, unknown>;
    params: Record<string, unknown>;
    client: Record<string, unknown> | null;
    isWebchatConnect: (params: Record<string, unknown> | null | undefined) => boolean;
    respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }, meta?: Record<string, unknown>) => void;
    context: Record<string, unknown>;
  }) => Promise<void> | void>;
  writeConfigFileMock: ReturnType<typeof vi.fn>;
  readConfig(): OpenClawConfig;
} {
  let currentConfig = structuredClone(initialConfig);
  const writeConfigFileMock = vi.fn(async (next: OpenClawConfig) => {
    currentConfig = structuredClone(next);
  });

  return {
    id: 'relay',
    name: 'OpenClaw Relay',
    registeredGatewayMethods: new Map(),
    config: currentConfig,
    runtime: {
      version: 'test',
      config: {
        loadConfig: () => currentConfig,
        writeConfigFile: writeConfigFileMock,
      },
      system: {},
      state: {
        resolveStateDir: () => '/tmp/openclaw-test',
      },
    },
    writeConfigFileMock,
    readConfig: () => currentConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerChannel(registration) {
      this.registeredChannel = registration;
    },
    registerGatewayMethod(method, handler) {
      this.registeredGatewayMethods.set(method, handler);
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

async function callGatewayMethod(
  api: ReturnType<typeof buildApi>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ ok: boolean; payload?: unknown; error?: { code: string; message: string }; meta?: Record<string, unknown> }> {
  const handler = api.registeredGatewayMethods.get(method);
  if (!handler) {
    throw new Error(`gateway method not registered: ${method}`);
  }
  return await new Promise((resolve, reject) => {
    let responded = false;
    Promise.resolve(handler({
      req: { id: 'req-1', type: 'request', method, params },
      params,
      client: { kind: 'local' },
      isWebchatConnect: () => false,
      respond: (ok, payload, error, meta) => {
        responded = true;
        resolve({ ok, payload, error, meta });
      },
      context: {},
    })).then(() => {
      if (!responded) {
        reject(new Error(`gateway method did not respond: ${method}`));
      }
    }, reject);
  });
}

describe('openclaw host bridge', () => {
  it('registers channel and CLI with the real plugin entry', () => {
    const api = buildApi();
    relayPlugin.register(api);
    expect(api.registeredChannel).toBeTruthy();
    expect(api.registeredCli).toBeTypeOf('function');
  });

  it('registers local gateway methods for peer orchestration', async () => {
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

    const incomingRequest = {
      source: 'peer-key',
      envelope: { version: 1 as const, kind: 'invite_request', body: { hello: 'world' } },
      receivedAt: '2026-03-09T00:00:00.000Z',
      raw: { type: 'signal' as const, source: 'peer-key', ephemeral_key: 'ephemeral', payload: 'payload' },
    };
    const incomingOffer = {
      source: 'peer-key',
      envelope: {
        version: 1 as const,
        kind: 'invite_offer',
        body: {
          invite_token: 'invite-token',
          expires_at: '2026-03-09T00:05:00.000Z',
          peer_authorized_until: '2026-03-09T00:05:00.000Z',
        },
      },
      receivedAt: '2026-03-09T00:01:00.000Z',
      raw: { type: 'signal' as const, source: 'peer-key', ephemeral_key: 'ephemeral', payload: 'payload-2' },
    };

    const startSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'stop').mockResolvedValue(undefined);
    const statusSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'getStatus').mockResolvedValue({
      state: 'registered',
      health: 'healthy',
      approvedClients: 0,
      activeSessions: 0,
      peerDiscovery: { enabled: true, publicKey: 'pub', pendingSignals: 1, pendingSignalErrors: 1 },
    });
    const discoverSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'discoverPeers').mockResolvedValue([
      { public_key: 'peer-key', metadata: { label: 'Peer' }, online_since: '2026-03-09T00:00:00.000Z' },
    ] as any);
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
    const fakePeerSession = {
      request: vi.fn(async () => ({ ok: true, version: 'remote' })),
      requestStream: vi.fn(),
      close: vi.fn(async () => undefined),
      isConnected: true,
    };
    const dialPeerSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'dialPeerInvite').mockResolvedValue(fakePeerSession as any);
    const drainSignalsSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'drainPeerSignals')
      .mockReturnValueOnce([incomingRequest] as any)
      .mockReturnValue([] as any);
    const drainSignalErrorsSpy = vi.spyOn(RelayGatewayAdapter.prototype, 'drainPeerSignalErrors').mockReturnValue([] as any);

    let api: ReturnType<typeof buildApi> | undefined;

    try {
      api = buildApi(config);
      const preview = createRelayChannelDefinition();
      createOpenClawRelayPlugin(api, preview);

      expect(api.registeredGatewayMethods.has('relay.peer.discover')).toBe(true);
      expect(api.registeredGatewayMethods.has('relay.peer.dial')).toBe(true);
      expect(api.registeredGatewayMethods.has('relay.peer.call')).toBe(true);

      const discoverResult = await callGatewayMethod(api, 'relay.peer.discover', { timeoutMs: 4321 });
      expect(discoverResult.ok).toBe(true);
      expect(discoverResult.payload).toMatchObject({ accountId: 'default' });
      expect(discoverSpy).toHaveBeenCalledTimes(1);

      const requestResult = await callGatewayMethod(api, 'relay.peer.request', {
        targetPublicKey: 'peer-key',
        body: { purpose: 'test' },
      });
      expect(requestResult.ok).toBe(true);
      expect(sendSignalSpy).toHaveBeenCalledWith('peer-key', {
        version: 1,
        kind: 'invite_request',
        body: { purpose: 'test' },
      });

      const pollResult = await callGatewayMethod(api, 'relay.peer.poll');
      expect(pollResult.ok).toBe(true);
      expect(pollResult.payload).toMatchObject({
        signals: [
          {
            source: 'peer-key',
            kind: 'invite_request',
            body: { hello: 'world' },
          },
        ],
      });

      const acceptResult = await callGatewayMethod(api, 'relay.peer.accept', {
        signal: incomingRequest,
        ttlSeconds: 45,
        maxUses: 1,
        body: { accepted_by: 'owner' },
      });
      expect(acceptResult.ok).toBe(true);
      expect(authorizePeerSpy).toHaveBeenCalledWith('peer-key', 45, 1);
      expect(createInviteSpy).toHaveBeenCalledWith(45);
      expect(sendSignalSpy).toHaveBeenLastCalledWith('peer-key', {
        version: 1,
        kind: 'invite_offer',
        body: {
          invite_token: 'invite-token',
          expires_at: '2026-03-09T00:05:00.000Z',
          peer_authorized_until: '2026-03-09T00:05:00.000Z',
          accepted_by: 'owner',
        },
      });

      const connectResult = await callGatewayMethod(api, 'relay.peer.connect', {
        signal: incomingOffer,
        clientId: 'peer-client-7',
      });
      expect(connectResult.ok).toBe(true);
      expect(dialPeerSpy).toHaveBeenCalledWith('invite-token', 'peer-key', 'peer-client-7');

      const statusResult = await callGatewayMethod(api, 'relay.peer.status');
      expect(statusResult.ok).toBe(true);
      expect(statusResult.payload).toMatchObject({ connectedPeers: ['peer-key'] });

      const callResult = await callGatewayMethod(api, 'relay.peer.call', {
        peerPublicKey: 'peer-key',
        method: 'system.status',
        params: {},
      });
      expect(callResult.ok).toBe(true);
      expect(fakePeerSession.request).toHaveBeenCalledWith('system.status', {});
      expect(callResult.payload).toMatchObject({ result: { ok: true, version: 'remote' } });

      const disconnectResult = await callGatewayMethod(api, 'relay.peer.disconnect', {
        peerPublicKey: 'peer-key',
      });
      expect(disconnectResult.ok).toBe(true);
      expect(disconnectResult.payload).toMatchObject({ connectedPeers: [] });
      expect(fakePeerSession.close).toHaveBeenCalledTimes(1);

      drainSignalsSpy.mockReturnValueOnce([incomingOffer] as any);
      const dialResult = await callGatewayMethod(api, 'relay.peer.dial', {
        targetPublicKey: 'peer-key',
        body: { purpose: 'dial' },
        clientId: 'peer-client-8',
        timeoutMs: 500,
        pollIntervalMs: 1,
      });
      expect(dialResult.ok).toBe(true);
      expect(dialResult.payload).toMatchObject({
        peerPublicKey: 'peer-key',
        connected: true,
        reusedSession: false,
      });
      expect(sendSignalSpy).toHaveBeenCalledWith('peer-key', {
        version: 1,
        kind: 'invite_request',
        body: { purpose: 'dial' },
      });
      expect(dialPeerSpy).toHaveBeenLastCalledWith('invite-token', 'peer-key', 'peer-client-8');

      await callGatewayMethod(api, 'relay.peer.disconnect');
      await stopSpy.mock.results[0]?.value;
      await callGatewayMethod(api, 'relay.peer.status');
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(statusSpy).toHaveBeenCalled();
      expect(drainSignalsSpy).toHaveBeenCalled();
      expect(drainSignalErrorsSpy).toHaveBeenCalled();
    } finally {
      if (api) {
        await createRelayAgentBridge(api).stopAccount();
      }
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

  it('updates discovery metadata through the relay enable CLI', async () => {
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
              peerDiscovery: {
                enabled: false,
                metadata: { region: 'cn' },
              },
            },
          },
        },
      },
    };

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
      const enableAction = program.children.get('relay')?.children.get('enable')?.actionHandler;
      expect(enableAction).toBeTypeOf('function');

      await enableAction?.({
        server: 'ws://relay.example/ws',
        account: 'default',
        discoverLabel: 'Shanghai Lab',
        discoverMetadataJson: '{"region":"cn-sha","tier":"prod"}',
        peerAutoAccept: true,
        peerAutoAcceptTtl: '60',
        peerAutoAcceptMaxUses: '1',
      });

      expect(api.writeConfigFileMock).toHaveBeenCalled();
      const updatedAccount = (((api.readConfig().channels as Record<string, any>).relay as Record<string, any>).accounts as Record<string, any>).default;
      expect(updatedAccount.peerDiscovery).toEqual({
        enabled: false,
        metadata: {
          region: 'cn-sha',
          tier: 'prod',
          label: 'Shanghai Lab',
        },
        autoAcceptRequests: {
          enabled: true,
          ttlSeconds: 60,
          maxUses: 1,
        },
      });
      expect(logs.some((line) => line.includes('peerDiscoveryMetadata'))).toBe(true);

      await enableAction?.({
        server: 'ws://relay.example/ws',
        account: 'default',
        clearDiscoveryMetadata: true,
      });

      const clearedAccount = (((api.readConfig().channels as Record<string, any>).relay as Record<string, any>).accounts as Record<string, any>).default;
      expect(clearedAccount.peerDiscovery).toEqual({
        enabled: false,
        autoAcceptRequests: {
          enabled: true,
          ttlSeconds: 60,
          maxUses: 1,
        },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('rejects invalid discovery metadata JSON from the relay enable CLI', async () => {
    const api = buildApi();
    const preview = createRelayChannelDefinition();
    const { registerCli } = createOpenClawRelayPlugin(api, preview);
    const program = buildProgram();
    registerCli();
    const registrar = api.registeredCli as (ctx: { program: FakeCommand; logger: any }) => void;
    registrar({ program, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    const enableAction = program.children.get('relay')?.children.get('enable')?.actionHandler;
    expect(enableAction).toBeTypeOf('function');

    await expect(enableAction?.({
      server: 'ws://relay.example/ws',
      account: 'default',
      discoverMetadataJson: '[1,2,3]',
    })).rejects.toThrow('--discover-metadata-json must be a JSON object');
  });

});
