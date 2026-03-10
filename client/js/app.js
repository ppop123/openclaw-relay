/**
 * Application layer: UI state management, DOM interaction, settings.
 *
 * This is the entry point for the browser client. It wires the transport
 * layer to the DOM and handles user interactions.
 */

import { renderMarkdown } from './markdown.js';
import { protectIdentityBundle, unprotectIdentityBundle } from './identity-bundle.js';
import { RelayConnection } from './transport.js';

// ── Storage keys ──
const STORAGE_KEY_SETTINGS = 'openclaw-relay-settings';
const STORAGE_KEY_PROFILES = 'openclaw-relay-profiles';

// ── UI strings (minimal i18n) ──

const UI_STRINGS = {
  zh: {
    'status.not_connected': '未连接',
    'status.connecting': '连接中…',
    'status.connected': '已连接',
    'status.reconnecting': '连接中…',
    'statusbar.not_connected': '未连接',
    'statusbar.connecting': '连接中…',
    'statusbar.reconnecting': '连接中…',
    'statusbar.connected_secure': '已安全连接',
    'statusbar.connected_to': '已连接到 {host}',

    'token.show': '显示访问令牌',
    'token.hide': '隐藏访问令牌',

    'chat.new_thread': '已开始新的对话。',
    'chat.connect_first': '请先连接，再开始新的对话。',

    'identity.summary.loading': '浏览器身份：加载中…',
    'identity.summary.load_failed': '浏览器身份：加载失败',
    'identity.summary.persist_unavailable': '浏览器身份：无法持久化',
    'identity.summary.not_created': '浏览器身份：尚未创建',

    'identity.mode.persistent': '浏览器身份（已持久化）',
    'identity.mode.memory': '临时身份（仅本页）',
    'identity.mode.unsupported': '无法持久化',
    'identity.mode.not_created': '尚未创建',
    'identity.title': '浏览器身份',

    'sessions.button': '会话',
    'sessions.title': '会话',
    'sessions.close': '关闭',
    'sessions.note': '继续之前的对话，或开始新的对话。',
    'sessions.loading': '加载中…',
    'sessions.empty': '暂无历史会话。',
    'sessions.resume': '继续',
    'sessions.load_more': '加载更多',

    'connect.connected_secure': '已安全连接到你的 OpenClaw。',

    'connect.title': '连接你的 OpenClaw',
    'connect.subtitle': '粘贴 OpenClaw 发给你的配对链接即可。需要手动填写时再展开“手动设置”。',
    'connect.pairing_label': '配对链接',
    'connect.pairing_recommended': '首次使用推荐',
    'connect.pairing_placeholder': 'openclaw-relay://relay.example.com/...',
    'connect.manual_setup': '手动设置',
    'connect.server_address': '服务器地址',
    'connect.server_address_hint': 'Relay URL',
    'connect.access_token': '访问令牌',
    'connect.access_token_hint': 'Channel token',
    'connect.gateway_key': '验证密钥',
    'connect.gateway_key_hint': '由 OpenClaw 管理员提供',
    'connect.connect_btn': '连接',
    'connect.disconnect_btn': '断开连接',

    'profiles.title': '已保存的连接',
    'profiles.empty': '还没有保存的连接。先连接一次，然后保存，方便下次一键使用。',
    'profiles.save_current': '保存当前连接',
    'profiles.save': '保存',
    'profiles.delete': '删除',
    'profiles.name': '名称',


    'chat.new_button': '新对话',
    'chat.export_button': '保存对话',
    'chat.send_button': '发送',
    'chat.input_placeholder': '输入消息…',

    'agent.label': 'Agent',

    'dashboard.button': '概览',
    'dashboard.title': '概览',
    'dashboard.refresh': '刷新',
    'dashboard.close': '关闭',
    'dashboard.system': '系统状态',
    'dashboard.agents': 'Agents',
    'dashboard.cron': '定时任务',
    'dashboard.loading': '加载中…',
    'dashboard.not_available': '当前网关不支持此功能。',

    'profiles.saved': '连接已保存。',
    'profiles.updated': '连接已更新。',
    'profiles.deleted': '连接已删除。',

    'agents.fetch_failed': '获取 agent 列表失败：{error}',
    'agents.select_required': '请先选择一个 agent。',

  },
  en: {
    'status.not_connected': 'Not connected',
    'status.connecting': 'Connecting…',
    'status.connected': 'Connected',
    'status.reconnecting': 'Connecting…',
    'statusbar.not_connected': 'Not connected',
    'statusbar.connecting': 'Connecting…',
    'statusbar.reconnecting': 'Connecting…',
    'statusbar.connected_secure': 'Connected securely',
    'statusbar.connected_to': 'Connected to {host}',

    'token.show': 'Show access token',
    'token.hide': 'Hide access token',

    'chat.new_thread': 'Started a new chat thread.',
    'chat.connect_first': 'Connect before starting a new chat.',

    'identity.summary.loading': 'Browser identity: loading…',
    'identity.summary.load_failed': 'Browser identity: load failed',
    'identity.summary.persist_unavailable': 'Browser identity: persistence unavailable',
    'identity.summary.not_created': 'Browser identity: not created yet',

    'identity.mode.persistent': 'Persistent browser identity',
    'identity.mode.memory': 'Temporary page identity',
    'identity.mode.unsupported': 'Persistence unavailable',
    'identity.mode.not_created': 'Not created yet',
    'identity.title': 'Browser identity',

    'sessions.button': 'Sessions',
    'sessions.title': 'Sessions',
    'sessions.close': 'Close',
    'sessions.note': 'Resume a previous conversation, or start a fresh one.',
    'sessions.loading': 'Loading…',
    'sessions.empty': 'No previous sessions yet.',
    'sessions.resume': 'Resume',
    'sessions.load_more': 'Load more',

    'connect.connected_secure': 'Connected securely to your OpenClaw.',

    'connect.title': 'Connect to your OpenClaw',
    'connect.subtitle': 'Paste the pairing link from OpenClaw. Open Manual setup only if you need to enter details yourself.',
    'connect.pairing_label': 'Pairing link',
    'connect.pairing_recommended': 'Recommended for first-time setup',
    'connect.pairing_placeholder': 'openclaw-relay://relay.example.com/...',
    'connect.manual_setup': 'Manual setup',
    'connect.server_address': 'Server address',
    'connect.server_address_hint': 'Relay URL',
    'connect.access_token': 'Access token',
    'connect.access_token_hint': 'Channel token',
    'connect.gateway_key': 'Verification key',
    'connect.gateway_key_hint': 'Provided by your OpenClaw operator',
    'connect.connect_btn': 'Connect',
    'connect.disconnect_btn': 'Disconnect',

    'profiles.title': 'Saved connections',
    'profiles.empty': 'No saved connections yet. Connect once, then save this connection for next time.',
    'profiles.save_current': 'Save this connection',
    'profiles.save': 'Save',
    'profiles.delete': 'Delete',
    'profiles.name': 'Name',


    'chat.new_button': 'New chat',
    'chat.export_button': 'Save conversation',
    'chat.send_button': 'Send',
    'chat.input_placeholder': 'Type a message…',

    'agent.label': 'Agent',

    'dashboard.button': 'Dashboard',
    'dashboard.title': 'Dashboard',
    'dashboard.refresh': 'Refresh',
    'dashboard.close': 'Close',
    'dashboard.system': 'System status',
    'dashboard.agents': 'Agents',
    'dashboard.cron': 'Cron tasks',
    'dashboard.loading': 'Loading…',
    'dashboard.not_available': 'This gateway does not support this feature yet.',

    'profiles.saved': 'Connection saved.',
    'profiles.updated': 'Connection updated.',
    'profiles.deleted': 'Connection deleted.',

    'agents.fetch_failed': 'Failed to fetch agents: {error}',
    'agents.select_required': 'Please select an agent.',

  },
};

function formatUiString(template, vars) {
  if (!vars) return template;
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

// ── Toast notifications ──

export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Application ──

export const app = {
  language: 'zh',
  connection: new RelayConnection(),
  agents: [],
  profiles: [],
  selectedAgentPreference: '',
  chatTranscript: [],
  sessionId: null,
  currentStreamEl: null,
  currentStreamText: '',
  streamEpoch: 0,
  _profileSavePromptDismissed: false,
  _desktopLaunchListenerBound: false,
  _pendingDesktopAutoConnect: false,
  _lastDesktopPairingLink: '',
  _initComplete: false,

  async init() {
    this._initComplete = false;
    if (!this._desktopLaunchListenerBound && globalThis.addEventListener) {
      globalThis.addEventListener('openclaw-relay-launch-args', (event) => {
        void this._handleDesktopLaunchArgsEvent(event?.detail);
      });
      this._desktopLaunchListenerBound = true;
    }

    const usedLaunchPairing = this._applyDesktopLaunchArgs();
    const usedPairingFragment = usedLaunchPairing ? false : this._applyPairingFragment();

    // Migration: clean up any historically saved channelToken (bearer secret)
    const saved = this._loadSettings();
    this.language = saved.language === 'en' ? 'en' : 'zh';
    this._applyLanguageToStaticDom();
    const langBtn = document.getElementById('langToggleBtn');
    if (langBtn) langBtn.textContent = this.language === 'zh' ? 'EN' : '中文';
    // Ensure static labels reflect saved language
    this.setLanguage(this.language);
    if (saved.channelToken) {
      delete saved.channelToken;
      try {
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(saved));
      } catch {}
    }

    this.profiles = this._loadProfiles();
    this.selectedAgentPreference = saved.selectedAgent || '';
    this._renderProfiles(saved.selectedProfileId || '');

    const selectedProfile = saved.selectedProfileId ? this._findProfile(saved.selectedProfileId) : null;
    if (usedPairingFragment) {
      document.getElementById('profileName').value = '';
      this._setProfileSelection('');
    } else if (selectedProfile) {
      this._applyProfileToForm(selectedProfile);
      this._setProfileSelection(selectedProfile.id);
    } else if (saved.relayUrl || saved.gatewayPubKey) {
      if (saved.relayUrl) document.getElementById('relayUrl').value = saved.relayUrl;
      if (saved.gatewayPubKey) document.getElementById('gatewayPubKey').value = saved.gatewayPubKey;
      document.getElementById('profileName').value = '';
      this._setProfileSelection('');
    } else if (this.profiles[0]) {
      this._applyProfileToForm(this.profiles[0]);
      this._setProfileSelection(this.profiles[0].id);
    } else {
      document.getElementById('profileName').value = '';
      this._setProfileSelection('');
    }
    this._updateProfileActionState();
    this._updateProfilesView();

    // Wire transport callbacks to UI
    this.connection.onStateChange = (state) => this._updateStatus(state);
    this.connection.onNotify = (event, data) => this._handleNotify(event, data);
    this.connection.onToast = (msg, type) => showToast(msg, type);

    // Enable send button when there's input
    document.getElementById('messageInput').addEventListener('input', () => {
      document.getElementById('sendBtn').disabled =
        !document.getElementById('messageInput').value.trim() ||
        this.connection.state !== 'connected';
    });

    document.getElementById('identityImportInput').addEventListener('change', (event) => {
      void this.handleImportIdentity(event);
    });
    document.getElementById('profileSelect').addEventListener('change', () => {
      this.handleProfileSelectChange();
    });
    document.getElementById('agentSelect').addEventListener('change', () => {
      this.handleAgentSelectChange();
    });
    document.getElementById('pairingLink')?.addEventListener('change', () => {
      if (!document.getElementById('pairingLink').value.trim()) return;
      try {
        this._applyPairingLinkInput();
      } catch (error) {
        const errorEl = document.getElementById('connectError');
        if (errorEl) {
          errorEl.textContent = error.message;
          errorEl.style.display = 'block';
        }
      }
    });

    await this.connection.hydratePersistedIdentity();
    this._updateIdentityStatus();
    this._updateDiagnostics();
    this._initComplete = true;

    if (usedLaunchPairing || this._pendingDesktopAutoConnect) {
      this._pendingDesktopAutoConnect = false;
      await this.handleConnect({ preventDefault() {} });
    }

  },

  t(key, vars) {
    const lang = this.language === 'en' ? 'en' : 'zh';
    const table = UI_STRINGS[lang] || UI_STRINGS.zh;
    const template = table[key] || UI_STRINGS.en[key] || key;
    return formatUiString(template, vars);
  },

  setLanguage(lang) {
    const next = lang === 'en' ? 'en' : 'zh';
    this.language = next;
    this._saveSettings({ language: next });

    const btn = document.getElementById('langToggleBtn');
    if (btn) btn.textContent = next === 'zh' ? 'EN' : '中文';

    this._applyLanguageToStaticDom();
    this._updateStatus(this.connection.state);
    this._updateIdentityStatus();
    this._updateDiagnostics();
  },

  toggleLanguage() {
    this.setLanguage(this.language === 'zh' ? 'en' : 'zh');
  },

  _applyLanguageToStaticDom() {
    const lang = this.language === 'en' ? 'en' : 'zh';

    const nodes = document.querySelectorAll?.('[data-i18n]') || [];
    for (const node of nodes) {
      const key = node.getAttribute?.('data-i18n');
      if (!key) continue;
      const table = UI_STRINGS[lang] || UI_STRINGS.zh;
      const value = table[key] || UI_STRINGS.en[key];
      if (typeof value === 'string') node.textContent = value;
    }

    const placeholders = document.querySelectorAll?.('[data-i18n-placeholder]') || [];
    for (const node of placeholders) {
      const key = node.getAttribute?.('data-i18n-placeholder');
      if (!key) continue;
      const table = UI_STRINGS[lang] || UI_STRINGS.zh;
      const value = table[key] || UI_STRINGS.en[key];
      if (typeof value === 'string') node.setAttribute?.('placeholder', value);
    }

    const connectBtn = document.getElementById('connectBtn');
    if (connectBtn) {
      connectBtn.textContent = this.t('connect.connect_btn');
    }

    const disconnectBtn = document.getElementById('disconnectBtn');
    if (disconnectBtn) {
      disconnectBtn.textContent = this.t('connect.disconnect_btn');
    }
  },

  async _handleDesktopLaunchArgsEvent(rawArgs) {
    const used = this._applyDesktopLaunchArgs(rawArgs);
    if (!used) return false;

    if (!this._initComplete) {
      this._pendingDesktopAutoConnect = true;
      return true;
    }

    if (this.connection.state !== 'disconnected') {
      this.disconnect();
    }
    await this.handleConnect({ preventDefault() {} });
    return true;
  },

  _applyDesktopLaunchArgs(rawArgs = globalThis.__OPENCLAW_RELAY_LAUNCH_ARGS) {
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    if (!args.length) return false;

    let pairingCandidate = '';
    let fields = null;
    for (const value of args) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const candidate = value.trim();
      try {
        fields = this._parsePairingLink(candidate);
        pairingCandidate = candidate;
        break;
      } catch {}
    }

    globalThis.__OPENCLAW_RELAY_LAUNCH_ARGS = [];
    if (!fields || !pairingCandidate) return false;
    if (pairingCandidate === this._lastDesktopPairingLink) return false;

    this._lastDesktopPairingLink = pairingCandidate;
    this._applyPairingFields(fields);
    return true;
  },

  _applyPairingFragment() {
    const hash = globalThis.location?.hash;
    if (!hash || hash.length < 2) return false;

    const fields = this._extractPairingFragment(hash);
    if (!fields) return false;

    this._applyPairingFields(fields);

    const cleanUrl = `${globalThis.location.origin}${globalThis.location.pathname}`;
    globalThis.history?.replaceState?.(null, '', cleanUrl);
    return true;
  },

  _applyPairingLinkInput() {
    const value = document.getElementById('pairingLink')?.value.trim();
    if (!value) return false;

    const fields = this._parsePairingLink(value);
    this._applyPairingFields(fields);

    const errorEl = document.getElementById('connectError');
    if (errorEl) errorEl.style.display = 'none';
    return true;
  },

  _applyPairingFields({ relayUrl, channelToken, gatewayPubKey, autoConnect }, { clearProfile = true } = {}) {
    if (relayUrl) document.getElementById('relayUrl').value = relayUrl;
    if (channelToken) document.getElementById('channelToken').value = channelToken;
    if (gatewayPubKey) document.getElementById('gatewayPubKey').value = gatewayPubKey;
    if (autoConnect === true) {
      this._pendingDesktopAutoConnect = true;
    }
    if (clearProfile) {
      document.getElementById('profileName').value = '';
      this._setProfileSelection('');
    }
    return true;
  },

  _extractPairingFragment(hash) {
    if (!hash) return null;
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const params = new URLSearchParams(raw);
    const relayUrl = params.get('relay')?.trim() || '';
    const channelToken = params.get('token')?.trim() || '';
    const gatewayPubKey = params.get('key')?.trim() || '';
    const autoConnect = params.get('auto')?.trim() || '';

    if (!relayUrl && !channelToken && !gatewayPubKey) return null;
    if (!relayUrl || !channelToken || !gatewayPubKey) {
      throw new Error('Pairing link is incomplete. It must include the server address, access token, and verification key.');
    }

    return {
      relayUrl,
      channelToken,
      gatewayPubKey,
      autoConnect: autoConnect === '1' || autoConnect.toLowerCase() === 'true',
    };
  },

  _parsePairingLink(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error('Paste the pairing link from OpenClaw pairing.');
    }

    if (trimmed.startsWith('#')) {
      const fields = this._extractPairingFragment(trimmed);
      if (fields) return fields;
      throw new Error('Pairing link is invalid. Paste the full link from OpenClaw pairing.');
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('Pairing link is invalid. Paste the full link from OpenClaw pairing.');
    }

    if (parsed.protocol === 'openclaw-relay:') {
      const channelToken = parsed.pathname.replace(/^\/+/, '').trim();
      const gatewayPubKey = parsed.hash.replace(/^#/, '').trim();
      if (!parsed.host || !channelToken || !gatewayPubKey) {
        throw new Error('Pairing link is incomplete. Paste the full link from OpenClaw pairing.');
      }
      return {
        relayUrl: this._buildRelayUrlFromPairingHost(parsed.host),
        channelToken,
        gatewayPubKey,
      };
    }

    const fragmentFields = this._extractPairingFragment(parsed.hash);
    if (fragmentFields) return fragmentFields;

    throw new Error('Pairing link is invalid. Paste the full link from OpenClaw pairing.');
  },

  _buildRelayUrlFromPairingHost(host) {
    const normalizedHost = host.trim();
    if (!normalizedHost) {
      throw new Error('Pairing link is missing the relay host.');
    }

    let hostname = normalizedHost;
    try {
      hostname = new URL(`http://${normalizedHost}`).hostname;
    } catch {}

    const scheme = this._isLikelyLocalRelayHost(hostname) ? 'ws' : 'wss';
    return `${scheme}://${normalizedHost}/ws`;
  },

  _isLikelyLocalRelayHost(hostname) {
    const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!normalized) return false;
    if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.local')) return true;
    if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
    return /^172\.(1[6-9]|2\d|3[01])\./.test(normalized);
  },

  // ── Connection ──

  async handleConnect(e) {
    e.preventDefault();

    const btn = document.getElementById('connectBtn');
    if (btn.disabled) return false;

    const errorEl = document.getElementById('connectError');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    errorEl.style.display = 'none';

    let usedPairingLink = false;
    const pairingLink = document.getElementById('pairingLink')?.value.trim() || '';
    if (pairingLink) {
      try {
        usedPairingLink = this._applyPairingLinkInput();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Connect';
        return false;
      }
    }

    const relayUrl = document.getElementById('relayUrl').value.trim();
    const channelToken = document.getElementById('channelToken').value.trim();
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim();

    // Validate
    if (!relayUrl || !channelToken || !gatewayPubKey) {
      errorEl.textContent = 'Paste a pairing link, or open Manual setup and enter the connection details.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Connect';
      return false;
    }

    const url = this._normalizeRelayUrl(relayUrl);

    // Save settings (channelToken is stripped by _saveSettings)
    this._saveSettings({
      relayUrl: url,
      channelToken,
      gatewayPubKey,
      selectedProfileId: this._getSelectedProfileId(),
    });

    try {
      await this.connection.connect(url, channelToken, gatewayPubKey);
      this._updateIdentityStatus();
      this._updateDiagnostics();

      // Switch to chat view
      document.getElementById('connectPanel').style.display = 'none';
      document.getElementById('chatPanel').classList.add('active');
      document.getElementById('disconnectBtn').style.display = '';
      if (usedPairingLink) {
        document.getElementById('pairingLink').value = '';
      }

      // Fetch agent list
      await this._fetchAgents();

      // Add system message
      this._addSystemMessage(this.t('connect.connected_secure'));
      this._showProfileSavePrompt();

      // Focus input
      document.getElementById('messageInput').focus();

    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
      this._updateIdentityStatus();
      this._updateDiagnostics();
    }

    return false;
  },

  disconnect() {
    this.streamEpoch += 1;
    this.currentStreamEl = null;
    this.currentStreamText = '';
    this._profileSavePromptDismissed = false;
    this._hideProfileSavePrompt();
    this.connection.disconnect();
    this.closeSessions?.();
    this.closeDashboard?.();

    this._returnToConnectView();
    this._updateIdentityStatus();
    this._updateDiagnostics();
  },

  exportCurrentChat() {
    if (!this.chatTranscript.length) {
      showToast('No local chat transcript is available yet.', 'warning');
      return;
    }

    const relayUrl = this.connection.relayUrl || this._normalizeRelayUrl(document.getElementById('relayUrl').value.trim());
    const suffix = (this.sessionId || 'new-chat').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'chat';
    this._downloadJsonFile(`openclaw-relay-chat-${suffix}.json`, {
      exportedAt: new Date().toISOString(),
      relayUrl: relayUrl || '',
      clientId: this.connection.clientId || null,
      sessionId: this.sessionId || null,
      messages: this.chatTranscript.map((entry) => ({ ...entry })),
    });
    showToast('Current chat exported.', 'info');
  },

  startNewChat() {
    if (this.connection.state !== 'connected') {
      showToast(this.t('chat.connect_first'), 'warning');
      return;
    }

    // Cancel any in-flight streaming request so late chunks can't corrupt the new chat.
    this.connection.cancelInFlightStreams?.('New chat started');

    this.streamEpoch += 1;
    document.getElementById('messages').innerHTML = '';
    this.chatTranscript = [];
    this.sessionId = null;
    this.currentStreamEl = null;
    this.currentStreamText = '';
    this._addSystemMessage(this.t('chat.new_thread'));
    this._updateDiagnostics();
  },

  // ── Sessions ──

  async openSessions() {
    const overlay = document.getElementById('sessionsOverlay');
    const list = document.getElementById('sessionsList');
    if (!overlay || !list) return;
    overlay.hidden = false;

    list.innerHTML = `<div class="sessions-loading">${this._escapeHtml(this.t('sessions.loading'))}</div>`;

    try {
      const agent = document.getElementById('agentSelect')?.value || '';
      const result = await this.connection.sendRequest('sessions.list', {
        agent: agent || undefined,
        limit: 20,
        offset: 0,
      });

      const sessions = result?.sessions || result?.result?.sessions || [];
      const total = result?.total ?? result?.result?.total ?? sessions.length;
      this._renderSessionsList(sessions, total, 0);
    } catch (err) {
      list.innerHTML = `<div class="sessions-error">${this._escapeHtml(err.message || String(err))}</div>`;
    }
  },

  closeSessions() {
    const overlay = document.getElementById('sessionsOverlay');
    if (overlay) overlay.hidden = true;
  },

  _renderSessionsList(sessions, total, offset) {
    const list = document.getElementById('sessionsList');
    if (!list) return;

    if (!Array.isArray(sessions) || sessions.length === 0) {
      list.innerHTML = `<div class="sessions-empty">${this._escapeHtml(this.t('sessions.empty'))}</div>`;
      return;
    }

    const rows = sessions.map((session) => this._renderSessionRow(session)).join('');

    const canLoadMore = typeof total === 'number' ? (offset + sessions.length < total) : false;
    const loadMoreButton = canLoadMore
      ? `<button type="button" class="secondary-btn load-more" onclick="app.loadMoreSessions(${offset + sessions.length})">${this._escapeHtml(this.t('sessions.load_more'))}</button>`
      : '';

    list.innerHTML = rows + loadMoreButton;
  },

  async loadMoreSessions(nextOffset) {
    const list = document.getElementById('sessionsList');
    if (!list) return;

    try {
      const agent = document.getElementById('agentSelect')?.value || '';
      const result = await this.connection.sendRequest('sessions.list', {
        agent: agent || undefined,
        limit: 20,
        offset: nextOffset,
      });

      const sessions = result?.sessions || result?.result?.sessions || [];
      const total = result?.total ?? result?.result?.total ?? (nextOffset + sessions.length);

      // Append rows (keep it simple; list is small).
      const loadMoreBtn = list.querySelector?.('button.load-more');
      if (loadMoreBtn) loadMoreBtn.remove();

      const append = sessions.map((session) => this._renderSessionRow(session)).join('');

      const temp = document.createElement('div');
      temp.innerHTML = append;
      for (const row of Array.from(temp.children)) {
        list.appendChild(row);
      }

      const canLoadMore = typeof total === 'number' ? (nextOffset + sessions.length < total) : false;
      if (canLoadMore) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary-btn load-more';
        btn.textContent = this.t('sessions.load_more');
        btn.onclick = () => this.loadMoreSessions(nextOffset + sessions.length);
        list.appendChild(btn);
      }
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  },

  async resumeSession(sessionId) {
    if (!sessionId) return;

    try {
      const result = await this.connection.sendRequest('sessions.history', {
        session_id: sessionId,
        limit: 200,
        before: null,
      });

      const messages = result?.messages || result?.result?.messages || [];
      this.streamEpoch += 1;
      document.getElementById('messages').innerHTML = '';
      this.chatTranscript = [];
      this.sessionId = sessionId;

      for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system';
        const content = msg.content || '';
        this._appendTranscriptEntry(role, content, { sessionId });
        if (role === 'system') {
          const el = document.createElement('div');
          el.className = 'message system';
          el.textContent = content;
          document.getElementById('messages').appendChild(el);
        } else {
          this._addMessage(role, content);
        }
      }

      this.closeSessions();
      showToast(`${this.t('sessions.title')}: ${sessionId}`, 'info');
      this._updateDiagnostics();
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  },


  // ── Dashboard (system/cron) ──

  async openDashboard() {
    const overlay = document.getElementById('dashboardOverlay');
    if (!overlay) return;
    overlay.hidden = false;
    await this.refreshDashboard();
  },

  closeDashboard() {
    const overlay = document.getElementById('dashboardOverlay');
    if (overlay) overlay.hidden = true;
  },

  async refreshDashboard() {
    const kv = document.getElementById('systemStatusKv');
    const agentsList = document.getElementById('agentsList');
    const cronList = document.getElementById('cronList');
    if (kv) kv.innerHTML = '';
    if (agentsList) agentsList.innerHTML = '';
    if (cronList) cronList.innerHTML = '';

    const loading = this._escapeHtml(this.t('dashboard.loading'));
    if (kv) kv.innerHTML = `<div class="k">${loading}</div><div class="v">…</div>`;

    try {
      const status = await this.connection.sendRequest('system.status', {});
      this._renderSystemStatus(status?.result ?? status);
    } catch (err) {
      this._renderSystemStatusError(err);
    }

    // agents list (already used in chat)
    try {
      await this._fetchAgents();
      this._renderAgentsList();
    } catch {}

    // cron list (optional)
    try {
      const result = await this.connection.sendRequest('cron.list', {});
      this._renderCronList(result?.result ?? result);
    } catch (err) {
      this._renderCronListError(err);
    }
  },

  _renderSystemStatus(status) {
    const kv = document.getElementById('systemStatusKv');
    if (!kv) return;

    if (!status || typeof status !== 'object') {
      kv.innerHTML = `<div class="k">—</div><div class="v">${this._escapeHtml(this.t('dashboard.not_available'))}</div>`;
      return;
    }

    const entries = [];
    const version = status.version ?? '';
    const uptime = status.uptime_seconds ?? status.uptimeSeconds;
    const agentsActive = status.agents_active ?? status.agentsActive;
    const cronTasks = status.cron_tasks ?? status.cronTasks;

    if (version) entries.push(['Version', String(version)]);
    if (typeof uptime === 'number') entries.push(['Uptime', `${Math.floor(uptime)}s`]);
    if (typeof agentsActive === 'number') entries.push(['Active agents', String(agentsActive)]);
    if (typeof cronTasks === 'number') entries.push(['Cron tasks', String(cronTasks)]);

    const channels = status.channels;
    if (channels && typeof channels === 'object') {
      for (const [name, state] of Object.entries(channels)) {
        entries.push([`Channel: ${name}`, String(state)]);
      }
    }

    kv.innerHTML = entries.map(([k, v]) => `<div class="k">${this._escapeHtml(k)}</div><div class="v">${this._escapeHtml(v)}</div>`).join('');
  },

  _renderSystemStatusError(err) {
    const kv = document.getElementById('systemStatusKv');
    if (!kv) return;
    kv.innerHTML = `<div class="k">Error</div><div class="v">${this._escapeHtml(err?.message || String(err))}</div>`;
  },

  _renderAgentsList() {
    const agentsList = document.getElementById('agentsList');
    if (!agentsList) return;

    if (!Array.isArray(this.agents) || this.agents.length === 0) {
      agentsList.innerHTML = `<div class="sessions-empty">${this._escapeHtml(this.t('dashboard.not_available'))}</div>`;
      return;
    }

    agentsList.innerHTML = this.agents.map((agent) => {
      const name = agent.display_name || agent.name || '';
      const status = agent.status || '';
      const desc = agent.description || '';
      const sub = [status, desc].filter(Boolean).join(' · ');
      return `
        <div class="dashboard-row">
          <div class="dashboard-row-main">
            <div class="dashboard-row-title">${this._escapeHtml(name)}</div>
            <div class="dashboard-row-sub">${this._escapeHtml(sub)}</div>
          </div>
        </div>
      `;
    }).join('');
  },

  _renderCronList(payload) {
    const cronList = document.getElementById('cronList');
    if (!cronList) return;

    const tasks = payload?.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      cronList.innerHTML = `<div class="sessions-empty">${this._escapeHtml(this.t('dashboard.not_available'))}</div>`;
      return;
    }

    cronList.innerHTML = tasks.map((task) => {
      const id = task.id || '';
      const name = task.name || id;
      const agent = task.agent || '';
      const schedule = task.schedule || '';
      const enabled = Boolean(task.enabled);

      return `
        <div class="dashboard-row">
          <div class="dashboard-row-main">
            <div class="dashboard-row-title">${this._escapeHtml(name)}</div>
            <div class="dashboard-row-sub">${this._escapeHtml([agent, schedule].filter(Boolean).join(' · '))}</div>
          </div>
          <label class="toggle-pill">
            <input type="checkbox" ${enabled ? 'checked' : ''} onchange="app.toggleCronTask('${this._escapeHtml(id)}', this.checked)">
            <span>${enabled ? 'ON' : 'OFF'}</span>
          </label>
        </div>
      `;
    }).join('');
  },

  _renderCronListError(err) {
    const cronList = document.getElementById('cronList');
    if (!cronList) return;
    cronList.innerHTML = `<div class="sessions-error">${this._escapeHtml(err?.message || String(err))}</div>`;
  },

  async toggleCronTask(id, enabled) {
    if (!id) return;
    try {
      await this.connection.sendRequest('cron.toggle', { id, enabled: Boolean(enabled) });
      showToast('OK', 'info', 1500);
      await this.refreshDashboard();
    } catch (err) {
      showToast(err?.message || String(err), 'error');
      await this.refreshDashboard();
    }
  },


  handleProfileSelectChange() {
    const profileId = this._getSelectedProfileId();
    if (!profileId) {
      document.getElementById('profileName').value = '';
      this._updateProfileActionState();
      this._saveSettings({
        relayUrl: document.getElementById('relayUrl').value.trim(),
        gatewayPubKey: document.getElementById('gatewayPubKey').value.trim(),
        selectedProfileId: '',
      });
      this._updateDiagnostics();
      return;
    }

    const profile = this._findProfile(profileId);
    if (!profile) {
      this._setProfileSelection('');
      this._updateProfileActionState();
      return;
    }

    this._applyProfileToForm(profile);
    this._updateProfileActionState();
    this._saveSettings({
      relayUrl: profile.relayUrl,
      gatewayPubKey: profile.gatewayPubKey,
      selectedProfileId: profile.id,
    });
    this._updateDiagnostics();
  },

  handleAgentSelectChange() {
    const selectedAgent = document.getElementById('agentSelect').value || '';
    this.selectedAgentPreference = selectedAgent;
    this._saveSettings({ selectedAgent });
    this._updateAgentStatus();
    this._updateDiagnostics();
  },

  saveProfile() {
    const relayUrl = this._normalizeRelayUrl(document.getElementById('relayUrl').value.trim());
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim();
    if (!relayUrl || !gatewayPubKey) {
      showToast('Relay URL and gateway public key are required to save a profile.', 'warning');
      return;
    }

    const nameInput = document.getElementById('profileName');
    const existingId = this._getSelectedProfileId();
    const now = new Date().toISOString();
    const profile = {
      id: existingId || this._generateProfileId(),
      name: nameInput.value.trim() || this._deriveProfileName(relayUrl),
      relayUrl,
      gatewayPubKey,
      createdAt: existingId ? (this._findProfile(existingId)?.createdAt || now) : now,
      updatedAt: now,
    };

    if (existingId) {
      this.profiles = this.profiles.map((item) => item.id === existingId ? profile : item);
    } else {
      this.profiles = [...this.profiles, profile];
    }

    this._saveProfiles();
    this._renderProfiles(profile.id);
    this._updateProfilesView();
    this._applyProfileToForm(profile);
    this._saveSettings({ relayUrl, gatewayPubKey, selectedProfileId: profile.id });
    this._hideProfileSavePrompt();
    this._updateDiagnostics();
    showToast(existingId ? this.t('profiles.updated') : this.t('profiles.saved'), 'info');
  },

  deleteProfile() {
    const profileId = this._getSelectedProfileId();
    if (!profileId) {
      showToast('Select a saved profile to delete.', 'warning');
      return;
    }

    const profile = this._findProfile(profileId);
    if (!profile) {
      this._setProfileSelection('');
      this._updateProfileActionState();
      return;
    }

    if (typeof confirm === 'function') {
      const confirmed = confirm(`Delete saved profile "${profile.name}"?`);
      if (!confirmed) return;
    }

    this.profiles = this.profiles.filter((item) => item.id !== profileId);
    this._saveProfiles();
    this._renderProfiles('');
    this._updateProfilesView();
    this._setProfileSelection('');
    this._updateProfileActionState();
    this._saveSettings({
      relayUrl: document.getElementById('relayUrl').value.trim(),
      gatewayPubKey: document.getElementById('gatewayPubKey').value.trim(),
      selectedProfileId: '',
    });
    this._updateDiagnostics();
    showToast(this.t('profiles.deleted'), 'info');
  },

  async exportIdentity() {
    try {
      const bundle = await this.connection.exportIdentityBundle();
      const passphrase = this._getIdentityPassphrase();
      const suffix = (bundle.fingerprint || 'identity').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'identity';

      if (passphrase) {
        const protectedBundle = await protectIdentityBundle(bundle, passphrase);
        this._downloadJsonFile(`openclaw-relay-${suffix}.protected.json`, protectedBundle);
        this._clearIdentityPassphrase();
        showToast('Client identity exported with passphrase protection.', 'info');
        return;
      }

      if (typeof confirm === 'function') {
        const confirmed = confirm('Export without a passphrase? The file will contain an unencrypted private key.');
        if (!confirmed) return;
      }

      this._downloadJsonFile(`openclaw-relay-${suffix}.json`, bundle);
      showToast('Client identity exported without passphrase. Keep this file secret.', 'warning');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  triggerImportIdentity() {
    const input = document.getElementById('identityImportInput');
    input.value = '';
    input.click();
  },

  async copyIdentityFingerprint() {
    const summary = this.connection.getIdentitySummary();
    if (!summary.fingerprint) {
      showToast('No identity fingerprint is available yet.', 'warning');
      return;
    }

    try {
      await this._copyText(summary.fingerprint);
      showToast('Identity fingerprint copied.', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async copyIdentityPublicKey() {
    const summary = this.connection.getIdentitySummary();
    if (!summary.publicKey) {
      showToast('No identity public key is available yet.', 'warning');
      return;
    }

    try {
      await this._copyText(summary.publicKey);
      showToast('Identity public key copied.', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async handleImportIdentity(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;

    try {
      const summary = this.connection.getIdentitySummary();
      if (summary.exists && typeof confirm === 'function') {
        const shouldReplace = confirm('Importing an identity file will replace the current browser identity. Continue?');
        if (!shouldReplace) return;
      }

      const parsed = JSON.parse(await this._readTextFile(file));
      const decrypted = await unprotectIdentityBundle(parsed, this._getIdentityPassphrase());
      const nextSummary = await this.connection.importIdentityBundle(decrypted);
      this._returnToConnectView();
      document.getElementById('connectError').style.display = 'none';
      this._updateIdentityStatus();
      this._updateDiagnostics();

      this._clearIdentityPassphrase();
      if (nextSummary.persistence === 'persisted') {
        showToast('Identity imported and saved in this browser.', 'info');
      } else {
        showToast('Identity imported for this page only because persistence is unavailable.', 'warning');
      }
    } catch (err) {
      showToast(`Failed to import identity: ${err.message}`, 'error');
    } finally {
      if (event?.target) {
        event.target.value = '';
      }
    }
  },

  async resetIdentity() {
    const summary = this.connection.getIdentitySummary();
    if (!summary.canReset) {
      this._updateIdentityStatus();
      return;
    }

    if (typeof confirm === 'function') {
      const label = summary.fingerprint ? this._shortFingerprint(summary.fingerprint) : 'this browser identity';
      const confirmed = confirm(`Reset ${label}? Existing gateway trust may need to be re-established.`);
      if (!confirmed) {
        this._updateIdentityStatus();
        return;
      }
    }

    const btn = document.getElementById('resetIdentityBtn');
    btn.disabled = true;

    try {
      await this.connection.resetIdentity();
      this._returnToConnectView();
      document.getElementById('connectError').style.display = 'none';
      this._updateIdentityStatus();
      this._updateDiagnostics();
      showToast('Client identity reset. A new identity will be created on next connect.', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      this._updateIdentityStatus();
    }
  },

  _returnToConnectView() {
    // Switch back to connect view
    document.getElementById('chatPanel').classList.remove('active');
    document.getElementById('connectPanel').style.display = '';
    document.getElementById('disconnectBtn').style.display = 'none';
    this._hideProfileSavePrompt();

    // Clear messages
    document.getElementById('messages').innerHTML = '';
    this.chatTranscript = [];
    this.sessionId = null;
    this.agents = [];
    this._updateDiagnostics();
  },

  _showProfileSavePrompt() {
    if (this._profileSavePromptDismissed) return;

    const relayUrl = this.connection.relayUrl || '';
    const gatewayPubKey = this.connection.gatewayPubKeyB64 || '';
    if (!relayUrl || !gatewayPubKey) return;

    const exists = this.profiles.some((profile) => (
      profile.relayUrl === relayUrl && profile.gatewayPubKey === gatewayPubKey
    ));
    if (exists) {
      this._hideProfileSavePrompt();
      return;
    }

    const banner = document.getElementById('profileSaveBanner');
    if (banner) banner.hidden = false;
  },

  _acceptProfileSave() {
    const relayUrl = this.connection.relayUrl || '';
    const gatewayPubKey = this.connection.gatewayPubKeyB64 || '';
    if (!relayUrl || !gatewayPubKey) return;

    document.getElementById('profileName').value = document.getElementById('profileName').value.trim() || this._deriveProfileName(relayUrl);
    this.saveProfile();
    this._profileSavePromptDismissed = false;
  },

  _dismissProfileSave() {
    this._profileSavePromptDismissed = true;
    this._hideProfileSavePrompt();
  },

  _hideProfileSavePrompt() {
    const banner = document.getElementById('profileSaveBanner');
    if (banner) banner.hidden = true;
  },

  // ── Agents ──

  async _fetchAgents() {
    const select = document.getElementById('agentSelect');
    const previousSelection = select.value || this.selectedAgentPreference;
    try {
      const result = await this.connection.sendRequest('agents.list', {});
      this.agents = result.agents || [];
      select.innerHTML = '';

      if (this.agents.length === 0) {
        select.innerHTML = '<option value="">No agents available</option>';
        return;
      }

      for (const agent of this.agents) {
        const opt = document.createElement('option');
        opt.value = agent.name;
        opt.textContent = agent.display_name
          ? `${agent.display_name} (${agent.name})`
          : agent.name;
        select.appendChild(opt);
      }

      const selectedAgent = this._resolveAvailableAgent(previousSelection);
      select.value = selectedAgent;
      this.selectedAgentPreference = selectedAgent;
      this._saveSettings({ selectedAgent });
      this._updateAgentStatus();
      this._updateDiagnostics();
    } catch (err) {
      select.innerHTML = '<option value="">Failed to load agents</option>';
      showToast(this.t('agents.fetch_failed', { error: err.message }), 'error');
    }
  },

  _updateAgentStatus() {
    const select = document.getElementById('agentSelect');
    const statusEl = document.getElementById('agentStatus');
    const selected = this.agents.find(a => a.name === select.value);
    if (selected) {
      statusEl.textContent = selected.status || '';
      if (selected.description) {
        statusEl.textContent += ' -- ' + selected.description;
      }
    } else {
      statusEl.textContent = '';
    }
  },

  // ── Chat ──

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || this.connection.state !== 'connected') return;

    const agent = document.getElementById('agentSelect').value;
    if (!agent) {
      showToast(this.t('agents.select_required'), 'warning');
      return;
    }

    // Add user message
    this._appendTranscriptEntry('user', text);
    this._addMessage('user', text);

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('sendBtn').disabled = true;

    // Create streaming message element
    const assistantEntry = this._appendTranscriptEntry('assistant', '', { agentName: agent });
    const msgEl = this._addMessage('assistant', '', agent);
    const contentEl = msgEl.querySelector('.msg-content');
    this.currentStreamEl = contentEl;
    this.currentStreamText = '';

    // Add cursor
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    contentEl.appendChild(cursor);
    const streamEpoch = this.streamEpoch;

    try {
      const result = await this.connection.sendStreamRequest(
        'chat.send',
        {
          agent: agent,
          message: text,
          session_id: this.sessionId,
          stream: true
        },
        (chunk) => {
          if (this.streamEpoch !== streamEpoch) return;

          // Handle stream chunk
          if (chunk && chunk.delta) {
            this.currentStreamText += chunk.delta;
            assistantEntry.text = this.currentStreamText;
            contentEl.innerHTML = renderMarkdown(this.currentStreamText);
            // Re-add cursor during streaming
            const c = document.createElement('span');
            c.className = 'cursor';
            contentEl.appendChild(c);
            this._scrollToBottom();
          }
          if (chunk && chunk.session_id) {
            this.sessionId = chunk.session_id;
            this._updateDiagnostics();
          }
        }
      );

      if (this.streamEpoch !== streamEpoch) return;

      // Stream complete: remove cursor and do final render
      if (result && result.session_id) {
        this.sessionId = result.session_id;
        assistantEntry.sessionId = result.session_id;
        this._updateDiagnostics();
      }
      assistantEntry.text = this.currentStreamText;
      contentEl.innerHTML = renderMarkdown(this.currentStreamText);
      this._scrollToBottom();

    } catch (err) {
      if (this.streamEpoch !== streamEpoch) return;

      assistantEntry.text = this.currentStreamText || `(Error: ${err.message})`;
      assistantEntry.error = err.message;
      contentEl.innerHTML = renderMarkdown(this.currentStreamText || '(Error: ' + err.message + ')');
      if (!this.currentStreamText) {
        msgEl.remove();
        this.chatTranscript.pop();
        this._updateDiagnostics();
        showToast('Failed to send: ' + err.message, 'error');
      }
    } finally {
      if (this.streamEpoch === streamEpoch) {
        this.currentStreamEl = null;
        this.currentStreamText = '';
      }
    }
  },

  _addMessage(role, text, agentName) {
    const container = document.getElementById('messages');
    const el = document.createElement('div');
    el.className = `message ${role}`;

    let html = '';
    if (role === 'assistant' && agentName) {
      html += `<div class="agent-name">${this._escapeHtml(agentName)}</div>`;
    }
    html += `<div class="msg-content">${text ? renderMarkdown(text) : ''}</div>`;
    el.innerHTML = html;

    container.appendChild(el);
    this._scrollToBottom();
    return el;
  },

  _addSystemMessage(text) {
    this._appendTranscriptEntry('system', text);
    const container = document.getElementById('messages');
    const el = document.createElement('div');
    el.className = 'message system';
    el.textContent = text;
    container.appendChild(el);
    this._scrollToBottom();
  },

  _appendTranscriptEntry(role, text, extra = {}) {
    const entry = {
      role,
      text,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    this.chatTranscript.push(entry);
    this._updateDiagnostics();
    return entry;
  },

  _scrollToBottom() {
    const container = document.getElementById('messages');
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  },

  // ── Input handling ──

  handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    }
  },

  autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  },

  toggleSection(section) {
    const config = {
      manualSetup: { toggle: 'manualSetupToggle', content: 'manualSetupContent' },
      profiles: { toggle: 'profilesToggle', content: 'profilesContent' },
      identity: { toggle: 'identityToggle', content: 'identityContent' },
      connectionDetails: { toggle: 'connDetailsToggle', content: 'connectionDetailsContent' },
    };
    const entry = config[section];
    if (!entry) return;

    const toggleBtn = document.getElementById(entry.toggle);
    const content = document.getElementById(entry.content);
    if (!toggleBtn || !content) return;

    const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!expanded));
    content.hidden = expanded;
  },

  toggleTokenVisibility() {
    const input = document.getElementById('channelToken');
    const icon = document.getElementById('tokenEyeIcon');
    const button = document.getElementById('tokenVisibilityBtn');
    if (!input) return;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    if (icon) {
      icon.textContent = visible ? '🙈' : '👁';
    }
    if (button) {
      const label = visible ? this.t('token.hide') : this.t('token.show');
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  },

  // ── Notifications ──

  _handleNotify(event, data) {
    if (event === 'agent.status') {
      const agent = this.agents.find(a => a.name === data.agent);
      if (agent) {
        agent.status = data.status;
        this._updateAgentStatus();
      }
    } else if (event === 'system.alert') {
      showToast(`[${data.level}] ${data.message}`, data.level === 'warning' ? 'warning' : 'error');
    }
  },

  // ── Status ──

  _updateStatus(state) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const details = document.getElementById('statusDetails');

    dot.className = 'status-dot ' + (state === 'connected' ? 'connected' : state === 'connecting' || state === 'reconnecting' ? 'connecting' : '');

    const labels = {
      disconnected: this.t('status.not_connected'),
      connecting: this.t('status.connecting'),
      reconnecting: this.t('status.reconnecting'),
      connected: this.t('status.connected'),
    };
    text.textContent = labels[state] || state;

    if (state === 'connected') {
      let host = '';
      try {
        host = new URL(this.connection.relayUrl).host;
      } catch {}
      const suffix = this.connection.encrypted ? ' (encrypted)' : '';
      const fingerprint = this.connection.identityFingerprint
        ? ` · ${this._shortFingerprint(this.connection.identityFingerprint)}`
        : '';
      details.textContent = host ? host + suffix + fingerprint : `Secure${suffix}${fingerprint}`;
      document.getElementById('sendBtn').disabled = !document.getElementById('messageInput').value.trim();
    } else {
      details.textContent = '';
      document.getElementById('sendBtn').disabled = true;
    }

    this._updateDiagnostics();
  },

  _updateDiagnostics() {
    const sessionEl = document.getElementById('sessionValue');
    const clientEl = document.getElementById('clientValue');
    const profileEl = document.getElementById('profileValue');
    const gatewayEl = document.getElementById('gatewayValue');
    const dashboardBtn = document.getElementById('dashboardBtn');
    const sessionsBtn = document.getElementById('sessionsBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const exportChatBtn = document.getElementById('exportChatBtn');
    const statusBarText = document.getElementById('statusBarText');
    const detailSession = document.getElementById('detailSession');
    const detailClient = document.getElementById('detailClient');
    const detailGateway = document.getElementById('detailGateway');
    const detailProfile = document.getElementById('detailProfile');
    const detailEncryption = document.getElementById('detailEncryption');
    const detailIdentity = document.getElementById('detailIdentity');

    const selectedProfile = this._findProfile(this._getSelectedProfileId());
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim() || this.connection.gatewayPubKeyB64 || '';
    const identitySummary = this.connection.getIdentitySummary();
    const agentName = document.getElementById('agentSelect')?.value || '';

    let relayHost = '';
    try {
      const relayUrl = this.connection.relayUrl || this._normalizeRelayUrl(document.getElementById('relayUrl').value.trim());
      relayHost = relayUrl ? new URL(relayUrl).host : '';
    } catch {}

    if (statusBarText) {
      if (this.connection.state === 'connected') {
        const parts = [relayHost ? this.t('statusbar.connected_to', { host: relayHost }) : this.t('statusbar.connected_secure')];
        parts.push(this.connection.encrypted ? 'Encrypted' : 'Security pending');
        if (agentName) parts.push(agentName);
        statusBarText.textContent = parts.join(' · ');
      } else if (this.connection.state === 'connecting') {
        statusBarText.textContent = this.t('statusbar.connecting');
      } else if (this.connection.state === 'reconnecting') {
        statusBarText.textContent = this.t('statusbar.reconnecting');
      } else {
        statusBarText.textContent = this.t('statusbar.not_connected');
      }
    }

    if (sessionEl) {
      sessionEl.textContent = this.sessionId || 'New chat';
      sessionEl.title = this.sessionId || '';
    }
    if (clientEl) {
      clientEl.textContent = this.connection.clientId || 'Pending';
      clientEl.title = this.connection.clientId || '';
    }
    if (profileEl) {
      profileEl.textContent = selectedProfile?.name || 'Custom / unsaved';
      profileEl.title = selectedProfile?.name || '';
    }
    if (gatewayEl) {
      gatewayEl.textContent = gatewayPubKey ? this._shortKey(gatewayPubKey) : 'Not set';
      gatewayEl.title = gatewayPubKey;
    }
    if (detailSession) {
      detailSession.textContent = this.sessionId || 'New chat';
      detailSession.title = this.sessionId || '';
    }
    if (detailClient) {
      detailClient.textContent = this.connection.clientId || 'Pending';
      detailClient.title = this.connection.clientId || '';
    }
    if (detailGateway) {
      detailGateway.textContent = gatewayPubKey ? this._shortKey(gatewayPubKey) : 'Not set';
      detailGateway.title = gatewayPubKey;
    }
    if (detailProfile) {
      detailProfile.textContent = selectedProfile?.name || 'Custom / unsaved';
      detailProfile.title = selectedProfile?.name || '';
    }
    if (detailEncryption) {
      detailEncryption.textContent = this.connection.state === 'connected'
        ? (this.connection.encrypted ? 'AES-256-GCM' : 'Negotiating')
        : '—';
    }
    if (detailIdentity) {
      if (identitySummary.persistence === 'persisted') {
        detailIdentity.textContent = 'Persistent (IndexedDB)';
      } else if (identitySummary.persistence === 'memory') {
        detailIdentity.textContent = 'Temporary (page only)';
      } else if (identitySummary.persistence === 'unsupported') {
        detailIdentity.textContent = 'Temporary (persistence unavailable)';
      } else {
        detailIdentity.textContent = '—';
      }
    }

    if (dashboardBtn) dashboardBtn.disabled = this.connection.state !== 'connected';
    if (sessionsBtn) sessionsBtn.disabled = this.connection.state !== 'connected';
    if (newChatBtn) newChatBtn.disabled = this.connection.state !== 'connected';
    if (exportChatBtn) exportChatBtn.disabled = this.chatTranscript.length === 0;
  },

  _updateIdentitySummary() {
    const el = document.getElementById('identitySummaryText');
    const banner = document.getElementById('identityErrorBanner');
    if (!el) return;

    const summary = this.connection.getIdentitySummary();

    if (summary.loadFailed) {
      el.textContent = this.t('identity.summary.load_failed');
      if (banner) banner.hidden = false;
      return;
    }

    if (banner) banner.hidden = true;

    if (summary.fingerprint) {
      const mode = summary.persistence === 'persisted' ? 'persistent' : summary.persistence === 'memory' ? 'temporary' : summary.persistence;
      el.textContent = `Browser identity: ${this._shortFingerprint(summary.fingerprint)} · ${mode}`;
      return;
    }

    if (summary.persistence === 'unsupported') {
      el.textContent = this.t('identity.summary.persist_unavailable');
      return;
    }

    el.textContent = this.t('identity.summary.not_created');
  },

  _updateIdentityStatus() {
    this._updateIdentitySummary();

    const modeEl = document.getElementById('identityMode');
    const fingerprintEl = document.getElementById('identityFingerprint');
    const metaEl = document.getElementById('identityMeta');
    const recoveryEl = document.getElementById('identityRecoveryHint');
    const exportBtn = document.getElementById('exportIdentityBtn');
    const importBtn = document.getElementById('importIdentityBtn');
    const resetBtn = document.getElementById('resetIdentityBtn');
    const copyFingerprintBtn = document.getElementById('copyFingerprintBtn');
    const copyPublicKeyBtn = document.getElementById('copyPublicKeyBtn');
    const summary = this.connection.getIdentitySummary();

    if (!modeEl || !fingerprintEl || !metaEl || !recoveryEl || !exportBtn || !importBtn || !resetBtn || !copyFingerprintBtn || !copyPublicKeyBtn) {
      return;
    }

    resetBtn.disabled = !summary.canReset;
    exportBtn.disabled = !summary.canExport;
    importBtn.disabled = !summary.canImport;
    copyFingerprintBtn.disabled = !summary.fingerprint;
    copyPublicKeyBtn.disabled = !summary.publicKey;
    recoveryEl.textContent = this._getIdentityRecoveryHint(summary);
    metaEl.textContent = summary.createdAt ? `Created: ${this._formatIdentityCreatedAt(summary.createdAt)}` : '';

    if (summary.persistence === 'persisted') {
      modeEl.textContent = this.t('identity.mode.persistent');
      fingerprintEl.textContent = `Fingerprint: ${this._shortFingerprint(summary.fingerprint)}`;
      fingerprintEl.title = summary.fingerprint;
      return;
    }

    if (summary.persistence === 'memory') {
      modeEl.textContent = this.t('identity.mode.memory');
      fingerprintEl.textContent = summary.fingerprint
        ? `Fingerprint: ${this._shortFingerprint(summary.fingerprint)} · not persisted`
        : 'This page is using a temporary identity only.';
      fingerprintEl.title = summary.fingerprint || '';
      if (!metaEl.textContent) {
        metaEl.textContent = 'This identity will be lost on full reload unless persistence becomes available.';
      }
      return;
    }

    if (summary.persistence === 'unsupported') {
      modeEl.textContent = this.t('identity.mode.unsupported');
      fingerprintEl.textContent = 'This browser cannot persist the client identity; a new key will be created after every reload.';
      fingerprintEl.title = '';
      if (!metaEl.textContent) {
        metaEl.textContent = 'You can still import an identity file for the current page session.';
      }
      return;
    }

    modeEl.textContent = this.t('identity.mode.not_created');
    fingerprintEl.textContent = 'A stable client identity will be created on first connect and saved in this browser.';
    fingerprintEl.title = '';
    metaEl.textContent = 'You can also import an existing identity file before connecting.';
  },

  _updateProfilesView() {
    const empty = document.getElementById('profilesEmpty');
    const list = document.getElementById('profilesList');
    if (!empty || !list) return;

    const hasProfiles = this.profiles.length > 0;
    empty.hidden = hasProfiles;
    list.hidden = !hasProfiles;
  },

  // ── Settings persistence ──

  _saveSettings(settings) {
    try {
      // Never persist channelToken — it's a bearer secret
      const { channelToken, ...safe } = settings;
      const current = this._loadSettings();
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify({ ...current, ...safe }));
    } catch {}
  },

  _loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS) || '{}');
    } catch {
      return {};
    }
  },

  // ── Helpers ──

  _downloadJsonFile(filename, value) {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('This browser cannot export files');
    }

    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },

  async _readTextFile(file) {
    if (typeof file.text === 'function') {
      return file.text();
    }

    throw new Error('This browser cannot read the selected file');
  },

  _formatIdentityCreatedAt(createdAt) {
    return createdAt || '';
  },

  _getIdentityRecoveryHint(summary) {
    if (summary.loadFailed) {
      return 'Stored identity could not be loaded in this tab. Import a backup or reset the browser identity before reconnecting.';
    }
    if (summary.persistence === 'persisted') {
      return 'Backup recommended: export a protected identity file after pairing so you can recover this browser identity later.';
    }
    if (summary.persistence === 'memory') {
      return 'This identity only exists for the current page session. Export it before reloading if you need to preserve gateway trust.';
    }
    if (summary.persistence === 'unsupported') {
      return 'IndexedDB identity storage is unavailable. Import a protected identity file for temporary use or enable browser storage.';
    }
    return 'No browser identity exists yet. Connect once or import an identity file before sharing it with the gateway.';
  },

  async _copyText(text) {
    if (!text) {
      throw new Error('Nothing to copy');
    }

    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return;
    }

    if (typeof document.execCommand === 'function' && document.body?.appendChild) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute?.('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus?.();
      textarea.select?.();
      const copied = document.execCommand('copy');
      textarea.remove?.();
      if (copied) {
        return;
      }
    }

    throw new Error('This browser cannot copy to the clipboard');
  },

  _getIdentityPassphrase() {
    return document.getElementById('identityPassphrase').value;
  },

  _clearIdentityPassphrase() {
    document.getElementById('identityPassphrase').value = '';
  },

  _normalizeRelayUrl(relayUrl) {
    if (!relayUrl) return '';
    return relayUrl.includes('/ws') ? relayUrl : relayUrl.replace(/\/$/, '') + '/ws';
  },

  _loadProfiles() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_PROFILES) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  _saveProfiles() {
    try {
      localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(this.profiles));
    } catch {}
  },

  _renderProfiles(selectedId = '') {
    const select = document.getElementById('profileSelect');
    select.innerHTML = '';

    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Custom / unsaved';
    select.appendChild(custom);

    for (const profile of this.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      select.appendChild(option);
    }

    select.value = selectedId || '';
    this._updateProfileActionState();
  },

  _setProfileSelection(profileId) {
    document.getElementById('profileSelect').value = profileId || '';
    this._updateProfileActionState();
  },

  _getSelectedProfileId() {
    return document.getElementById('profileSelect').value || '';
  },

  _findProfile(profileId) {
    return this.profiles.find((profile) => profile.id === profileId) || null;
  },

  _resolveAvailableAgent(preferredAgent) {
    if (preferredAgent && this.agents.some((agent) => agent.name === preferredAgent)) {
      return preferredAgent;
    }
    return this.agents[0]?.name || '';
  },

  _applyProfileToForm(profile) {
    document.getElementById('profileName').value = profile.name || '';
    document.getElementById('relayUrl').value = profile.relayUrl || '';
    document.getElementById('gatewayPubKey').value = profile.gatewayPubKey || '';
  },

  _updateProfileActionState() {
    document.getElementById('deleteProfileBtn').disabled = !this._getSelectedProfileId();
  },

  _deriveProfileName(relayUrl) {
    try {
      return new URL(relayUrl).host || relayUrl;
    } catch {
      return relayUrl || `Profile ${this.profiles.length + 1}`;
    }
  },

  _generateProfileId() {
    return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  },

  _shortKey(value) {
    if (!value) return '';
    if (value.length <= 20) return value;
    return `${value.slice(0, 12)}…${value.slice(-6)}`;
  },

  _escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  _renderSessionRow(session) {
    const preview = (session.preview || '').trim();
    const agent = session.agent || '';
    const started = session.started_at || session.startedAt || '';
    const last = session.last_message_at || session.lastMessageAt || '';
    const metaParts = [];
    if (agent) metaParts.push(agent);
    if (last) metaParts.push(`last: ${last}`);
    else if (started) metaParts.push(`started: ${started}`);
    if (typeof session.message_count === 'number') metaParts.push(`${session.message_count} msgs`);

    return `
      <div class="session-row">
        <div class="session-main">
          <div class="session-id">${this._escapeHtml(session.id || '')}</div>
          <div class="session-meta">${this._escapeHtml(metaParts.join(' · '))}</div>
          ${preview ? `<div class="session-preview">${this._escapeHtml(preview)}</div>` : ''}
        </div>
        <div class="session-actions">
          <button type="button" class="secondary-btn" onclick="app.resumeSession('${this._escapeHtml(session.id || '')}')">${this._escapeHtml(this.t('sessions.resume'))}</button>
        </div>
      </div>
    `;
  },

  _shortFingerprint(fingerprint) {
    if (!fingerprint) return '';
    if (fingerprint.length <= 28) return fingerprint;
    return `${fingerprint.slice(0, 20)}…${fingerprint.slice(-8)}`;
  }
};

// Expose to global scope for inline event handlers in HTML
window.app = app;

// Boot
document.addEventListener('DOMContentLoaded', () => { void app.init(); });
