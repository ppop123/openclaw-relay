export type JsonObject = Record<string, unknown>;

export interface AgentConfigEntry extends JsonObject {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  tools?: Record<string, unknown>;
}

export interface OpenClawConfig extends JsonObject {
  channels?: Record<string, unknown>;
  agents?: {
    list?: AgentConfigEntry[];
  };
}

export interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface OpenClawRuntime {
  version: string;
  config: {
    loadConfig: () => OpenClawConfig;
    writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
  };
  system: {
    requestHeartbeatNow?: () => void;
  };
  state?: {
    resolveStateDir?: () => string;
  };
}

export interface OpenClawChannelRuntime {
  reply?: {
    dispatchReplyWithBufferedBlockDispatcher?: (params: {
      ctx: Record<string, unknown>;
      cfg: OpenClawConfig;
      dispatcherOptions: {
        deliver: (payload: { text?: string; body?: string; isReasoning?: boolean; isError?: boolean }) => Promise<void> | void;
        onReplyStart?: () => Promise<void> | void;
      };
      replyOptions?: {
        abortSignal?: AbortSignal;
        suppressTyping?: boolean;
      };
    }) => Promise<unknown>;
    finalizeInboundContext?: <T extends Record<string, unknown>>(ctx: T) => T & { CommandAuthorized: boolean };
  };
  routing?: {
    resolveAgentRoute?: (params: {
      cfg: OpenClawConfig;
      channel: string;
      accountId?: string | null;
      peer?: { kind: string; id: string } | null;
    }) => {
      agentId: string;
      sessionKey: string;
      accountId: string;
    };
  };
}

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  config: OpenClawConfig;
  runtime: OpenClawRuntime;
  logger: PluginLogger;
  registerChannel: (registration: { plugin: ChannelPlugin<any> } | ChannelPlugin<any>) => void;
  registerGatewayMethod: (
    method: string,
    handler: (ctx: {
      req: Record<string, unknown>;
      params: Record<string, unknown>;
      client: Record<string, unknown> | null;
      isWebchatConnect: (params: Record<string, unknown> | null | undefined) => boolean;
      respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }, meta?: Record<string, unknown>) => void;
      context: Record<string, unknown>;
    }) => Promise<void> | void,
  ) => void;
  registerCli: (registrar: (ctx: { program: any; config: OpenClawConfig; logger: PluginLogger }) => void | Promise<void>, opts?: { commands?: string[] }) => void;
}

export interface ChannelAccountSnapshot extends JsonObject {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  publicKey?: string | null;
  peerDiscoveryAutoAcceptEnabled?: boolean;
}

export interface ChannelMeta extends JsonObject {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  order?: number;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
}

export interface ChannelCapabilities extends JsonObject {
  chatTypes: Array<'direct' | 'group' | 'channel' | 'thread'>;
  media?: boolean;
  polls?: boolean;
  reactions?: boolean;
  threads?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
}

export interface ChannelGatewayContext<ResolvedAccount = unknown> {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: unknown;
  abortSignal: AbortSignal;
  log?: PluginLogger;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
  channelRuntime?: OpenClawChannelRuntime;
}

export interface ChannelPlugin<ResolvedAccount = unknown> {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  reload?: {
    configPrefixes: string[];
    noopPrefixes?: string[];
  };
  configSchema?: {
    schema: Record<string, unknown>;
    uiHints?: Record<string, Record<string, unknown>>;
  };
  config: {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    defaultAccountId?: (cfg: OpenClawConfig) => string;
    setAccountEnabled?: (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) => OpenClawConfig;
    deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
    isEnabled?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean;
    isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
    describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
  };
  status?: {
    defaultRuntime?: ChannelAccountSnapshot;
    buildAccountSnapshot?: (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      runtime?: ChannelAccountSnapshot;
    }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
  };
  gateway?: {
    startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
    stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  };
}
