import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { handleRelayClients, handleRelayRevoke } from './commands/clients.js';
import { handleRelayDisable, handleRelayRotateToken } from './commands/disable.js';
import { handleRelayEnable } from './commands/enable.js';
import { handleRelayPair } from './commands/pair.js';
import { deriveChannelHash, inspectAccount, validateAccountConfig } from './config.js';
import { RelayGatewayAdapter } from './gateway-adapter.js';
import { PairingManager } from './pairing.js';
import type { RelayPeerSession } from './outbound-peer-session.js';
import { createRelayPeerAgentService, isInviteOfferSignal, isInviteRejectSignal, isInviteRequestSignal, RelayPeerAgentService } from './peer-agent-service.js';
import type {
  DiscoveryPeer,
  GatewayStatus,
  PeerSignalEnvelope,
  ReceivedPeerSignal,
  RelayAccountConfig,
  RelayAccountInspection,
  RelayConfigStore,
  RelayRequestContext,
  RelayRuntimeAdapter,
  RelayStreamResult,
  SignalErrorFrame,
} from './types.js';
import { generateMessageId, randomHex } from './utils.js';
import type {
  AgentConfigEntry,
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawRuntime,
  PluginLogger,
} from './host-types.js';

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

export interface RelayAgentBridgeStartOptions {
  accountId?: string;
  channelRuntime?: ChannelGatewayContext['channelRuntime'];
  setStatus?: (snapshot: ChannelAccountSnapshot) => void;
  abortSignal?: AbortSignal;
  log?: PluginLogger;
}

export interface RelayAgentInviteOptions extends RelayAgentBridgeStartOptions {
  ttlSeconds?: number;
}

export interface RelayAgentAcceptPeerOptions extends RelayAgentInviteOptions {
  maxUses?: number;
}

export interface RelayAgentBridge {
  ensureStarted(options?: RelayAgentBridgeStartOptions): Promise<GatewayStatus>;
  stopAccount(accountId?: string): Promise<void>;
  getStatus(accountId?: string): Promise<GatewayStatus | undefined>;
  discoverPeers(options?: RelayAgentBridgeStartOptions & { timeoutMs?: number }): Promise<DiscoveryPeer[]>;
  sendPeerSignal(targetPublicKey: string, envelope: PeerSignalEnvelope, options?: RelayAgentBridgeStartOptions): Promise<void>;
  createPeerInvite(options?: RelayAgentInviteOptions): Promise<{ inviteToken: string; inviteHash: string; expiresAt: string }>;
  acceptPeerSignal(sourcePublicKey: string, options?: RelayAgentAcceptPeerOptions): Promise<{ sourcePublicKey: string; fingerprint: string; peerAuthorizedUntil: string; inviteToken: string; inviteHash: string; expiresAt: string }>;
  dialPeerInvite(inviteToken: string, gatewayPublicKey: string, options?: RelayAgentBridgeStartOptions & { clientId?: string; onClosed?: (error?: Error) => void }): Promise<RelayPeerSession>;
  drainPeerSignals(accountId?: string): ReceivedPeerSignal[];
  drainPeerSignalErrors(accountId?: string): SignalErrorFrame[];
}

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

function parseJsonObjectOption(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return structuredClone(parsed) as Record<string, unknown>;
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
    peerDiscovery: configured
      ? {
          enabled: Boolean(raw.peerDiscovery?.enabled),
          ...(raw.peerDiscovery?.metadata ? { metadata: cloneConfig(raw.peerDiscovery.metadata) } : {}),
          ...(raw.peerDiscovery?.autoAcceptRequests
            ? {
                autoAcceptRequests: {
                  enabled: raw.peerDiscovery.autoAcceptRequests.enabled === true,
                  ...(typeof raw.peerDiscovery.autoAcceptRequests.ttlSeconds === 'number' ? { ttlSeconds: raw.peerDiscovery.autoAcceptRequests.ttlSeconds } : {}),
                  ...(typeof raw.peerDiscovery.autoAcceptRequests.maxUses === 'number' ? { maxUses: raw.peerDiscovery.autoAcceptRequests.maxUses } : {}),
                },
              }
            : {}),
        }
      : { enabled: false },
    configured,
  };
}


function summarizeAccount(account: ResolvedRelayAccount): ChannelAccountSnapshot {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    publicKey: account.gatewayKeyPair.publicKey || null,
    peerDiscoveryEnabled: Boolean(account.peerDiscovery?.enabled),
    ...(account.peerDiscovery?.autoAcceptRequests ? { peerDiscoveryAutoAcceptEnabled: account.peerDiscovery.autoAcceptRequests.enabled === true } : {}),
  };
}

function getAgentEntries(cfg: OpenClawConfig): AgentConfigEntry[] {
  return Array.isArray(cfg.agents?.list) ? cfg.agents!.list!.filter(isObject) as AgentConfigEntry[] : [];
}

const VALID_AGENT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const INVALID_AGENT_ID_RE = /[^a-z0-9-]+/g;
const LEADING_AGENT_DASH_RE = /^-+/;
const TRAILING_AGENT_DASH_RE = /-+$/;

function normalizeAgentId(agentId: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) return 'main';
  if (VALID_AGENT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return trimmed.toLowerCase().replace(INVALID_AGENT_ID_RE, '-').replace(LEADING_AGENT_DASH_RE, '').replace(TRAILING_AGENT_DASH_RE, '').slice(0, 64) || 'main';
}

function resolveConfigPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) {
    return resolve(homedir(), trimmed.slice(1).replace(/^[/\\]+/, ''));
  }
  return resolve(trimmed);
}

function resolveSessionStorePath(stateDir: string, cfg: OpenClawConfig, agentId: string): string {
  const configuredStore = typeof (cfg as { session?: { store?: unknown } }).session?.store === 'string'
    ? (cfg as { session?: { store?: string } }).session?.store?.trim()
    : undefined;
  if (configuredStore) {
    const expanded = configuredStore.includes('{agentId}')
      ? configuredStore.replaceAll('{agentId}', normalizeAgentId(agentId))
      : configuredStore;
    return resolveConfigPath(expanded);
  }
  return join(stateDir.replace(/\/$/, ''), 'agents', normalizeAgentId(agentId), 'sessions', 'sessions.json');
}

function resolveCronStorePath(stateDir: string, cfg: OpenClawConfig): string {
  const configuredStore = typeof (cfg as { cron?: { store?: unknown } }).cron?.store === 'string'
    ? (cfg as { cron?: { store?: string } }).cron?.store?.trim()
    : undefined;
  return configuredStore ? resolveConfigPath(configuredStore) : join(stateDir.replace(/\/$/, ''), 'cron', 'jobs.json');
}

function resolvePathWithinDir(baseDir: string, candidate: string): string {
  const trimmed = candidate.trim();
  const normalized = normalize(trimmed);
  if (!normalized || normalized.startsWith('..') || isAbsolute(normalized)) {
    throw new Error('path must stay within base directory');
  }
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, normalized);
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolvedTarget;
  }
  throw new Error('path must stay within base directory');
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
  sessionFile?: string;
  stateDir: string;
};

async function loadSessionIndex(runtime: OpenClawRuntime, cfg: OpenClawConfig): Promise<SessionIndexEntry[]> {
  const stateDir = runtime.state?.resolveStateDir?.();
  if (!stateDir) return [];
  const entries: SessionIndexEntry[] = [];
  for (const agent of getAgentEntries(cfg)) {
    const agentId = typeof agent.id === 'string' ? agent.id.trim() : '';
    if (!agentId) continue;
    const storePath = resolveSessionStorePath(stateDir, cfg, agentId);
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
        ...(typeof entry.sessionFile === 'string' && entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
        stateDir,
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

function normalizeHistoryContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      if (!isObject(item)) return [];
      if (typeof item.text === 'string' && item.text) return [item.text];
      return [];
    });
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (isObject(value) && typeof value.text === 'string' && value.text) {
    return value.text;
  }
  return undefined;
}

function normalizeHistoryTimestamp(message: Record<string, unknown>, entry: Record<string, unknown>): string | undefined {
  if (typeof message.timestamp === 'string' && message.timestamp) {
    return message.timestamp;
  }
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
  }
  if (typeof entry.timestamp === 'string' && entry.timestamp) {
    return entry.timestamp;
  }
  if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
    return new Date(entry.timestamp).toISOString();
  }
  return undefined;
}

function resolveTranscriptCandidates(entry: SessionIndexEntry): string[] {
  const candidates: string[] = [];
  const pushCandidate = (candidate: string | undefined) => {
    if (!candidate) return;
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };
  const sessionsDir = dirname(resolve(entry.storePath));
  if (entry.sessionFile) {
    try {
      pushCandidate(resolvePathWithinDir(sessionsDir, entry.sessionFile));
    } catch {
      // Ignore invalid sessionFile paths and fall back to standard candidates.
    }
  }
  pushCandidate(join(sessionsDir, `${entry.sessionId}.jsonl`));
  pushCandidate(join(entry.stateDir, 'agents', normalizeAgentId(entry.agentId), 'sessions', `${entry.sessionId}.jsonl`));
  pushCandidate(join(homedir(), '.openclaw', 'sessions', `${entry.sessionId}.jsonl`));
  return candidates;
}

async function readSessionMessages(entry: SessionIndexEntry): Promise<HistoryMessage[]> {
  let raw = '';
  for (const candidate of resolveTranscriptCandidates(entry)) {
    raw = await readFile(candidate, 'utf-8').catch(() => '');
    if (raw) break;
  }
  if (!raw) return [];
  const messages: HistoryMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (isObject(parsed.message)) {
        const message = parsed.message as Record<string, unknown>;
        const role = typeof message.role === 'string' ? message.role : undefined;
        const content = normalizeHistoryContent(message.content);
        const timestamp = normalizeHistoryTimestamp(message, parsed);
        if (!role || !content || !timestamp) continue;
        messages.push({ role, content, timestamp });
        continue;
      }
      if (parsed.type === 'compaction') {
        const timestamp = normalizeHistoryTimestamp({}, parsed) ?? new Date().toISOString();
        messages.push({ role: 'system', content: 'Compaction', timestamp });
      }
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
  const messages = await readSessionMessages(entry);
  const sample = messages.find((message) => message.role === 'user') ?? messages[0];
  if (!sample) return '';
  return sample.content.length > 120 ? `${sample.content.slice(0, 117)}...` : sample.content;
}

async function loadCronJobs(runtime: OpenClawRuntime, cfg: OpenClawConfig): Promise<Array<Record<string, unknown>>> {
  const stateDir = runtime.state?.resolveStateDir?.();
  if (!stateDir) return [];
  const jobsPath = resolveCronStorePath(stateDir, cfg);
  const payload = await readJsonFile<{ version?: number; jobs?: Array<Record<string, unknown>> }>(jobsPath);
  return Array.isArray(payload?.jobs) ? payload!.jobs! : [];
}

async function writeCronJobs(runtime: OpenClawRuntime, cfg: OpenClawConfig, jobs: Array<Record<string, unknown>>): Promise<void> {
  const stateDir = runtime.state?.resolveStateDir?.();
  if (!stateDir) {
    throw new Error('runtime state directory is unavailable');
  }
  const jobsPath = resolveCronStorePath(stateDir, cfg);
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
        const messages = await readSessionMessages(entry);
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
      const messages = await readSessionMessages(entry);
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
      const jobs = await loadCronJobs(api.runtime, api.runtime.config.loadConfig());
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
      const jobs = await loadCronJobs(api.runtime, api.runtime.config.loadConfig());
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
      await writeCronJobs(api.runtime, api.runtime.config.loadConfig(), next);
      return { id, enabled };
    },

    systemStatus: async () => {
      const cfg = api.runtime.config.loadConfig();
      const jobs = await loadCronJobs(api.runtime, api.runtime.config.loadConfig());
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
const activePeerServices = new Map<string, RelayPeerAgentService>();

class RelayGatewayMethodError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RelayGatewayMethodError';
  }
}

function getRelayPeerService(api: OpenClawPluginApi, accountId = DEFAULT_ACCOUNT_ID): RelayPeerAgentService {
  const existing = activePeerServices.get(accountId);
  if (existing) return existing;
  const service = createRelayPeerAgentService({ bridge: createRelayAgentBridge(api), accountId });
  activePeerServices.set(accountId, service);
  return service;
}

async function closeRelayPeerService(accountId: string): Promise<void> {
  const service = activePeerServices.get(accountId);
  if (!service) return;
  activePeerServices.delete(accountId);
  await service.closeAllPeerSessions().catch(() => undefined);
}

function relayGatewayMethodError(code: string, message: string): RelayGatewayMethodError {
  return new RelayGatewayMethodError(code, message);
}

function getAccountIdParam(params: Record<string, unknown>): string {
  const value = params.accountId;
  if (value === undefined || value === null || value === '') return DEFAULT_ACCOUNT_ID;
  if (typeof value !== 'string') {
    throw relayGatewayMethodError('bad_request', 'accountId must be a string');
  }
  return value;
}

function getRequiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw relayGatewayMethodError('bad_request', `${key} must be a non-empty string`);
  }
  return value;
}

function getOptionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw relayGatewayMethodError('bad_request', `${key} must be a string`);
  }
  return value;
}

function getOptionalObjectParam(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw relayGatewayMethodError('bad_request', `${key} must be an object`);
  }
  return structuredClone(value) as Record<string, unknown>;
}

function getOptionalPositiveIntegerParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw relayGatewayMethodError('bad_request', `${key} must be a positive integer`);
  }
  return value;
}

function getOptionalBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'boolean') {
    throw relayGatewayMethodError('bad_request', `${key} must be a boolean`);
  }
  return value;
}

function parseReceivedPeerSignal(value: unknown): ReceivedPeerSignal {
  const candidate = isObject(value) && isObject(value.signal) ? value.signal : value;
  if (!isObject(candidate)) {
    throw relayGatewayMethodError('bad_request', 'signal must be an object');
  }
  const source = candidate.source;
  const envelopeValue = candidate.envelope;
  if (typeof source !== 'string' || !source) {
    throw relayGatewayMethodError('bad_request', 'signal.source must be a non-empty string');
  }
  if (!isObject(envelopeValue) || envelopeValue.version !== 1 || typeof envelopeValue.kind !== 'string' || !envelopeValue.kind) {
    throw relayGatewayMethodError('bad_request', 'signal.envelope must contain version=1 and a non-empty kind');
  }
  const bodyValue = envelopeValue.body;
  if (bodyValue !== undefined && !isObject(bodyValue)) {
    throw relayGatewayMethodError('bad_request', 'signal.envelope.body must be an object');
  }
  const receivedAt = typeof candidate.receivedAt === 'string' && candidate.receivedAt
    ? candidate.receivedAt
    : new Date().toISOString();
  const rawValue = candidate.raw;
  const raw: ReceivedPeerSignal['raw'] = isObject(rawValue)
    ? {
        ...rawValue,
        type: 'signal',
        source: typeof rawValue.source === 'string' ? rawValue.source : source,
        ephemeral_key: typeof rawValue.ephemeral_key === 'string' ? rawValue.ephemeral_key : '',
        payload: typeof rawValue.payload === 'string' ? rawValue.payload : '',
      }
    : { type: 'signal', source, ephemeral_key: '', payload: '' };
  return {
    source,
    envelope: {
      version: 1,
      kind: envelopeValue.kind,
      ...(bodyValue ? { body: structuredClone(bodyValue) as Record<string, unknown> } : {}),
    },
    receivedAt,
    raw,
  };
}

function formatPeerSignal(signal: ReceivedPeerSignal): Record<string, unknown> {
  const base: Record<string, unknown> = {
    source: signal.source,
    kind: signal.envelope.kind,
    receivedAt: signal.receivedAt,
    signal,
  };
  if (isInviteRequestSignal(signal)) {
    return {
      ...base,
      body: signal.envelope.body ?? {},
    };
  }
  if (isInviteOfferSignal(signal)) {
    const offer = RelayPeerAgentService.parseInviteOffer(signal);
    return {
      ...base,
      inviteToken: offer.inviteToken,
      ...(offer.expiresAt ? { expiresAt: offer.expiresAt } : {}),
      ...(offer.peerAuthorizedUntil ? { peerAuthorizedUntil: offer.peerAuthorizedUntil } : {}),
      body: signal.envelope.body ?? {},
    };
  }
  if (isInviteRejectSignal(signal)) {
    const rejection = RelayPeerAgentService.parseInviteReject(signal);
    return {
      ...base,
      ...(rejection.reason ? { reason: rejection.reason } : {}),
      body: rejection.body,
    };
  }
  return {
    ...base,
    ...(signal.envelope.body ? { body: signal.envelope.body } : {}),
  };
}

function classifyRelayPeerError(error: Error): { code: string; message: string } {
  const message = error.message || String(error);
  if (error instanceof RelayGatewayMethodError) {
    return { code: error.code, message: error.message };
  }
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return { code: String((error as { code: string }).code), message };
  }
  if (message.includes('no active peer session') || message.includes('peer session is not connected')) {
    return { code: 'peer_not_connected', message };
  }
  if (message.includes('timed out waiting')) {
    return { code: 'peer_signal_timeout', message };
  }
  if (message.includes('peer rejected invite request')) {
    return { code: 'peer_rejected', message };
  }
  if (message.includes('Request timeout:')) {
    return { code: 'peer_request_timeout', message };
  }
  if (message.includes('Remote gateway went offline') || message.includes('Gateway is offline for this invite alias')) {
    return { code: 'peer_offline', message };
  }
  if (message.includes('Gateway public key mismatch')) {
    return { code: 'peer_identity_mismatch', message };
  }
  if (message.includes('relay gateway not ready')) {
    return { code: 'relay_not_ready', message };
  }
  return { code: 'relay_peer_error', message };
}

function handleRelayGatewayMethodError(
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }, meta?: Record<string, unknown>) => void,
  error: unknown,
): void {
  if (error instanceof Error) {
    const classified = classifyRelayPeerError(error);
    respond(false, undefined, classified);
    return;
  }
  respond(false, undefined, {
    code: 'relay_peer_error',
    message: String(error),
  });
}

function registerRelayGatewayMethods(api: OpenClawPluginApi): void {
  if (typeof api.registerGatewayMethod !== 'function') {
    api.logger.warn('[relay] local gateway peer methods unavailable: OpenClaw runtime does not expose registerGatewayMethod');
    return;
  }
  api.logger.info('[relay] registering local gateway peer methods for relay.peer.*');
  const bridge = createRelayAgentBridge(api);
  const register = (
    method: string,
    handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => {
    api.registerGatewayMethod(method, async ({ params, respond }) => {
      try {
        const payload = await handler(params ?? {});
        respond(true, payload);
      } catch (error) {
        handleRelayGatewayMethodError(respond, error);
      }
    });
  };

  register('relay.peer.selfcheck', async (params) => {
    const accountId = getAccountIdParam(params);
    const account = resolveRelayAccount(api.runtime.config.loadConfig(), accountId);
    const service = getRelayPeerService(api, accountId);
    let status = await bridge.getStatus(accountId) ?? null;
    if (!status || status.state === 'disconnected') {
      try {
        status = await bridge.ensureStarted({ accountId });
      } catch {
        status = await bridge.getStatus(accountId) ?? status;
      }
    }
    const connectedPeers = service.listConnectedPeers();
    const channelRuntime = activeChannelRuntimeByAccount.get(accountId);
    const runtimeSupport = {
      chatSend: Boolean(channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher && channelRuntime?.reply?.finalizeInboundContext),
      sessionsHistory: true,
      sessionsList: true,
      systemStatus: true,
    };
    return {
      accountId,
      account: summarizeAccount(account),
      gatewayStatus: status,
      connectedPeers,
      peerSessions: service.listPeerSessionStatuses(),
      runtimeSupport,
      checks: {
        relayRegistered: status?.state === 'registered',
        peerDiscoveryEnabled: Boolean(account.peerDiscovery?.enabled),
        peerAutoAcceptEnabled: account.peerDiscovery?.autoAcceptRequests?.enabled === true,
        chatRuntimeReady: runtimeSupport.chatSend,
      },
    };
  });

  register('relay.peer.status', async (params) => {
    const accountId = getAccountIdParam(params);
    const account = resolveRelayAccount(api.runtime.config.loadConfig(), accountId);
    const service = getRelayPeerService(api, accountId);
    const status = await bridge.getStatus(accountId);
    return {
      accountId,
      account: summarizeAccount(account),
      gatewayStatus: status ?? null,
      connectedPeers: service.listConnectedPeers(),
      peerSessions: service.listPeerSessionStatuses(),
    };
  });

  register('relay.peer.discover', async (params) => {
    const accountId = getAccountIdParam(params);
    const timeoutMs = getOptionalPositiveIntegerParam(params, 'timeoutMs');
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    return {
      accountId,
      peers: await service.discoverPeers(timeoutMs),
      connectedPeers: service.listConnectedPeers(),
    };
  });

  register('relay.peer.dial', async (params) => {
    const accountId = getAccountIdParam(params);
    const targetPublicKey = getRequiredStringParam(params, 'targetPublicKey');
    const body = getOptionalObjectParam(params, 'body')
      ?? getOptionalObjectParam(params, 'request')
      ?? {};
    const clientId = getOptionalStringParam(params, 'clientId');
    const timeoutMs = getOptionalPositiveIntegerParam(params, 'timeoutMs');
    const pollIntervalMs = getOptionalPositiveIntegerParam(params, 'pollIntervalMs');
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    const dialed = await service.requestPeerConnection(targetPublicKey, {
      body,
      ...(clientId ? { clientId } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
    });
    return {
      accountId,
      ...dialed,
      connectedPeers: service.listConnectedPeers(),
    };
  });

  register('relay.peer.poll', async (params) => {
    const accountId = getAccountIdParam(params);
    const service = getRelayPeerService(api, accountId);
    return {
      accountId,
      signals: service.drainSignals().map(formatPeerSignal),
      signalErrors: service.drainSignalErrors(),
      connectedPeers: service.listConnectedPeers(),
      gatewayStatus: await bridge.getStatus(accountId) ?? null,
    };
  });

  register('relay.peer.request', async (params) => {
    const accountId = getAccountIdParam(params);
    const targetPublicKey = getRequiredStringParam(params, 'targetPublicKey');
    const body = getOptionalObjectParam(params, 'body') ?? {};
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    await service.requestPeerInvite(targetPublicKey, body);
    return {
      accountId,
      targetPublicKey,
      requested: true,
      body,
    };
  });

  register('relay.peer.accept', async (params) => {
    const accountId = getAccountIdParam(params);
    const signal = parseReceivedPeerSignal(params.signal ?? params);
    const ttlSeconds = getOptionalPositiveIntegerParam(params, 'ttlSeconds');
    const maxUses = getOptionalPositiveIntegerParam(params, 'maxUses');
    const body = getOptionalObjectParam(params, 'body') ?? {};
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    const offer = await service.acceptPeerRequest(signal, {
      ...(ttlSeconds ? { ttlSeconds } : {}),
      ...(maxUses ? { maxUses } : {}),
    }, body);
    return {
      accountId,
      peerPublicKey: signal.source,
      ...offer,
      connectedPeers: service.listConnectedPeers(),
    };
  });

  register('relay.peer.reject', async (params) => {
    const accountId = getAccountIdParam(params);
    const signal = parseReceivedPeerSignal(params.signal ?? params);
    const reason = getOptionalStringParam(params, 'reason') ?? 'rejected';
    const body = getOptionalObjectParam(params, 'body') ?? {};
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    await service.rejectPeerRequest(signal, reason, body);
    return {
      accountId,
      peerPublicKey: signal.source,
      rejected: true,
      reason,
      body,
    };
  });

  register('relay.peer.connect', async (params) => {
    const accountId = getAccountIdParam(params);
    const signal = parseReceivedPeerSignal(params.signal ?? params);
    const clientId = getOptionalStringParam(params, 'clientId');
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    await service.connectFromInviteOffer(signal, {
      ...(clientId ? { clientId } : {}),
    });
    return {
      accountId,
      peerPublicKey: signal.source,
      connected: true,
      connectedPeers: service.listConnectedPeers(),
    };
  });

  register('relay.peer.call', async (params) => {
    const accountId = getAccountIdParam(params);
    const peerPublicKey = getRequiredStringParam(params, 'peerPublicKey');
    const method = getRequiredStringParam(params, 'method');
    const requestParams = getOptionalObjectParam(params, 'params') ?? {};
    const autoDial = getOptionalBooleanParam(params, 'autoDial');
    const body = getOptionalObjectParam(params, 'body')
      ?? getOptionalObjectParam(params, 'request')
      ?? {};
    const clientId = getOptionalStringParam(params, 'clientId');
    const timeoutMs = getOptionalPositiveIntegerParam(params, 'timeoutMs');
    const pollIntervalMs = getOptionalPositiveIntegerParam(params, 'pollIntervalMs');
    const requestTimeoutMs = getOptionalPositiveIntegerParam(params, 'requestTimeoutMs');
    const service = getRelayPeerService(api, accountId);
    await service.ensureStarted();
    const result = await service.requestPeer(peerPublicKey, method, requestParams, {
      ...(autoDial !== undefined ? { autoDial } : {}),
      ...(Object.keys(body).length > 0 ? { body } : {}),
      ...(clientId ? { clientId } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    });
    return {
      accountId,
      peerPublicKey,
      method,
      connectedPeers: service.listConnectedPeers(),
      result,
      peerSessions: service.listPeerSessionStatuses(),
    };
  });

  register('relay.peer.disconnect', async (params) => {
    const accountId = getAccountIdParam(params);
    const peerPublicKey = getOptionalStringParam(params, 'peerPublicKey');
    const service = getRelayPeerService(api, accountId);
    if (peerPublicKey) {
      await service.closePeerSession(peerPublicKey);
    } else {
      await service.closeAllPeerSessions();
    }
    return {
      accountId,
      ...(peerPublicKey ? { peerPublicKey } : {}),
      connectedPeers: service.listConnectedPeers(),
    };
  });
}

async function maybeAutoAcceptPeerSignals(params: {
  api: OpenClawPluginApi;
  accountId: string;
  log?: PluginLogger;
}): Promise<void> {
  const account = resolveRelayAccount(params.api.runtime.config.loadConfig(), params.accountId);
  const autoAccept = account.peerDiscovery?.autoAcceptRequests;
  if (autoAccept?.enabled !== true) return;
  const service = getRelayPeerService(params.api, params.accountId);
  const signals = service.drainSignals();
  if (signals.length > 0) {
    for (const signal of signals) {
      if (!isInviteRequestSignal(signal)) {
        params.log?.debug?.(`[relay:${params.accountId}] leaving non-request peer signal unhandled (${signal.envelope.kind})`);
        continue;
      }
      try {
        await service.acceptPeerRequest(signal, {
          ttlSeconds: autoAccept.ttlSeconds ?? 300,
          maxUses: autoAccept.maxUses ?? 1,
        }, { auto_accepted: true });
        params.log?.info(`[relay:${params.accountId}] auto-accepted peer request from ${signal.source}`);
      } catch (error) {
        params.log?.warn(`[relay:${params.accountId}] auto-accept failed for ${signal.source}: ${String(error)}`);
      }
    }
  }
  const signalErrors = service.drainSignalErrors();
  if (signalErrors.length > 0) {
    for (const frame of signalErrors) {
      params.log?.warn(`[relay:${params.accountId}] peer signal error${frame.target ? ` for ${frame.target}` : ''}: ${frame.code}`);
    }
  }
}

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
    peerDiscoveryEnabled: account.peerDiscovery?.enabled === true,
    ...(account.peerDiscovery?.autoAcceptRequests ? { peerDiscoveryAutoAcceptEnabled: account.peerDiscovery.autoAcceptRequests.enabled === true } : {}),
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
    await closeRelayPeerService(params.accountId);
    await adapter.stop().catch(() => undefined);
    activeAccounts.delete(params.accountId);
    activeChannelRuntimeByAccount.delete(params.accountId);
    const cfg = params.api.runtime.config.loadConfig();
    const resolved = resolveRelayAccount(cfg, params.accountId);
    params.setStatus?.(buildSnapshot(resolved));
  };

  const record: ActiveRelayRecord = { adapter, pairing, stop };
  activeAccounts.set(params.accountId, record);

  try {
    await adapter.start({ waitForRegistered: false });
  } catch (error) {
    activeAccounts.delete(params.accountId);
    await stop();
    throw error;
  }
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
  await maybeAutoAcceptPeerSignals({ api: params.api, accountId: params.accountId, ...(params.log ? { log: params.log } : {}) }).catch((error) => {
    params.log?.debug?.(`[relay:${params.accountId}] initial peer automation failed: ${String(error)}`);
  });
  pollTimer = setInterval(() => {
    void refreshStatus().catch((error) => {
      params.log?.debug?.(`[relay:${params.accountId}] status poll failed: ${String(error)}`);
    });
    void maybeAutoAcceptPeerSignals({ api: params.api, accountId: params.accountId, ...(params.log ? { log: params.log } : {}) }).catch((error) => {
      params.log?.debug?.(`[relay:${params.accountId}] peer automation failed: ${String(error)}`);
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

async function ensureRelayAgentRecord(api: OpenClawPluginApi, options: RelayAgentBridgeStartOptions = {}): Promise<{ accountId: string; record: ActiveRelayRecord }> {
  const accountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
  const record = await ensureStartedAccount({
    api,
    accountId,
    ...(options.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options.setStatus ? { setStatus: options.setStatus } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  api.runtime.system.requestHeartbeatNow?.();
  return { accountId, record };
}

export function createRelayAgentBridge(api: OpenClawPluginApi): RelayAgentBridge {
  return {
    ensureStarted: async (options = {}) => {
      const { record } = await ensureRelayAgentRecord(api, options);
      return record.adapter.getStatus();
    },

    stopAccount: async (accountId = DEFAULT_ACCOUNT_ID) => {
      await stopActiveAccount(accountId);
      api.runtime.system.requestHeartbeatNow?.();
    },

    getStatus: async (accountId = DEFAULT_ACCOUNT_ID) => {
      const record = activeAccounts.get(accountId);
      return record ? record.adapter.getStatus() : undefined;
    },

    discoverPeers: async (options = {}) => {
      const { timeoutMs = 10000, ...startOptions } = options;
      const { record } = await ensureRelayAgentRecord(api, startOptions);
      return record.adapter.discoverPeers(timeoutMs);
    },

    sendPeerSignal: async (targetPublicKey, envelope, options = {}) => {
      const { record } = await ensureRelayAgentRecord(api, options);
      await record.adapter.sendPeerSignal(targetPublicKey, envelope);
    },

    createPeerInvite: async (options = {}) => {
      const { ttlSeconds = 300, ...startOptions } = options;
      const { record } = await ensureRelayAgentRecord(api, startOptions);
      return record.adapter.createPeerInvite(ttlSeconds);
    },

    acceptPeerSignal: async (sourcePublicKey, options = {}) => {
      const { ttlSeconds = 300, maxUses = 1, ...startOptions } = options;
      const { record } = await ensureRelayAgentRecord(api, startOptions);
      const authorization = await record.adapter.authorizePeerPublicKey(sourcePublicKey, ttlSeconds, maxUses);
      const invite = await record.adapter.createPeerInvite(ttlSeconds);
      return {
        sourcePublicKey,
        fingerprint: authorization.fingerprint,
        peerAuthorizedUntil: authorization.expiresAt,
        ...invite,
      };
    },

    dialPeerInvite: async (inviteToken, gatewayPublicKey, options = {}) => {
      const { clientId, onClosed, ...startOptions } = options;
      const { record } = await ensureRelayAgentRecord(api, startOptions);
      return record.adapter.dialPeerInvite(inviteToken, gatewayPublicKey, clientId, onClosed);
    },

    drainPeerSignals: (accountId = DEFAULT_ACCOUNT_ID) => {
      return activeAccounts.get(accountId)?.adapter.drainPeerSignals() ?? [];
    },

    drainPeerSignalErrors: (accountId = DEFAULT_ACCOUNT_ID) => {
      return activeAccounts.get(accountId)?.adapter.drainPeerSignalErrors() ?? [];
    },
  };
}

export function createOpenClawRelayPlugin(api: OpenClawPluginApi, previewPlugin: ChannelPlugin<ResolvedRelayAccount>): { channelPlugin: ChannelPlugin<ResolvedRelayAccount>; registerCli: () => void } {
  registerRelayGatewayMethods(api);

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
        .option('--discoverable', 'Explicitly opt this gateway into agent-only peer discovery')
        .option('--discover-label <value>', 'Set a human-readable discovery label to advertise to other gateways')
        .option('--discover-metadata-json <json>', 'Set discovery metadata as a JSON object (operator-controlled, gateway-only)')
        .option('--clear-discovery-metadata', 'Remove configured discovery metadata for this account')
        .option('--peer-auto-accept', 'Automatically accept inbound agent peer invite requests on this gateway')
        .option('--peer-auto-accept-ttl <seconds>', 'TTL seconds for auto-accepted peer invites')
        .option('--peer-auto-accept-max-uses <n>', 'Maximum uses for auto-accepted peer invites')
        .action(async (options: {
          server: string;
          account?: string;
          discoverable?: boolean;
          discoverLabel?: string;
          discoverMetadataJson?: string;
          clearDiscoveryMetadata?: boolean;
          peerAutoAccept?: boolean;
          peerAutoAcceptTtl?: string;
          peerAutoAcceptMaxUses?: string;
        }) => {
          const accountId = options.account ?? DEFAULT_ACCOUNT_ID;
          const store = new OpenClawRelayConfigStore(api.runtime);
          const existing = await store.load(accountId);

          let discoveryMetadata: Record<string, unknown> | null | undefined;
          if (options.clearDiscoveryMetadata === true) {
            discoveryMetadata = null;
          } else if (options.discoverMetadataJson || options.discoverLabel) {
            const base = options.discoverMetadataJson
              ? parseJsonObjectOption(options.discoverMetadataJson, '--discover-metadata-json')
              : structuredClone(existing?.peerDiscovery?.metadata ?? {}) as Record<string, unknown>;
            if (options.discoverLabel) {
              base.label = options.discoverLabel;
            }
            discoveryMetadata = base;
          }

          const peerAutoAcceptTtl = options.peerAutoAcceptTtl !== undefined ? Number(options.peerAutoAcceptTtl) : undefined;
          if (peerAutoAcceptTtl !== undefined && (!Number.isInteger(peerAutoAcceptTtl) || peerAutoAcceptTtl <= 0)) {
            throw new Error('--peer-auto-accept-ttl must be a positive integer');
          }
          const peerAutoAcceptMaxUses = options.peerAutoAcceptMaxUses !== undefined ? Number(options.peerAutoAcceptMaxUses) : undefined;
          if (peerAutoAcceptMaxUses !== undefined && (!Number.isInteger(peerAutoAcceptMaxUses) || peerAutoAcceptMaxUses <= 0)) {
            throw new Error('--peer-auto-accept-max-uses must be a positive integer');
          }

          await handleRelayEnable(
            store,
            options.server,
            accountId,
            {
              ...(options.discoverable === true ? { discoverable: true } : {}),
              ...(discoveryMetadata !== undefined ? { discoveryMetadata } : {}),
              ...(options.peerAutoAccept === true ? { autoAcceptRequestsEnabled: true } : {}),
              ...(peerAutoAcceptTtl !== undefined ? { autoAcceptTtlSeconds: peerAutoAcceptTtl } : {}),
              ...(peerAutoAcceptMaxUses !== undefined ? { autoAcceptMaxUses: peerAutoAcceptMaxUses } : {}),
            },
          );
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
                peerDiscovery: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    enabled: { type: 'boolean' },
                    metadata: {
                      type: 'object',
                      additionalProperties: true,
                    },
                    autoAcceptRequests: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        enabled: { type: 'boolean' },
                        ttlSeconds: { type: 'integer', minimum: 1 },
                        maxUses: { type: 'integer', minimum: 1 },
                      },
                    },
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
        'accounts.default.peerDiscovery.enabled': { label: 'Enable Agent Discovery', help: 'Allow this OpenClaw gateway to advertise itself to other gateways on the same relay. Human-facing clients still cannot browse peers.' },
        'accounts.default.peerDiscovery.metadata': { label: 'Discovery Metadata', help: 'Operator-controlled metadata advertised only to other discoverable gateways. The relay treats it as opaque data.' },
        'accounts.default.peerDiscovery.autoAcceptRequests.enabled': { label: 'Auto Accept Peer Requests', help: 'Automatically accept inbound peer invite requests and issue short-lived invites without exposing relay discovery to human-facing clients.' },
        'accounts.default.peerDiscovery.autoAcceptRequests.ttlSeconds': { label: 'Auto Accept Invite TTL', help: 'How long auto-issued peer invites remain valid.' },
        'accounts.default.peerDiscovery.autoAcceptRequests.maxUses': { label: 'Auto Accept Invite Max Uses', help: 'How many times an auto-issued peer invite may be used before expiring.' },
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
