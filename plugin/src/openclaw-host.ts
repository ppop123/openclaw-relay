import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { handleRelayClients, handleRelayRevoke } from './commands/clients.js';
import { handleRelayDisable, handleRelayRotateToken } from './commands/disable.js';
import { handleRelayEnable } from './commands/enable.js';
import { handleRelayPair } from './commands/pair.js';
import { deriveChannelHash, inspectAccount, validateAccountConfig } from './config.js';
import { RelayGatewayAdapter } from './gateway-adapter.js';
import { PairingManager } from './pairing.js';
import type { RelayAccountConfig, RelayAccountInspection, RelayConfigStore, RelayRequestContext, RelayRuntimeAdapter, RelayStreamResult } from './types.js';
import { generateMessageId, randomHex } from './utils.js';
import type { AgentConfigEntry, ChannelAccountSnapshot, ChannelGatewayContext, ChannelPlugin, OpenClawConfig, OpenClawPluginApi, OpenClawRuntime } from './host-types.js';

const RELAY_CHANNEL_ID = 'relay';
const DEFAULT_ACCOUNT_ID = 'default';
const PAIR_WAIT_POLL_MS = 1000;
const PAIR_WAIT_SECONDS = 300;

type ResolvedRelayAccount = RelayAccountConfig & {
  accountId: string;
  configured: boolean;
};

type ActiveRelayRecord = {
  adapter: RelayGatewayAdapter;
  pairing: PairingManager;
  stop: () => Promise<void>;
};

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: Error | undefined;

  push(item: T): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.failure) throw this.failure;
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (this.failure) throw this.failure;
      if (next.done) return;
      yield next.value;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function getChannels(cfg: OpenClawConfig): Record<string, unknown> {
  return isObject(cfg.channels) ? cfg.channels : {};
}

function getRelaySection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = getChannels(cfg);
  const relay = channels[RELAY_CHANNEL_ID];
  return isObject(relay) ? relay : {};
}

function getRelayAccounts(cfg: OpenClawConfig): Record<string, RelayAccountConfig> {
  const relay = getRelaySection(cfg);
  const accounts = relay.accounts;
  if (!isObject(accounts)) return {};
  return accounts as Record<string, RelayAccountConfig>;
}

function setRelayAccounts(cfg: OpenClawConfig, accounts: Record<string, RelayAccountConfig>): OpenClawConfig {
  const next = cloneConfig(cfg);
  const channels = getChannels(next);
  const relay = getRelaySection(next);
  const nextChannels = {
    ...channels,
    [RELAY_CHANNEL_ID]: {
      ...relay,
      accounts,
    },
  };
  next.channels = nextChannels;
  return next;
}

function isConfiguredAccount(account: Partial<RelayAccountConfig> | undefined): account is RelayAccountConfig {
  if (!account) return false;
  return Boolean(
    typeof account.server === 'string' && account.server.trim() &&
    typeof account.channelToken === 'string' && account.channelToken.trim() &&
    isObject(account.gatewayKeyPair) &&
    typeof account.gatewayKeyPair.privateKey === 'string' && account.gatewayKeyPair.privateKey.trim() &&
    typeof account.gatewayKeyPair.publicKey === 'string' && account.gatewayKeyPair.publicKey.trim() &&
    isObject(account.approvedClients),
  );
}

function resolveRelayAccount(cfg: OpenClawConfig, accountId = DEFAULT_ACCOUNT_ID): ResolvedRelayAccount {
  const accounts = getRelayAccounts(cfg);
  const raw = accounts[accountId];
  const configured = isConfiguredAccount(raw);
  return {
    accountId,
    enabled: configured ? raw.enabled : false,
    server: configured ? raw.server : '',
    channelToken: configured ? raw.channelToken : '',
    gatewayKeyPair: configured
      ? raw.gatewayKeyPair
      : { privateKey: '', publicKey: '' },
    approvedClients: configured ? raw.approvedClients : {},
    discovery: configured ? { enabled: Boolean(raw.discovery?.enabled) } : { enabled: false },
    configured,
  };
}


function summarizeAccount(account: ResolvedRelayAccount): ChannelAccountSnapshot {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    publicKey: account.gatewayKeyPair.publicKey || null,
    discoveryEnabled: Boolean(account.discovery?.enabled),
  };
}

function getAgentEntries(cfg: OpenClawConfig): AgentConfigEntry[] {
  return Array.isArray(cfg.agents?.list) ? cfg.agents!.list!.filter(isObject) as AgentConfigEntry[] : [];
}

function buildSessionStorePath(stateDir: string, agentId: string): string {
  return `${stateDir.replace(/\/$/, '')}/agents/${agentId}/sessions/sessions.json`;
}

function buildTranscriptPath(storePath: string, sessionId: string): string {
  const baseDir = storePath.replace(/\/sessions\.json$/, '');
  return `${baseDir}/${sessionId}.jsonl`;
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const parent = path.replace(/\/[^/]+$/, '');
  await mkdir(parent, { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

type SessionStoreEntry = {
  sessionId?: string;
  updatedAt?: number;
  sessionFile?: string;
  agentId?: string;
  totalTokens?: number | null;
};

type SessionIndexEntry = {
  key: string;
  sessionId: string;
  updatedAt: number;
  agentId: string;
  storePath: string;
};

async function loadSessionIndex(runtime: OpenClawRuntime, cfg: OpenClawConfig): Promise<SessionIndexEntry[]> {
  const stateDir = runtime.state?.resolveStateDir?.();
  if (!stateDir) return [];
  const entries: SessionIndexEntry[] = [];
  for (const agent of getAgentEntries(cfg)) {
    const agentId = typeof agent.id === 'string' ? agent.id.trim() : '';
    if (!agentId) continue;
    const storePath = buildSessionStorePath(stateDir, agentId);
    const store = await readJsonFile<Record<string, SessionStoreEntry>>(storePath);
    if (!store || !isObject(store)) continue;
    for (const [key, entry] of Object.entries(store)) {
      if (!isObject(entry)) continue;
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
      const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : undefined;
      if (!sessionId || !updatedAt) continue;
      entries.push({
        key,
        sessionId,
        updatedAt,
        agentId: typeof entry.agentId === 'string' && entry.agentId ? entry.agentId : agentId,
        storePath,
      });
    }
  }
  entries.sort((left, right) => right.updatedAt - left.updatedAt);
  return entries;
}

type HistoryMessage = {
  role: string;
  content: string;
  timestamp: string;
};

async function readSessionMessages(storePath: string, sessionId: string): Promise<HistoryMessage[]> {
  const transcriptPath = buildTranscriptPath(storePath, sessionId);
  const raw = await readFile(transcriptPath, 'utf-8').catch(() => '');
  if (!raw) return [];
  const messages: HistoryMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type !== 'message' || !isObject(entry.message)) continue;
      const message = entry.message as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role : undefined;
      const content = typeof message.content === 'string' ? message.content : undefined;
      const timestamp = typeof message.timestamp === 'string' ? message.timestamp : undefined;
      if (!role || !content || !timestamp) continue;
      messages.push({ role, content, timestamp });
    } catch {
      continue;
    }
  }
  return messages;
}

async function findSessionByIdOrKey(runtime: OpenClawRuntime, cfg: OpenClawConfig, sessionIdOrKey: string): Promise<SessionIndexEntry | undefined> {
  const index = await loadSessionIndex(runtime, cfg);
  return index.find((entry) => entry.sessionId === sessionIdOrKey || entry.key === sessionIdOrKey);
}

async function buildSessionPreview(entry: SessionIndexEntry): Promise<string> {
  const messages = await readSessionMessages(entry.storePath, entry.sessionId);
  const sample = messages.find((message) => message.role === 'user') ?? messages[0];
  if (!sample) return '';
  return sample.content.length > 120 ? `${sample.content.slice(0, 117)}...` : sample.content;
}

async function loadCronJobs(runtime: OpenClawRuntime): Promise<Array<Record<string, unknown>>> {
  const stateDir = runtime.state?.resolveStateDir?.();
  if (!stateDir) return [];
  const jobsPath = `${stateDir.replace(/\/$/, '')}/cron/jobs.json`;
  const payload = await readJsonFile<{ version?: number; jobs?: Array<Record<string, unknown>> }>(jobsPath);
  return Array.isArray(payload?.jobs) ? payload!.jobs! : [];
}

async function writeCronJobs(runtime: OpenClawRuntime, jobs: Array<Record<string, unknown>>): Promise<void> {
  const stateDir = runtime.state?.resolveStateDir?.();
  if (!stateDir) {
    throw new Error('runtime state directory is unavailable');
  }
  const jobsPath = `${stateDir.replace(/\/$/, '')}/cron/jobs.json`;
  const existing = await readJsonFile<Record<string, unknown>>(jobsPath);
  const version = typeof existing?.version === 'number' ? existing.version : 1;
  await writeJsonFile(jobsPath, {
    ...(existing && isObject(existing) ? existing : {}),
    version,
    jobs,
  });
}

class OpenClawRelayConfigStore implements RelayConfigStore {
  constructor(private readonly runtime: OpenClawRuntime) {}

  async load(accountId: string): Promise<RelayAccountConfig | undefined> {
    const cfg = this.runtime.config.loadConfig();
    const account = getRelayAccounts(cfg)[accountId];
    return account ? cloneConfig(account) : undefined;
  }

  async save(accountId: string, config: RelayAccountConfig): Promise<void> {
    validateAccountConfig(config);
    const cfg = this.runtime.config.loadConfig();
    const accounts = getRelayAccounts(cfg);
    const next = setRelayAccounts(cfg, {
      ...accounts,
      [accountId]: cloneConfig(config),
    });
    await this.runtime.config.writeConfigFile(next);
  }

  async listAccountIds(): Promise<string[]> {
    const cfg = this.runtime.config.loadConfig();
    return Object.keys(getRelayAccounts(cfg)).sort();
  }

  async inspectAccount(accountId: string): Promise<RelayAccountInspection | undefined> {
    const account = await this.load(accountId);
    return account ? inspectAccount(account) : undefined;
  }
}

function createRuntimeAdapter(api: OpenClawPluginApi, getClientStatus: () => Record<string, string>): RelayRuntimeAdapter {
  return {
    chatSend: async (params, ctx) => {
      const cfg = api.runtime.config.loadConfig();
      const channelRuntime = activeChannelRuntimeByAccount.get(ctx.accountId);
      if (!channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher || !channelRuntime.reply.finalizeInboundContext) {
        throw new Error('relay chat runtime is unavailable in this OpenClaw host');
      }

      const requestedAgent = typeof params.agent === 'string' && params.agent.trim() ? params.agent.trim() : undefined;
      const requestedSessionId = typeof params.session_id === 'string' && params.session_id.trim() ? params.session_id.trim() : undefined;
      const stream = params.stream !== false;
      const existing = requestedSessionId ? await findSessionByIdOrKey(api.runtime, cfg, requestedSessionId) : undefined;
      let agentId = requestedAgent;
      if (!agentId) {
        if (existing?.agentId) {
          agentId = existing.agentId;
        } else {
          const resolved = channelRuntime.routing?.resolveAgentRoute?.({
            cfg,
            channel: RELAY_CHANNEL_ID,
            accountId: ctx.accountId,
            peer: { kind: 'direct', id: ctx.clientId },
          });
          agentId = resolved?.agentId;
        }
      }
      if (!agentId) {
        throw new Error('could not resolve agent for relay chat request');
      }

      const sessionKey = existing?.key ?? `agent:${agentId}:relay:${ctx.clientId}:${generateMessageId()}:${randomHex(4)}`;
      const queue = new AsyncQueue<Record<string, unknown>>();
      let content = '';

      const finalized = channelRuntime.reply.finalizeInboundContext({
        Body: String(params.message ?? ''),
        RawBody: String(params.message ?? ''),
        CommandBody: String(params.message ?? ''),
        BodyForCommands: String(params.message ?? ''),
        BodyForAgent: String(params.message ?? ''),
        From: `relay:${ctx.clientId}`,
        To: `relay:${ctx.clientId}`,
        SessionKey: sessionKey,
        AccountId: ctx.accountId,
        OriginatingChannel: RELAY_CHANNEL_ID,
        OriginatingTo: ctx.clientId,
        ChatType: 'direct',
        SenderName: ctx.clientId,
        SenderId: ctx.clientId,
        Provider: RELAY_CHANNEL_ID,
        Surface: RELAY_CHANNEL_ID,
        ConversationLabel: ctx.clientId,
        Timestamp: Date.now(),
        CommandAuthorized: true,
        GatewayClientScopes: [ctx.fingerprint],
      });

      const dispatchPromise = channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: finalized,
        cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            if (payload.isReasoning) return;
            const text = typeof payload.text === 'string'
              ? payload.text
              : typeof payload.body === 'string'
                ? payload.body
                : '';
            if (!text) return;
            content += text;
            if (stream) {
              queue.push({ delta: text });
            }
          },
        },
        replyOptions: {
          abortSignal: ctx.signal,
          suppressTyping: true,
        },
      });

      const finalPromise = (async () => {
        await dispatchPromise;
        const latest = await findSessionByIdOrKey(api.runtime, api.runtime.config.loadConfig(), sessionKey);
        const sessionId = latest?.sessionId ?? requestedSessionId ?? sessionKey;
        return {
          session_id: sessionId,
          agent: agentId,
        };
      })();

      if (stream) {
        void finalPromise.then(() => queue.close(), (error) => queue.fail(error));
        return {
          stream: queue.iterate(),
          final: finalPromise,
        } satisfies RelayStreamResult;
      }

      const final = await finalPromise;
      return {
        content,
        ...final,
      };
    },

    agentsList: async () => {
      const cfg = api.runtime.config.loadConfig();
      return {
        agents: getAgentEntries(cfg).map((entry) => ({
          name: typeof entry.id === 'string' ? entry.id : '',
          display_name:
            typeof entry.displayName === 'string' && entry.displayName
              ? entry.displayName
              : typeof entry.name === 'string' && entry.name
                ? entry.name
                : typeof entry.id === 'string'
                  ? entry.id
                  : '',
          status: 'idle',
          description: typeof entry.description === 'string' ? entry.description : '',
        })).filter((entry) => entry.name),
      };
    },

    agentsInfo: async (params) => {
      const cfg = api.runtime.config.loadConfig();
      const agentId = String(params.agent);
      const agent = getAgentEntries(cfg).find((entry) => entry.id === agentId);
      if (!agent) {
        throw new Error(`agent '${agentId}' not found`);
      }
      const sessions = await loadSessionIndex(api.runtime, cfg);
      const toolNames = isObject(agent.tools) ? Object.keys(agent.tools).sort() : [];
      return {
        name: agentId,
        display_name:
          typeof agent.displayName === 'string' && agent.displayName
            ? agent.displayName
            : typeof agent.name === 'string' && agent.name
              ? agent.name
              : agentId,
        status: 'idle',
        description: typeof agent.description === 'string' ? agent.description : '',
        tools: toolNames,
        recent_sessions: sessions.filter((entry) => entry.agentId === agentId).length,
      };
    },

    sessionsList: async (params) => {
      const cfg = api.runtime.config.loadConfig();
      const requestedAgent = typeof params.agent === 'string' && params.agent.trim() ? params.agent.trim() : undefined;
      const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 20;
      const offset = typeof params.offset === 'number' && Number.isFinite(params.offset) ? params.offset : 0;
      const index = await loadSessionIndex(api.runtime, cfg);
      const filtered = requestedAgent ? index.filter((entry) => entry.agentId === requestedAgent) : index;
      const page = filtered.slice(offset, offset + limit);
      const sessions = await Promise.all(page.map(async (entry) => {
        const messages = await readSessionMessages(entry.storePath, entry.sessionId);
        const startedAt = messages[0]?.timestamp ?? new Date(entry.updatedAt).toISOString();
        const lastMessageAt = messages[messages.length - 1]?.timestamp ?? new Date(entry.updatedAt).toISOString();
        return {
          id: entry.sessionId,
          agent: entry.agentId,
          started_at: startedAt,
          last_message_at: lastMessageAt,
          message_count: messages.length,
          preview: await buildSessionPreview(entry),
        };
      }));
      return {
        sessions,
        total: filtered.length,
      };
    },

    sessionsHistory: async (params) => {
      const cfg = api.runtime.config.loadConfig();
      const sessionId = String(params.session_id);
      const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 50;
      const before = typeof params.before === 'string' && params.before.trim() ? Date.parse(params.before) : undefined;
      const entry = await findSessionByIdOrKey(api.runtime, cfg, sessionId);
      if (!entry) {
        throw new Error(`session '${sessionId}' not found`);
      }
      const messages = await readSessionMessages(entry.storePath, entry.sessionId);
      const filtered = before
        ? messages.filter((message) => Date.parse(message.timestamp) < before)
        : messages;
      const sliced = filtered.slice(Math.max(0, filtered.length - limit));
      return {
        messages: sliced,
        has_more: filtered.length > sliced.length,
      };
    },

    cronList: async () => {
      const jobs = await loadCronJobs(api.runtime);
      return {
        tasks: jobs.map((job) => ({
          id: typeof job.id === 'string' ? job.id : '',
          name: typeof job.name === 'string' ? job.name : '',
          agent: typeof job.agentId === 'string' ? job.agentId : '',
          schedule: typeof job.schedule === 'string' ? job.schedule : '',
          enabled: Boolean(job.enabled),
          last_run: isObject(job.state) && typeof job.state.lastRunAtMs === 'number'
            ? new Date(job.state.lastRunAtMs).toISOString()
            : null,
          last_status: isObject(job.state) && typeof job.state.lastStatus === 'string'
            ? job.state.lastStatus
            : null,
        })).filter((task) => task.id),
      };
    },

    cronToggle: async (params) => {
      const id = String(params.id);
      const enabled = Boolean(params.enabled);
      const jobs = await loadCronJobs(api.runtime);
      let found = false;
      const next = jobs.map((job) => {
        if (job.id !== id) return job;
        found = true;
        return {
          ...job,
          enabled,
          updatedAtMs: Date.now(),
        };
      });
      if (!found) {
        throw new Error(`cron job '${id}' not found`);
      }
      await writeCronJobs(api.runtime, next);
      return { id, enabled };
    },

    systemStatus: async () => {
      const cfg = api.runtime.config.loadConfig();
      const jobs = await loadCronJobs(api.runtime);
      const configuredChannels = Object.keys(getChannels(cfg)).sort();
      const channels: Record<string, string> = {};
      for (const channelId of configuredChannels) {
        channels[channelId] = channelId === RELAY_CHANNEL_ID && Object.keys(getClientStatus()).length > 0
          ? 'running'
          : 'configured';
      }
      if (!(RELAY_CHANNEL_ID in channels)) {
        channels[RELAY_CHANNEL_ID] = Object.keys(getClientStatus()).length > 0 ? 'running' : 'idle';
      }
      return {
        version: api.runtime.version,
        uptime_seconds: Math.floor(process.uptime()),
        agents_active: getAgentEntries(cfg).length,
        cron_tasks: jobs.length,
        channels,
      };
    },
  };
}

const activeAccounts = new Map<string, ActiveRelayRecord>();
const activeChannelRuntimeByAccount = new Map<string, NonNullable<ChannelGatewayContext['channelRuntime']>>();

function buildSnapshot(account: ResolvedRelayAccount, gatewayStatus?: {
  state: string;
  lastRegisteredAt?: string;
  lastFatalErrorCode?: string;
}): ChannelAccountSnapshot {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    running: gatewayStatus ? gatewayStatus.state !== 'disconnected' : false,
    connected: gatewayStatus?.state === 'registered',
    lastConnectedAt: gatewayStatus?.lastRegisteredAt ? Date.parse(gatewayStatus.lastRegisteredAt) : null,
    lastError: gatewayStatus?.lastFatalErrorCode ?? null,
    publicKey: account.gatewayKeyPair.publicKey || null,
  };
}

async function stopActiveAccount(accountId: string): Promise<void> {
  const record = activeAccounts.get(accountId);
  if (!record) return;
  await record.stop();
}

async function ensureStartedAccount(params: {
  api: OpenClawPluginApi;
  accountId: string;
  channelRuntime?: ChannelGatewayContext['channelRuntime'];
  setStatus?: (snapshot: ChannelAccountSnapshot) => void;
  abortSignal?: AbortSignal;
  log?: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void; debug?: (message: string) => void };
}): Promise<ActiveRelayRecord> {
  const existing = activeAccounts.get(params.accountId);
  if (existing) {
    if (params.channelRuntime) {
      activeChannelRuntimeByAccount.set(params.accountId, params.channelRuntime);
    }
    return existing;
  }

  const store = new OpenClawRelayConfigStore(params.api.runtime);
  const pairing = new PairingManager();
  const runtimeAdapter = createRuntimeAdapter(params.api, () => {
    const status: Record<string, string> = {};
    for (const accountId of activeAccounts.keys()) status[accountId] = 'running';
    return status;
  });
  const adapter = new RelayGatewayAdapter({
    accountId: params.accountId,
    configStore: store,
    runtime: runtimeAdapter,
    pairingManager: pairing,
  });

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let abortListener: (() => void) | undefined;

  const stop = async () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (params.abortSignal && abortListener) {
      params.abortSignal.removeEventListener('abort', abortListener);
    }
    await adapter.stop().catch(() => undefined);
    activeAccounts.delete(params.accountId);
    activeChannelRuntimeByAccount.delete(params.accountId);
    const cfg = params.api.runtime.config.loadConfig();
    const resolved = resolveRelayAccount(cfg, params.accountId);
    params.setStatus?.(buildSnapshot(resolved));
  };

  try {
    await adapter.start();
  } catch (error) {
    await stop();
    throw error;
  }

  const record: ActiveRelayRecord = { adapter, pairing, stop };
  activeAccounts.set(params.accountId, record);
  if (params.channelRuntime) {
    activeChannelRuntimeByAccount.set(params.accountId, params.channelRuntime);
  }

  const refreshStatus = async () => {
    const cfg = params.api.runtime.config.loadConfig();
    const resolved = resolveRelayAccount(cfg, params.accountId);
    const status = await adapter.getStatus();
    params.setStatus?.(buildSnapshot(resolved, status));
  };

  await refreshStatus().catch(() => undefined);
  pollTimer = setInterval(() => {
    void refreshStatus().catch((error) => {
      params.log?.debug?.(`[relay:${params.accountId}] status poll failed: ${String(error)}`);
    });
  }, 2000);

  if (params.abortSignal) {
    abortListener = () => {
      void stop();
    };
    params.abortSignal.addEventListener('abort', abortListener, { once: true });
  }

  return record;
}

export function createOpenClawRelayPlugin(api: OpenClawPluginApi, previewPlugin: ChannelPlugin<ResolvedRelayAccount>): { channelPlugin: ChannelPlugin<ResolvedRelayAccount>; registerCli: () => void } {
  const channelPlugin: ChannelPlugin<ResolvedRelayAccount> = {
    ...previewPlugin,
    config: {
      listAccountIds: (cfg) => {
        const ids = Object.keys(getRelayAccounts(cfg)).sort();
        return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
      },
      resolveAccount: (cfg, accountId) => resolveRelayAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      setAccountEnabled: ({ cfg, accountId, enabled }) => {
        const accounts = getRelayAccounts(cfg);
        const existing = accounts[accountId];
        if (!existing) return cfg;
        return setRelayAccounts(cfg, {
          ...accounts,
          [accountId]: {
            ...existing,
            enabled,
          },
        });
      },
      deleteAccount: ({ cfg, accountId }) => {
        const accounts = { ...getRelayAccounts(cfg) };
        delete accounts[accountId];
        return setRelayAccounts(cfg, accounts);
      },
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => summarizeAccount(account),
    },
    status: {
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        running: false,
        connected: false,
      },
      buildAccountSnapshot: async ({ account, runtime }) => ({
        ...summarizeAccount(account),
        ...(runtime ?? {}),
      }),
    },
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.account.configured) {
          throw new Error(`relay account '${ctx.accountId}' is not configured`);
        }
        ctx.setStatus(buildSnapshot(ctx.account));
        await ensureStartedAccount({
          api,
          accountId: ctx.accountId,
          ...(ctx.channelRuntime ? { channelRuntime: ctx.channelRuntime } : {}),
          setStatus: ctx.setStatus,
          abortSignal: ctx.abortSignal,
          ...(ctx.log ? { log: ctx.log } : {}),
        });
        if (ctx.abortSignal.aborted) return;
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      stopAccount: async (ctx) => {
        await stopActiveAccount(ctx.accountId);
      },
    },
  };

  const registerCli = () => {
    api.registerCli(({ program, logger }) => {
      const root = program.command('relay').description('Manage the OpenClaw Relay plugin');

      root
        .command('enable')
        .requiredOption('--server <url>', 'Relay WebSocket URL')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .action(async (options: { server: string; account?: string }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const store = new OpenClawRelayConfigStore(api.runtime);
          await handleRelayEnable(store, options.server, accountId);
          api.runtime.system.requestHeartbeatNow?.();
          const inspection = await store.inspectAccount(accountId);
          console.log(JSON.stringify({ ok: true, accountId, inspection }, null, 2));
        });

      root
        .command('pair')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .option('--wait <seconds>', 'How long to keep pairing mode open', String(PAIR_WAIT_SECONDS))
        .action(async (options: { account?: string; wait?: string }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const waitSecondsRaw = Number(options.wait ?? PAIR_WAIT_SECONDS);
          const waitSeconds = Number.isFinite(waitSecondsRaw) && waitSecondsRaw > 0 ? waitSecondsRaw : PAIR_WAIT_SECONDS;
          const store = new OpenClawRelayConfigStore(api.runtime);
          const before = (await store.load(accountId))?.approvedClients ?? {};
          const beforeCount = Object.keys(before).length;
          const startedHere = !activeAccounts.has(accountId);
          const record = await ensureStartedAccount({ api, accountId, log: logger });
          const info = await handleRelayPair(store, record.pairing, accountId);
          console.log(JSON.stringify({ ok: true, pairing: info }, null, 2));

          const deadline = Date.now() + waitSeconds * 1000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, PAIR_WAIT_POLL_MS));
            const inspection = await record.adapter.inspectAccount();
            const approvedCount = inspection?.approvedClients.length ?? 0;
            if (approvedCount > beforeCount) {
              console.log(JSON.stringify({ ok: true, paired: true, clients: await handleRelayClients(store, accountId) }, null, 2));
              if (startedHere) {
                await record.stop();
              }
              return;
            }
          }

          console.log(JSON.stringify({ ok: true, paired: false, expired: true }, null, 2));
          if (startedHere) {
            await record.stop();
          }
        });

      root
        .command('clients')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .action(async (options: { account?: string }) => {
          const store = new OpenClawRelayConfigStore(api.runtime);
          const clients = await handleRelayClients(store, options.account ?? DEFAULT_ACCOUNT_ID);
          console.log(JSON.stringify({ ok: true, clients }, null, 2));
        });

      root
        .command('revoke')
        .requiredOption('--fingerprint <value>', 'Approved client fingerprint')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .action(async (options: { fingerprint: string; account?: string }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const store = new OpenClawRelayConfigStore(api.runtime);
          const record = activeAccounts.get(accountId);
          await handleRelayRevoke(store, record?.pairing ?? new PairingManager(), options.fingerprint, accountId);
          await record?.adapter.disconnectFingerprint(options.fingerprint, 'revoked');
          console.log(JSON.stringify({ ok: true, fingerprint: options.fingerprint }, null, 2));
        });

      root
        .command('disable')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .action(async (options: { account?: string }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const store = new OpenClawRelayConfigStore(api.runtime);
          await handleRelayDisable(store, accountId);
          await stopActiveAccount(accountId);
          api.runtime.system.requestHeartbeatNow?.();
          console.log(JSON.stringify({ ok: true, accountId }, null, 2));
        });

      root
        .command('rotate-token')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .action(async (options: { account?: string }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const store = new OpenClawRelayConfigStore(api.runtime);
          const token = await handleRelayRotateToken(store, accountId);
          const record = activeAccounts.get(accountId);
          if (record) {
            await record.stop();
            await ensureStartedAccount({ api, accountId, log: logger });
          }
          console.log(JSON.stringify({ ok: true, accountId, channelToken: token }, null, 2));
        });

      root
        .command('status')
        .option('--account <id>', 'Account id', DEFAULT_ACCOUNT_ID)
        .action(async (options: { account?: string }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const store = new OpenClawRelayConfigStore(api.runtime);
          const inspection = await store.inspectAccount(accountId);
          const record = activeAccounts.get(accountId);
          const status = record ? await record.adapter.getStatus() : null;
          console.log(JSON.stringify({ ok: true, accountId, inspection, status }, null, 2));
        });
    }, { commands: ['relay'] });
  };

  return { channelPlugin, registerCli };
}

export function createRelayChannelDefinition(): ChannelPlugin<ResolvedRelayAccount> {
  return {
    id: RELAY_CHANNEL_ID,
    meta: {
      id: RELAY_CHANNEL_ID,
      label: 'Relay',
      selectionLabel: 'Relay',
      docsPath: '/channels/relay',
      blurb: 'OpenClaw Relay gateway plugin for remote encrypted access.',
      order: 999,
      forceAccountBinding: true,
    },
    capabilities: {
      chatTypes: ['direct'],
      blockStreaming: true,
    },
    reload: {
      configPrefixes: ['channels.relay'],
    },
    configSchema: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              properties: {
                enabled: { type: 'boolean' },
                server: { type: 'string' },
                channelToken: { type: 'string' },
                gatewayKeyPair: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    privateKey: { type: 'string' },
                    publicKey: { type: 'string' },
                  },
                  required: ['privateKey', 'publicKey'],
                },
                approvedClients: {
                  type: 'object',
                  additionalProperties: {
                    type: 'object',
                  },
                },
                discovery: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    enabled: { type: 'boolean' },
                  },
                },
              },
              required: ['enabled', 'server', 'channelToken', 'gatewayKeyPair', 'approvedClients'],
            },
          },
        },
      },
      uiHints: {
        'accounts.default.server': { label: 'Relay Server', help: 'WebSocket URL of the relay.' },
        'accounts.default.channelToken': { label: 'Channel Token', sensitive: true },
        'accounts.default.gatewayKeyPair.privateKey': { label: 'Gateway Private Key', sensitive: true, advanced: true },
        'accounts.default.gatewayKeyPair.publicKey': { label: 'Gateway Public Key', advanced: true },
        'accounts.default.discovery.enabled': { label: 'Enable Agent Discovery', help: 'Allow this OpenClaw gateway to advertise itself to other gateways on the same relay. Human-facing clients still cannot browse peers.' },
      },
    },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => resolveRelayAccount({}, DEFAULT_ACCOUNT_ID),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => summarizeAccount(account),
    },
  };
}
