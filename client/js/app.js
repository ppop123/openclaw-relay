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

    'admin.button': '管理',
    'admin.title': '管理',
    'admin.refresh': '刷新',
    'admin.close': '关闭',
    'admin.skills': '技能',
    'admin.skills_refresh': '刷新',
    'admin.skills_loading': '加载中…',
    'admin.skills_empty': '暂无技能。',
    'admin.config': '配置',
    'admin.config_load': '读取',
    'admin.config_save': '写入',
    'admin.config_apply': '应用',
    'admin.config_hash_missing': '缺少配置 hash，请先读取。',
    'admin.config_loaded': '配置已读取。',
    'admin.config_saved': '配置已写入。',
    'admin.config_applied': '配置已应用，等待重启。',
    'admin.config_confirm_apply': '确认应用配置并重启网关？',
    'admin.logs': '日志',
    'admin.logs_load': '拉取',
    'admin.logs_reset': '重置',
    'admin.logs_auto': '自动刷新',
    'admin.logs_empty': '暂无日志。',
    'admin.maintenance': '维护',
    'admin.maintenance_note': '更新或重启会暂时中断当前连接。',
    'admin.update_run': '运行更新',
    'admin.update_confirm': '确认运行更新？',
    'admin.update_started': '更新已启动。',
    'admin.reboot': '重启网关',
    'admin.reboot_confirm': '确认重启网关服务？',

    'profiles.saved': '连接已保存。',
    'profiles.updated': '连接已更新。',
    'profiles.deleted': '连接已删除。',

    'agents.fetch_failed': '获取 agent 列表失败：{error}',
    'agents.select_required': '请先选择一个 agent。',
    'agents.no_agents': '无可用 Agent',
    'agents.load_failed_option': '加载 Agent 失败',
    'agents.loading': '正在加载 Agent…',
    'agents.ungrouped': '未分组',
    'chat.new_tab': '新对话',

    'connect.connecting': '连接中…',
    'connect.validation_error': '粘贴配对链接，或展开"手动设置"填写连接信息。',

    'chat.no_transcript': '暂无本地聊天记录。',
    'chat.exported': '对话已导出。',
    'chat.error_prefix': '（错误：{error}）',
    'chat.send_failed': '发送失败：{error}',

    'cron.toggled': 'OK',

    'profiles.save_required': '需要填写服务器地址和验证密钥才能保存。',
    'profiles.select_to_delete': '请先选择要删除的连接。',
    'profiles.confirm_delete': '删除已保存的连接"{name}"？',
    'profiles.custom_unsaved': '自定义 / 未保存',
    'profiles.save_banner_text': '保存此连接？',
    'profiles.save_banner_save': '保存',
    'profiles.save_banner_dismiss': '忽略',

    'identity.card_title': '客户端身份',
    'identity.export_btn': '导出',
    'identity.import_btn': '导入',
    'identity.reset_btn': '重置',
    'identity.copy_fingerprint': '复制指纹',
    'identity.copy_public_key': '复制公钥',
    'identity.passphrase_label': '身份文件密码（可选）',
    'identity.passphrase_placeholder': '仅用于导出/导入',
    'identity.passphrase_note': '不会被存储。设置后用于加密导出文件或解锁受保护的身份文件。',
    'identity.error_banner': '身份加载失败 — 请导入备份或重置',
    'identity.exported_protected': '身份已导出（密码保护）。',
    'identity.confirm_export_unprotected': '不设密码直接导出？文件将包含未加密的私钥。',
    'identity.exported_unprotected': '身份已导出（无密码保护）。请妥善保管此文件。',
    'identity.no_fingerprint': '尚无身份指纹信息。',
    'identity.fingerprint_copied': '身份指纹已复制。',
    'identity.no_public_key': '尚无身份公钥信息。',
    'identity.public_key_copied': '身份公钥已复制。',
    'identity.confirm_import': '导入身份文件将替换当前浏览器身份。是否继续？',
    'identity.imported_persisted': '身份已导入并保存到此浏览器。',
    'identity.imported_memory': '身份已导入，但仅在当前页面有效（无法持久化）。',
    'identity.import_failed': '导入身份失败：{error}',
    'identity.confirm_reset': '重置 {label}？可能需要重新建立网关信任。',
    'identity.reset_success': '身份已重置。下次连接时将创建新身份。',
    'identity.created_at': '创建时间：{date}',
    'identity.fingerprint_prefix': '指纹：{fingerprint}',
    'identity.fingerprint_not_persisted': '指纹：{fingerprint} · 未持久化',
    'identity.temp_only': '当前页面使用的是临时身份。',
    'identity.lost_on_reload': '刷新页面后此身份将丢失，除非持久化变为可用。',
    'identity.cannot_persist': '此浏览器无法持久化客户端身份，每次刷新都会创建新密钥。',
    'identity.can_import_temp': '你仍可以导入身份文件用于当前页面会话。',
    'identity.will_create_on_connect': '首次连接时将创建稳定的客户端身份并保存到此浏览器。',
    'identity.can_import_before_connect': '也可以在连接前导入现有的身份文件。',
    'identity.summary.with_fingerprint': '浏览器身份：{fingerprint} · {mode}',
    'identity.summary.mode_persistent': '已持久化',
    'identity.summary.mode_temporary': '临时',
    'identity.recovery.load_failed': '已存储的身份无法在此标签页加载。请导入备份或重置浏览器身份后重新连接。',
    'identity.recovery.persisted': '建议备份：配对后导出受保护的身份文件，以便日后恢复此浏览器身份。',
    'identity.recovery.memory': '此身份仅存在于当前页面会话。如需保留网关信任，请在刷新前导出。',
    'identity.recovery.unsupported': 'IndexedDB 身份存储不可用。可导入受保护的身份文件临时使用，或启用浏览器存储。',
    'identity.recovery.not_created': '尚无浏览器身份。连接一次或导入身份文件后即可与网关共享。',
    'identity.checking': '正在检查浏览器身份存储…',
    'identity.loading': '加载中…',

    'details.toggle_label': '连接详情',
    'details.session': '会话',
    'details.client': '客户端',
    'details.gateway': '网关',
    'details.profile': '配置',
    'details.encryption': '加密',
    'details.identity_label': '身份',
    'details.new_chat': '新对话',
    'details.pending': '等待中',
    'details.not_set': '未设置',
    'details.persistent_idb': '持久化（IndexedDB）',
    'details.temporary_page': '临时（仅本页）',
    'details.temporary_unavailable': '临时（无法持久化）',
    'details.negotiating': '协商中',

    'statusbar.encrypted': '已加密',
    'statusbar.security_pending': '安全协商中',
    'status.secure': '安全连接',
    'status.encrypted_suffix': '（已加密）',

    'pairing.incomplete': '配对链接不完整。必须包含服务器地址、访问令牌和验证密钥。',
    'pairing.empty': '请粘贴 OpenClaw 配对链接。',
    'pairing.invalid': '配对链接无效。请粘贴完整的 OpenClaw 配对链接。',
    'pairing.incomplete_uri': '配对链接不完整。请粘贴完整的 OpenClaw 配对链接。',
    'pairing.missing_host': '配对链接缺少服务器地址。',

    'browser.cannot_export': '此浏览器不支持导出文件',
    'browser.cannot_read': '此浏览器无法读取所选文件',
    'browser.nothing_to_copy': '没有可复制的内容',
    'browser.cannot_copy': '此浏览器无法复制到剪贴板',

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

    'admin.button': 'Admin',
    'admin.title': 'Admin',
    'admin.refresh': 'Refresh',
    'admin.close': 'Close',
    'admin.skills': 'Skills',
    'admin.skills_refresh': 'Refresh',
    'admin.skills_loading': 'Loading…',
    'admin.skills_empty': 'No skills available.',
    'admin.config': 'Config',
    'admin.config_load': 'Load',
    'admin.config_save': 'Save',
    'admin.config_apply': 'Apply',
    'admin.config_hash_missing': 'Config hash missing; load first.',
    'admin.config_loaded': 'Config loaded.',
    'admin.config_saved': 'Config saved.',
    'admin.config_applied': 'Config applied; restart pending.',
    'admin.config_confirm_apply': 'Apply config and restart the gateway?',
    'admin.logs': 'Logs',
    'admin.logs_load': 'Fetch',
    'admin.logs_reset': 'Reset',
    'admin.logs_auto': 'Auto refresh',
    'admin.logs_empty': 'No logs yet.',
    'admin.maintenance': 'Maintenance',
    'admin.maintenance_note': 'Updates or restarts will temporarily drop the connection.',
    'admin.update_run': 'Run update',
    'admin.update_confirm': 'Run update now?',
    'admin.update_started': 'Update started.',
    'admin.reboot': 'Restart gateway',
    'admin.reboot_confirm': 'Restart the gateway service?',

    'profiles.saved': 'Connection saved.',
    'profiles.updated': 'Connection updated.',
    'profiles.deleted': 'Connection deleted.',

    'agents.fetch_failed': 'Failed to fetch agents: {error}',
    'agents.select_required': 'Please select an agent.',
    'agents.no_agents': 'No agents available',
    'agents.load_failed_option': 'Failed to load agents',
    'agents.loading': 'Loading agents…',
    'agents.ungrouped': 'Ungrouped',
    'chat.new_tab': 'New Chat',

    'connect.connecting': 'Connecting…',
    'connect.validation_error': 'Paste a pairing link, or open Manual setup and enter the connection details.',

    'chat.no_transcript': 'No local chat transcript is available yet.',
    'chat.exported': 'Current chat exported.',
    'chat.error_prefix': '(Error: {error})',
    'chat.send_failed': 'Failed to send: {error}',

    'cron.toggled': 'OK',

    'profiles.save_required': 'Relay URL and gateway public key are required to save a profile.',
    'profiles.select_to_delete': 'Select a saved profile to delete.',
    'profiles.confirm_delete': 'Delete saved profile "{name}"?',
    'profiles.custom_unsaved': 'Custom / unsaved',
    'profiles.save_banner_text': 'Save this connection as a profile?',
    'profiles.save_banner_save': 'Save',
    'profiles.save_banner_dismiss': 'Dismiss',

    'identity.card_title': 'Client identity',
    'identity.export_btn': 'Export',
    'identity.import_btn': 'Import',
    'identity.reset_btn': 'Reset',
    'identity.copy_fingerprint': 'Copy fingerprint',
    'identity.copy_public_key': 'Copy public key',
    'identity.passphrase_label': 'Identity file passphrase (optional)',
    'identity.passphrase_placeholder': 'Used only for export/import',
    'identity.passphrase_note': 'Never stored. Set it to encrypt exports or unlock protected identity files.',
    'identity.error_banner': 'Identity load failed — import a backup or reset',
    'identity.exported_protected': 'Client identity exported with passphrase protection.',
    'identity.confirm_export_unprotected': 'Export without a passphrase? The file will contain an unencrypted private key.',
    'identity.exported_unprotected': 'Client identity exported without passphrase. Keep this file secret.',
    'identity.no_fingerprint': 'No identity fingerprint is available yet.',
    'identity.fingerprint_copied': 'Identity fingerprint copied.',
    'identity.no_public_key': 'No identity public key is available yet.',
    'identity.public_key_copied': 'Identity public key copied.',
    'identity.confirm_import': 'Importing an identity file will replace the current browser identity. Continue?',
    'identity.imported_persisted': 'Identity imported and saved in this browser.',
    'identity.imported_memory': 'Identity imported for this page only because persistence is unavailable.',
    'identity.import_failed': 'Failed to import identity: {error}',
    'identity.confirm_reset': 'Reset {label}? Existing gateway trust may need to be re-established.',
    'identity.reset_success': 'Client identity reset. A new identity will be created on next connect.',
    'identity.created_at': 'Created: {date}',
    'identity.fingerprint_prefix': 'Fingerprint: {fingerprint}',
    'identity.fingerprint_not_persisted': 'Fingerprint: {fingerprint} · not persisted',
    'identity.temp_only': 'This page is using a temporary identity only.',
    'identity.lost_on_reload': 'This identity will be lost on full reload unless persistence becomes available.',
    'identity.cannot_persist': 'This browser cannot persist the client identity; a new key will be created after every reload.',
    'identity.can_import_temp': 'You can still import an identity file for the current page session.',
    'identity.will_create_on_connect': 'A stable client identity will be created on first connect and saved in this browser.',
    'identity.can_import_before_connect': 'You can also import an existing identity file before connecting.',
    'identity.summary.with_fingerprint': 'Browser identity: {fingerprint} · {mode}',
    'identity.summary.mode_persistent': 'persistent',
    'identity.summary.mode_temporary': 'temporary',
    'identity.recovery.load_failed': 'Stored identity could not be loaded in this tab. Import a backup or reset the browser identity before reconnecting.',
    'identity.recovery.persisted': 'Backup recommended: export a protected identity file after pairing so you can recover this browser identity later.',
    'identity.recovery.memory': 'This identity only exists for the current page session. Export it before reloading if you need to preserve gateway trust.',
    'identity.recovery.unsupported': 'IndexedDB identity storage is unavailable. Import a protected identity file for temporary use or enable browser storage.',
    'identity.recovery.not_created': 'No browser identity exists yet. Connect once or import an identity file before sharing it with the gateway.',
    'identity.checking': 'Checking browser identity storage…',
    'identity.loading': 'Loading…',

    'details.toggle_label': 'Connection details',
    'details.session': 'Session',
    'details.client': 'Client',
    'details.gateway': 'Gateway',
    'details.profile': 'Profile',
    'details.encryption': 'Encryption',
    'details.identity_label': 'Identity',
    'details.new_chat': 'New chat',
    'details.pending': 'Pending',
    'details.not_set': 'Not set',
    'details.persistent_idb': 'Persistent (IndexedDB)',
    'details.temporary_page': 'Temporary (page only)',
    'details.temporary_unavailable': 'Temporary (persistence unavailable)',
    'details.negotiating': 'Negotiating',

    'statusbar.encrypted': 'Encrypted',
    'statusbar.security_pending': 'Security pending',
    'status.secure': 'Secure',
    'status.encrypted_suffix': ' (encrypted)',

    'pairing.incomplete': 'Pairing link is incomplete. It must include the server address, access token, and verification key.',
    'pairing.empty': 'Paste the pairing link from OpenClaw pairing.',
    'pairing.invalid': 'Pairing link is invalid. Paste the full link from OpenClaw pairing.',
    'pairing.incomplete_uri': 'Pairing link is incomplete. Paste the full link from OpenClaw pairing.',
    'pairing.missing_host': 'Pairing link is missing the relay host.',

    'browser.cannot_export': 'This browser cannot export files',
    'browser.cannot_read': 'This browser cannot read the selected file',
    'browser.nothing_to_copy': 'Nothing to copy',
    'browser.cannot_copy': 'This browser cannot copy to the clipboard',

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
  skillsReport: null,
  skillsLoading: false,
  skillsError: '',
  skillsBusyKey: null,
  configSnapshot: null,
  configRaw: '',
  configHash: '',
  configPath: '',
  configLoading: false,
  configSaving: false,
  configApplying: false,
  logsLines: [],
  logsCursor: null,
  logsFile: '',
  logsLoading: false,
  logsError: '',
  logsAuto: false,
  logsTruncated: false,
  logsLimit: 200,
  logsMaxBytes: 200000,
  _logsPollTimer: null,
  updateRunning: false,
  rebootRunning: false,
  adminTab: 'skills',

  // Tab state
  tabs: [],
  activeTabId: null,
  splitTabId: null,
  _tabCounter: 0,

  // Per-tab state accessors (delegate to active tab)
  get chatTranscript() { const t = this._activeTab(); return t ? t.transcript : []; },
  set chatTranscript(v) { const t = this._activeTab(); if (t) t.transcript = v; else this._orphanTranscript = v; },
  get sessionId() { const t = this._activeTab(); return t ? t.sessionId : this._orphanSessionId ?? null; },
  set sessionId(v) { const t = this._activeTab(); if (t) t.sessionId = v; else this._orphanSessionId = v; },
  get currentStreamEl() { const t = this._activeTab(); return t ? t.currentStreamEl : null; },
  set currentStreamEl(v) { const t = this._activeTab(); if (t) t.currentStreamEl = v; },
  get currentStreamText() { const t = this._activeTab(); return t ? t.currentStreamText : ''; },
  set currentStreamText(v) { const t = this._activeTab(); if (t) t.currentStreamText = v; },
  get streamEpoch() { const t = this._activeTab(); return t ? t.streamEpoch : this._orphanStreamEpoch ?? 0; },
  set streamEpoch(v) { const t = this._activeTab(); if (t) t.streamEpoch = v; else this._orphanStreamEpoch = v; },

  _orphanTranscript: [],
  _orphanSessionId: null,
  _orphanStreamEpoch: 0,
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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeAgentSelector();
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
      throw new Error(this.t('pairing.incomplete'));
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
      throw new Error(this.t('pairing.empty'));
    }

    if (trimmed.startsWith('#')) {
      const fields = this._extractPairingFragment(trimmed);
      if (fields) return fields;
      throw new Error(this.t('pairing.invalid'));
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(this.t('pairing.invalid'));
    }

    if (parsed.protocol === 'openclaw-relay:') {
      const channelToken = parsed.pathname.replace(/^\/+/, '').trim();
      const gatewayPubKey = parsed.hash.replace(/^#/, '').trim();
      if (!parsed.host || !channelToken || !gatewayPubKey) {
        throw new Error(this.t('pairing.incomplete_uri'));
      }
      return {
        relayUrl: this._buildRelayUrlFromPairingHost(parsed.host),
        channelToken,
        gatewayPubKey,
      };
    }

    const fragmentFields = this._extractPairingFragment(parsed.hash);
    if (fragmentFields) return fragmentFields;

    throw new Error(this.t('pairing.invalid'));
  },

  _buildRelayUrlFromPairingHost(host) {
    const normalizedHost = host.trim();
    if (!normalizedHost) {
      throw new Error(this.t('pairing.missing_host'));
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
    btn.textContent = this.t('connect.connecting');
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
        btn.textContent = this.t('connect.connect_btn');
        return false;
      }
    }

    const relayUrl = document.getElementById('relayUrl').value.trim();
    const channelToken = document.getElementById('channelToken').value.trim();
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim();

    // Validate
    if (!relayUrl || !channelToken || !gatewayPubKey) {
      errorEl.textContent = this.t('connect.validation_error');
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = this.t('connect.connect_btn');
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

      // Create initial tab if none exist
      if (this.tabs.length === 0) {
        const preferred = this.selectedAgentPreference || (this.agents[0]?.name ?? '');
        this.openNewTab(preferred);
      }

      // Add system message
      this._addSystemMessage(this.t('connect.connected_secure'));
      this._showProfileSavePrompt();

      // Focus input
      document.getElementById('messageInput')?.focus();

    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = this.t('connect.connect_btn');
      this._updateIdentityStatus();
      this._updateDiagnostics();
    }

    return false;
  },

  disconnect() {
    // Cancel all tab streams
    for (const tab of this.tabs) tab.streamEpoch += 1;
    this.tabs = [];
    this.activeTabId = null;
    this.splitTabId = null;
    this._renderTabs();
    this._updateSplitView();
    this._profileSavePromptDismissed = false;
    this._hideProfileSavePrompt();
    this.connection.disconnect();
    this.closeSessions?.();
    this.closeDashboard?.();
    this.closeAgentSelector?.();

    this._returnToConnectView();
    this._updateIdentityStatus();
    this._updateDiagnostics();
  },

  exportCurrentChat() {
    if (!this.chatTranscript.length) {
      showToast(this.t('chat.no_transcript'), 'warning');
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
    showToast(this.t('chat.exported'), 'info');
  },

  startNewChat() {
    if (this.connection.state !== 'connected') {
      showToast(this.t('chat.connect_first'), 'warning');
      return;
    }

    const tab = this._activeTab();
    if (!tab) return;

    // Cancel any in-flight streaming request so late chunks can't corrupt the new chat.
    this.connection.cancelInFlightStreams?.('New chat started');

    tab.streamEpoch += 1;
    document.getElementById('messages').innerHTML = '';
    tab.transcript = [];
    tab.sessionId = null;
    tab.currentStreamEl = null;
    tab.currentStreamText = '';
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
      const agent = this._activeTab()?.agent || '';
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
      const agent = this._activeTab()?.agent || '';
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
      showToast(this.t('cron.toggled'), 'info', 1500);
      await this.refreshDashboard();
    } catch (err) {
      showToast(err?.message || String(err), 'error');
      await this.refreshDashboard();
    }
  },


  // ── Admin (skills/config/logs/update) ──

  _withAdminKey(params) {
    return params;
  },

  async openAdmin() {
    const overlay = document.getElementById('adminOverlay');
    if (!overlay) return;
    overlay.hidden = false;
    this.openAdminTab(this.adminTab || 'skills');
    await this.refreshAdmin();
  },

  openAdminTab(tabId) {
    const target = tabId || 'skills';
    this.adminTab = target;
    document.querySelectorAll('.admin-tab').forEach((tab) => {
      const active = tab.dataset.tab === target;
      tab.classList.toggle('is-active', active);
    });
    document.querySelectorAll('.admin-panel').forEach((panel) => {
      const active = panel.dataset.panel === target;
      panel.hidden = !active;
    });
  },

  closeAdmin() {
    const overlay = document.getElementById('adminOverlay');
    if (overlay) overlay.hidden = true;
    this.toggleLogsAuto(false);
  },

  async refreshAdmin() {
    await Promise.all([
      this.refreshSkills(),
      this.loadConfig(),
    ]);
  },

  async refreshSkills() {
    const list = document.getElementById('skillsList');
    const meta = document.getElementById('skillsMeta');
    if (list) {
      list.innerHTML = `<div class="sessions-loading">${this._escapeHtml(this.t('admin.skills_loading'))}</div>`;
    }
    if (meta) meta.textContent = '';
    this.skillsLoading = true;
    this.skillsError = '';
    try {
      const result = await this.connection.sendRequest('skills.status', this._withAdminKey({}));
      this.skillsReport = result?.result ?? result;
      this._renderSkillsList();
    } catch (err) {
      const message = err?.message || String(err);
      this.skillsError = message;
      if (list) {
        list.innerHTML = `<div class="sessions-error">${this._escapeHtml(message)}</div>`;
      }
      if (meta) meta.textContent = message;
    } finally {
      this.skillsLoading = false;
    }
  },

  _renderSkillsList() {
    const list = document.getElementById('skillsList');
    const meta = document.getElementById('skillsMeta');
    if (!list) return;
    const report = this.skillsReport;
    const skills = report?.skills;
    if (!Array.isArray(skills) || skills.length === 0) {
      list.innerHTML = `<div class="sessions-empty">${this._escapeHtml(this.t('admin.skills_empty'))}</div>`;
      if (meta) meta.textContent = '';
      return;
    }

    if (meta) {
      const workspaceDir = typeof report.workspaceDir === 'string' ? report.workspaceDir : '';
      const managedDir = typeof report.managedSkillsDir === 'string' ? report.managedSkillsDir : '';
      const metaParts = [];
      if (workspaceDir) metaParts.push(`workspace: ${workspaceDir}`);
      if (managedDir) metaParts.push(`managed: ${managedDir}`);
      meta.textContent = metaParts.join(' · ');
    }

    list.innerHTML = skills.map((skill) => {
      const name = skill.name || skill.skillKey || '';
      const skillKey = skill.skillKey || skill.name || '';
      const desc = skill.description || '';
      const disabled = Boolean(skill.disabled);
      const eligible = skill.eligible !== false;
      const missingBins = Array.isArray(skill.missing?.bins) ? skill.missing.bins.filter(Boolean) : [];
      const missingEnv = Array.isArray(skill.missing?.env) ? skill.missing.env.filter(Boolean) : [];
      const missing = [...missingBins, ...missingEnv];
      const statusParts = [];
      statusParts.push(disabled ? 'disabled' : 'enabled');
      if (!eligible && missing.length > 0) {
        statusParts.push(`missing: ${missing.join(', ')}`);
      }

      const installs = Array.isArray(skill.install) ? skill.install : [];
      const installButtons = installs.map((entry) => {
        const label = entry?.label || 'Install';
        const installId = entry?.id || '';
        if (!installId || !skillKey) return '';
        return `<button type="button" class="secondary-btn" onclick="app.installSkill('${this._escapeHtml(skillKey)}','${this._escapeHtml(installId)}','${this._escapeHtml(label)}')">${this._escapeHtml(label)}</button>`;
      }).join('');

      return `
        <div class="dashboard-row">
          <div class="dashboard-row-main">
            <div class="dashboard-row-title">${this._escapeHtml(name)}</div>
            <div class="dashboard-row-sub">${this._escapeHtml([desc, ...statusParts].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="dashboard-row-actions">
            ${installButtons}
            <label class="toggle-pill">
              <input type="checkbox" ${disabled ? '' : 'checked'} onchange="app.toggleSkill('${this._escapeHtml(skillKey)}', this.checked)">
              <span>${disabled ? 'OFF' : 'ON'}</span>
            </label>
          </div>
        </div>
      `;
    }).join('');
  },

  async toggleSkill(skillKey, enabled) {
    if (!skillKey) return;
    try {
      await this.connection.sendRequest('skills.update', this._withAdminKey({ skillKey, enabled: Boolean(enabled) }));
      await this.refreshSkills();
    } catch (err) {
      showToast(err?.message || String(err), 'error');
      await this.refreshSkills();
    }
  },

  async installSkill(skillKey, installId, label) {
    if (!skillKey || !installId) return;
    try {
      showToast(label || 'Installing…', 'info', 2000);
      await this.connection.sendRequest('skills.install', this._withAdminKey({ name: skillKey, installId, timeoutMs: 120000 }));
      await this.refreshSkills();
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    }
  },

  updateConfigDraft(value) {
    this.configRaw = String(value ?? '');
  },

  _getConfigDraft() {
    const editor = document.getElementById('configEditor');
    if (editor) return editor.value;
    return this.configRaw;
  },

  async loadConfig() {
    const meta = document.getElementById('configMeta');
    if (meta) meta.textContent = '';
    this.configLoading = true;
    try {
      const result = await this.connection.sendRequest('config.get', this._withAdminKey({}));
      const payload = result?.result ?? result;
      const raw = typeof payload?.raw === 'string'
        ? payload.raw
        : payload?.config
          ? JSON.stringify(payload.config, null, 2)
          : '';
      this.configSnapshot = payload;
      this.configHash = typeof payload?.hash === 'string' ? payload.hash : '';
      this.configPath = typeof payload?.path === 'string' ? payload.path : '';
      this.configRaw = raw;
      const editor = document.getElementById('configEditor');
      if (editor) editor.value = raw;
      this._renderConfigMeta(payload);
      showToast(this.t('admin.config_loaded'), 'info', 1500);
    } catch (err) {
      const message = err?.message || String(err);
      if (meta) meta.textContent = message;
      showToast(message, 'error');
    } finally {
      this.configLoading = false;
    }
  },

  _renderConfigMeta(payload) {
    const meta = document.getElementById('configMeta');
    if (!meta) return;
    const parts = [];
    if (this.configPath) parts.push(`path: ${this.configPath}`);
    if (this.configHash) parts.push(`hash: ${this.configHash}`);
    const issues = Array.isArray(payload?.issues) ? payload.issues.length : 0;
    const warnings = Array.isArray(payload?.warnings) ? payload.warnings.length : 0;
    if (issues) parts.push(`issues: ${issues}`);
    if (warnings) parts.push(`warnings: ${warnings}`);
    meta.textContent = parts.join(' · ');
  },

  async saveConfig() {
    if (!this.configHash) {
      showToast(this.t('admin.config_hash_missing'), 'error');
      return;
    }
    const raw = this._getConfigDraft();
    this.configSaving = true;
    try {
      await this.connection.sendRequest('config.set', this._withAdminKey({ raw, baseHash: this.configHash }));
      showToast(this.t('admin.config_saved'), 'info', 2000);
      await this.loadConfig();
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    } finally {
      this.configSaving = false;
    }
  },

  async applyConfig() {
    if (!this.configHash) {
      showToast(this.t('admin.config_hash_missing'), 'error');
      return;
    }
    if (!confirm(this.t('admin.config_confirm_apply'))) return;
    const raw = this._getConfigDraft();
    this.configApplying = true;
    try {
      await this.connection.sendRequest('config.apply', this._withAdminKey({ raw, baseHash: this.configHash }));
      showToast(this.t('admin.config_applied'), 'info', 2500);
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    } finally {
      this.configApplying = false;
    }
  },

  async refreshLogs(options = {}) {
    const { reset = false, quiet = false } = options;
    if (this.logsLoading && !quiet) return;
    if (!quiet) this.logsLoading = true;
    this.logsError = '';
    const meta = document.getElementById('logsMeta');
    if (reset) {
      this.logsLines = [];
      this.logsCursor = null;
      this.logsTruncated = false;
    }
    try {
      const params = {
        limit: this.logsLimit,
        maxBytes: this.logsMaxBytes,
        ...(this.logsCursor != null && !reset ? { cursor: this.logsCursor } : {}),
      };
      const result = await this.connection.sendRequest('logs.tail', this._withAdminKey(params));
      const payload = result?.result ?? result;
      const lines = Array.isArray(payload?.lines) ? payload.lines.filter((line) => typeof line === 'string') : [];
      const shouldReset = reset || payload?.reset || this.logsCursor == null;
      if (shouldReset) {
        this.logsLines = lines;
      } else if (lines.length > 0) {
        this.logsLines = this.logsLines.concat(lines).slice(-2000);
      }
      if (typeof payload?.cursor === 'number') this.logsCursor = payload.cursor;
      if (typeof payload?.file === 'string') this.logsFile = payload.file;
      this.logsTruncated = payload?.truncated === true;
      this._renderLogs();
    } catch (err) {
      const message = err?.message || String(err);
      this.logsError = message;
      if (meta) meta.textContent = message;
      if (!quiet) showToast(message, 'error');
    } finally {
      if (!quiet) this.logsLoading = false;
    }
  },

  _renderLogs() {
    const viewer = document.getElementById('logsViewer');
    if (viewer) {
      viewer.value = this.logsLines.join('\n');
      viewer.scrollTop = viewer.scrollHeight;
    }
    const meta = document.getElementById('logsMeta');
    if (!meta) return;
    const parts = [];
    if (this.logsFile) parts.push(`file: ${this.logsFile}`);
    if (typeof this.logsCursor === 'number') parts.push(`cursor: ${this.logsCursor}`);
    if (this.logsTruncated) parts.push('truncated');
    meta.textContent = parts.join(' · ') || this.t('admin.logs_empty');
  },

  toggleLogsAuto(enabled) {
    this.logsAuto = Boolean(enabled);
    const toggle = document.getElementById('logsAutoToggle');
    if (toggle) toggle.checked = this.logsAuto;
    if (this.logsAuto) {
      if (!this._logsPollTimer) {
        this._logsPollTimer = setInterval(() => {
          const overlay = document.getElementById('adminOverlay');
          if (overlay && overlay.hidden) return;
          void this.refreshLogs({ quiet: true });
        }, 2000);
      }
      return;
    }
    if (this._logsPollTimer) {
      clearInterval(this._logsPollTimer);
      this._logsPollTimer = null;
    }
  },

  async runUpdate() {
    if (!confirm(this.t('admin.update_confirm'))) return;
    const btn = document.getElementById('updateBtn');
    if (btn) btn.disabled = true;
    this.updateRunning = true;
    try {
      await this.connection.sendRequest('update.run', this._withAdminKey({ timeoutMs: 120000 }));
      showToast(this.t('admin.update_started'), 'info', 2500);
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    } finally {
      this.updateRunning = false;
      if (btn) btn.disabled = false;
    }
  },

  async restartGateway() {
    if (!confirm(this.t('admin.reboot_confirm'))) return;
    const btn = document.getElementById('rebootBtn');
    if (btn) btn.disabled = true;
    this.rebootRunning = true;
    try {
      await this.connection.sendRequest('gateway.restart', this._withAdminKey({}));
      showToast(this.t('admin.reboot'), 'info', 2500);
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    } finally {
      this.rebootRunning = false;
      if (btn) btn.disabled = false;
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
    // Legacy no-op — agent selection is now per-tab via agent selector
  },

  saveProfile() {
    const relayUrl = this._normalizeRelayUrl(document.getElementById('relayUrl').value.trim());
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim();
    if (!relayUrl || !gatewayPubKey) {
      showToast(this.t('profiles.save_required'), 'warning');
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
      showToast(this.t('profiles.select_to_delete'), 'warning');
      return;
    }

    const profile = this._findProfile(profileId);
    if (!profile) {
      this._setProfileSelection('');
      this._updateProfileActionState();
      return;
    }

    if (typeof confirm === 'function') {
      const confirmed = confirm(this.t('profiles.confirm_delete', { name: profile.name }));
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
        showToast(this.t('identity.exported_protected'), 'info');
        return;
      }

      if (typeof confirm === 'function') {
        const confirmed = confirm(this.t('identity.confirm_export_unprotected'));
        if (!confirmed) return;
      }

      this._downloadJsonFile(`openclaw-relay-${suffix}.json`, bundle);
      showToast(this.t('identity.exported_unprotected'), 'warning');
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
      showToast(this.t('identity.no_fingerprint'), 'warning');
      return;
    }

    try {
      await this._copyText(summary.fingerprint);
      showToast(this.t('identity.fingerprint_copied'), 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async copyIdentityPublicKey() {
    const summary = this.connection.getIdentitySummary();
    if (!summary.publicKey) {
      showToast(this.t('identity.no_public_key'), 'warning');
      return;
    }

    try {
      await this._copyText(summary.publicKey);
      showToast(this.t('identity.public_key_copied'), 'info');
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
        const shouldReplace = confirm(this.t('identity.confirm_import'));
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
        showToast(this.t('identity.imported_persisted'), 'info');
      } else {
        showToast(this.t('identity.imported_memory'), 'warning');
      }
    } catch (err) {
      showToast(this.t('identity.import_failed', { error: err.message }), 'error');
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
      const label = summary.fingerprint ? this._shortFingerprint(summary.fingerprint) : this.t('identity.title');
      const confirmed = confirm(this.t('identity.confirm_reset', { label }));
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
      showToast(this.t('identity.reset_success'), 'info');
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
    try {
      const result = await this.connection.sendRequest('agents.list', {});
      this.agents = result.agents || [];
    } catch (err) {
      showToast(this.t('agents.fetch_failed', { error: err.message }), 'error');
    }
  },

  _updateAgentStatus() {
    // Legacy no-op — status shown in agent selector panel
  },

  // ── Chat ──

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || this.connection.state !== 'connected') return;

    const tab = this._activeTab();
    const agent = tab?.agent || '';
    if (!agent) {
      this.openAgentSelector();
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

      assistantEntry.text = this.currentStreamText || this.t('chat.error_prefix', { error: err.message });
      assistantEntry.error = err.message;
      contentEl.innerHTML = renderMarkdown(this.currentStreamText || this.t('chat.error_prefix', { error: err.message }));
      if (!this.currentStreamText) {
        msgEl.remove();
        this.chatTranscript.pop();
        this._updateDiagnostics();
        showToast(this.t('chat.send_failed', { error: err.message }), 'error');
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

  handleInputKey(e, paneIdx = 0) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (paneIdx === 0) this.sendMessage();
      else this.sendMessageInPane(paneIdx);
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
      const suffix = this.connection.encrypted ? this.t('status.encrypted_suffix') : '';
      const fingerprint = this.connection.identityFingerprint
        ? ` · ${this._shortFingerprint(this.connection.identityFingerprint)}`
        : '';
      details.textContent = host ? host + suffix + fingerprint : `${this.t('status.secure')}${suffix}${fingerprint}`;
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
    const adminBtn = document.getElementById('adminBtn');
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
    const agentName = this._activeTab()?.agent || '';

    let relayHost = '';
    try {
      const relayUrl = this.connection.relayUrl || this._normalizeRelayUrl(document.getElementById('relayUrl').value.trim());
      relayHost = relayUrl ? new URL(relayUrl).host : '';
    } catch {}

    if (statusBarText) {
      if (this.connection.state === 'connected') {
        const parts = [relayHost ? this.t('statusbar.connected_to', { host: relayHost }) : this.t('statusbar.connected_secure')];
        parts.push(this.connection.encrypted ? this.t('statusbar.encrypted') : this.t('statusbar.security_pending'));
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
      sessionEl.textContent = this.sessionId || this.t('details.new_chat');
      sessionEl.title = this.sessionId || '';
    }
    if (clientEl) {
      clientEl.textContent = this.connection.clientId || this.t('details.pending');
      clientEl.title = this.connection.clientId || '';
    }
    if (profileEl) {
      profileEl.textContent = selectedProfile?.name || this.t('profiles.custom_unsaved');
      profileEl.title = selectedProfile?.name || '';
    }
    if (gatewayEl) {
      gatewayEl.textContent = gatewayPubKey ? this._shortKey(gatewayPubKey) : this.t('details.not_set');
      gatewayEl.title = gatewayPubKey;
    }
    if (detailSession) {
      detailSession.textContent = this.sessionId || this.t('details.new_chat');
      detailSession.title = this.sessionId || '';
    }
    if (detailClient) {
      detailClient.textContent = this.connection.clientId || this.t('details.pending');
      detailClient.title = this.connection.clientId || '';
    }
    if (detailGateway) {
      detailGateway.textContent = gatewayPubKey ? this._shortKey(gatewayPubKey) : this.t('details.not_set');
      detailGateway.title = gatewayPubKey;
    }
    if (detailProfile) {
      detailProfile.textContent = selectedProfile?.name || this.t('profiles.custom_unsaved');
      detailProfile.title = selectedProfile?.name || '';
    }
    if (detailEncryption) {
      detailEncryption.textContent = this.connection.state === 'connected'
        ? (this.connection.encrypted ? 'AES-256-GCM' : this.t('details.negotiating'))
        : '—';
    }
    if (detailIdentity) {
      if (identitySummary.persistence === 'persisted') {
        detailIdentity.textContent = this.t('details.persistent_idb');
      } else if (identitySummary.persistence === 'memory') {
        detailIdentity.textContent = this.t('details.temporary_page');
      } else if (identitySummary.persistence === 'unsupported') {
        detailIdentity.textContent = this.t('details.temporary_unavailable');
      } else {
        detailIdentity.textContent = '—';
      }
    }

    if (dashboardBtn) dashboardBtn.disabled = this.connection.state !== 'connected';
    if (adminBtn) adminBtn.disabled = this.connection.state !== 'connected';
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
      const mode = summary.persistence === 'persisted' ? this.t('identity.summary.mode_persistent') : summary.persistence === 'memory' ? this.t('identity.summary.mode_temporary') : summary.persistence;
      el.textContent = this.t('identity.summary.with_fingerprint', { fingerprint: this._shortFingerprint(summary.fingerprint), mode });
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
    metaEl.textContent = summary.createdAt ? this.t('identity.created_at', { date: this._formatIdentityCreatedAt(summary.createdAt) }) : '';

    if (summary.persistence === 'persisted') {
      modeEl.textContent = this.t('identity.mode.persistent');
      fingerprintEl.textContent = this.t('identity.fingerprint_prefix', { fingerprint: this._shortFingerprint(summary.fingerprint) });
      fingerprintEl.title = summary.fingerprint;
      return;
    }

    if (summary.persistence === 'memory') {
      modeEl.textContent = this.t('identity.mode.memory');
      fingerprintEl.textContent = summary.fingerprint
        ? this.t('identity.fingerprint_not_persisted', { fingerprint: this._shortFingerprint(summary.fingerprint) })
        : this.t('identity.temp_only');
      fingerprintEl.title = summary.fingerprint || '';
      if (!metaEl.textContent) {
        metaEl.textContent = this.t('identity.lost_on_reload');
      }
      return;
    }

    if (summary.persistence === 'unsupported') {
      modeEl.textContent = this.t('identity.mode.unsupported');
      fingerprintEl.textContent = this.t('identity.cannot_persist');
      fingerprintEl.title = '';
      if (!metaEl.textContent) {
        metaEl.textContent = this.t('identity.can_import_temp');
      }
      return;
    }

    modeEl.textContent = this.t('identity.mode.not_created');
    fingerprintEl.textContent = this.t('identity.will_create_on_connect');
    fingerprintEl.title = '';
    metaEl.textContent = this.t('identity.can_import_before_connect');
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
      throw new Error(this.t('browser.cannot_export'));
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

    throw new Error(this.t('browser.cannot_read'));
  },

  _formatIdentityCreatedAt(createdAt) {
    return createdAt || '';
  },

  _getIdentityRecoveryHint(summary) {
    if (summary.loadFailed) {
      return this.t('identity.recovery.load_failed');
    }
    if (summary.persistence === 'persisted') {
      return this.t('identity.recovery.persisted');
    }
    if (summary.persistence === 'memory') {
      return this.t('identity.recovery.memory');
    }
    if (summary.persistence === 'unsupported') {
      return this.t('identity.recovery.unsupported');
    }
    return this.t('identity.recovery.not_created');
  },

  async _copyText(text) {
    if (!text) {
      throw new Error(this.t('browser.nothing_to_copy'));
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

    throw new Error(this.t('browser.cannot_copy'));
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
    custom.textContent = this.t('profiles.custom_unsaved');
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
  },

  // ── Tab management ──

  _activeTab() {
    return this.tabs.find(t => t.id === this.activeTabId) || null;
  },

  _splitTab() {
    return this.tabs.find(t => t.id === this.splitTabId) || null;
  },

  _createTab(agentName) {
    this._tabCounter += 1;
    const tab = {
      id: `tab-${this._tabCounter}`,
      agent: agentName,
      sessionId: null,
      transcript: [],
      currentStreamEl: null,
      currentStreamText: '',
      streamEpoch: 0,
      messagesHTML: '',
    };
    this.tabs.push(tab);
    return tab;
  },

  _saveTabDOM() {
    const tab = this._activeTab();
    if (!tab) return;
    const el = document.getElementById('messages');
    if (el) tab.messagesHTML = el.innerHTML;
  },

  _restoreTabDOM(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const el = document.getElementById('messages');
    if (el) el.innerHTML = tab.messagesHTML;
  },

  switchTab(tabId) {
    if (tabId === this.activeTabId) return;
    this._saveTabDOM();
    this.activeTabId = tabId;
    this._restoreTabDOM(tabId);
    this._renderTabs();
    this._updateDiagnostics();
  },

  openNewTab(agentName) {
    this._saveTabDOM();
    const tab = this._createTab(agentName);
    this.activeTabId = tab.id;
    const messagesEl = document.getElementById('messages');
    if (messagesEl) messagesEl.innerHTML = '';
    this._renderTabs();
    this._updateDiagnostics();
  },

  closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    this.tabs[idx].streamEpoch += 1;

    if (this.splitTabId === tabId) {
      this.splitTabId = null;
      this._updateSplitView();
    }

    this.tabs.splice(idx, 1);

    if (this.activeTabId === tabId) {
      if (this.tabs.length === 0) {
        this.openNewTab('');
      } else {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.activeTabId = this.tabs[newIdx].id;
        this._restoreTabDOM(this.activeTabId);
      }
    }
    this._renderTabs();
    this._updateDiagnostics();
  },

  _renderTabs() {
    const bar = document.getElementById('tabBar');
    if (!bar) return;

    const addBtn = document.getElementById('tabAddBtn');
    bar.querySelectorAll('.tab').forEach(el => el.remove());

    for (const tab of this.tabs) {
      const el = document.createElement('div');
      el.className = 'tab';
      if (tab.id === this.activeTabId) el.classList.add('active');
      if (tab.id === this.splitTabId) el.classList.add('split-active');

      const agent = this.agents.find(a => a.name === tab.agent);
      const label = agent?.display_name || tab.agent || this.t('chat.new_tab');

      const span = document.createElement('span');
      span.textContent = label;
      span.onclick = () => this.switchTab(tab.id);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.onclick = (e) => { e.stopPropagation(); this.closeTab(tab.id); };

      el.appendChild(span);
      el.appendChild(closeBtn);

      el.addEventListener('click', (e) => {
        if (e.shiftKey && tab.id !== this.activeTabId) {
          e.preventDefault();
          this.toggleSplit(tab.id);
        }
      });

      bar.insertBefore(el, addBtn);
    }
  },

  // ── Split view ──

  toggleSplit(tabId) {
    if (this.splitTabId === tabId) {
      this.splitTabId = null;
    } else {
      this.splitTabId = tabId;
    }
    this._updateSplitView();
    this._renderTabs();
  },

  _updateSplitView() {
    const content = document.getElementById('chatContent');
    const pane0 = document.getElementById('chatPane0');
    if (!content || !pane0) return;

    let pane1 = document.getElementById('chatPane1');

    if (this.splitTabId) {
      if (!pane1) {
        pane1 = document.createElement('div');
        pane1.id = 'chatPane1';
        pane1.className = 'chat-pane';
        pane1.innerHTML = `
          <div class="messages" id="messages1"></div>
          <div class="input-area">
            <div class="input-row">
              <textarea id="messageInput1" placeholder="${this._escapeHtml(this.t('chat.input_placeholder'))}" rows="1"
                onkeydown="app.handleInputKey(event, 1)"
                oninput="app.autoResize(this)"></textarea>
              <button class="send-btn" id="sendBtn1" onclick="app.sendMessageInPane(1)">${this._escapeHtml(this.t('chat.send_button'))}</button>
            </div>
          </div>`;
        content.appendChild(pane1);
      }
      const splitTab = this._splitTab();
      if (splitTab) {
        const m1 = document.getElementById('messages1');
        if (m1) m1.innerHTML = splitTab.messagesHTML;
      }
      const btn1 = document.getElementById('sendBtn1');
      if (btn1) btn1.disabled = this.connection.state !== 'connected';
    } else {
      if (pane1) pane1.remove();
    }
  },

  async sendMessageInPane(paneIdx) {
    if (paneIdx === 0) return this.sendMessage();

    const inputEl = document.getElementById('messageInput1');
    const messagesEl = document.getElementById('messages1');
    const sendBtnEl = document.getElementById('sendBtn1');
    const splitTab = this._splitTab();

    if (!inputEl || !messagesEl || !splitTab) return;
    const text = inputEl.value.trim();
    if (!text || this.connection.state !== 'connected') return;

    const agent = splitTab.agent || '';
    if (!agent) {
      this.openAgentSelector();
      return;
    }

    // Add user message
    splitTab.transcript.push({ role: 'user', text, createdAt: new Date().toISOString() });
    const userEl = document.createElement('div');
    userEl.className = 'message user';
    userEl.innerHTML = `<div class="msg-content">${renderMarkdown(text)}</div>`;
    messagesEl.appendChild(userEl);

    inputEl.value = '';
    inputEl.style.height = 'auto';
    if (sendBtnEl) sendBtnEl.disabled = true;

    // Create assistant message
    const assistantEntry = { role: 'assistant', text: '', agentName: agent, createdAt: new Date().toISOString() };
    splitTab.transcript.push(assistantEntry);
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant';
    msgEl.innerHTML = `<div class="agent-name">${this._escapeHtml(agent)}</div><div class="msg-content"></div>`;
    messagesEl.appendChild(msgEl);
    const contentEl = msgEl.querySelector('.msg-content');

    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    contentEl.appendChild(cursor);
    const streamEpoch = splitTab.streamEpoch;
    let streamText = '';

    try {
      const result = await this.connection.sendStreamRequest(
        'chat.send',
        { agent, message: text, session_id: splitTab.sessionId, stream: true },
        (chunk) => {
          if (splitTab.streamEpoch !== streamEpoch) return;
          if (chunk?.delta) {
            streamText += chunk.delta;
            assistantEntry.text = streamText;
            contentEl.innerHTML = renderMarkdown(streamText);
            const c = document.createElement('span');
            c.className = 'cursor';
            contentEl.appendChild(c);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          if (chunk?.session_id) {
            splitTab.sessionId = chunk.session_id;
          }
        }
      );

      if (splitTab.streamEpoch !== streamEpoch) return;
      if (result?.session_id) splitTab.sessionId = result.session_id;
      assistantEntry.text = streamText;
      contentEl.innerHTML = renderMarkdown(streamText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      if (splitTab.streamEpoch !== streamEpoch) return;
      contentEl.innerHTML = renderMarkdown(streamText || this.t('chat.error_prefix', { error: err.message }));
    } finally {
      if (sendBtnEl) sendBtnEl.disabled = this.connection.state !== 'connected';
    }
  },

  // ── Agent selector ──

  openAgentSelector() {
    const overlay = document.getElementById('agentSelectorOverlay');
    if (!overlay) return;
    overlay.hidden = false;
    this._renderAgentSelector('');
    const input = document.getElementById('agentSearchInput');
    if (input) { input.value = ''; input.focus(); }
  },

  closeAgentSelector() {
    const overlay = document.getElementById('agentSelectorOverlay');
    if (overlay) overlay.hidden = true;
  },

  filterAgentSelector(query) {
    this._renderAgentSelector(query);
  },

  _renderAgentSelector(query) {
    const list = document.getElementById('agentSelectorList');
    if (!list) return;

    const q = (query || '').toLowerCase();
    const filtered = this.agents.filter(a =>
      !q || a.name.toLowerCase().includes(q) || (a.display_name || '').toLowerCase().includes(q)
    );

    // Group by group field
    const groups = {};
    for (const agent of filtered) {
      const g = agent.group || this.t('agents.ungrouped');
      (groups[g] ??= []).push(agent);
    }

    let html = '';
    for (const [groupName, groupAgents] of Object.entries(groups)) {
      html += `<div class="agent-group-header" onclick="this.classList.toggle('collapsed'); this.nextElementSibling.hidden = !this.nextElementSibling.hidden">
        <span class="agent-group-arrow">▾</span> ${this._escapeHtml(groupName)}
      </div>`;
      html += `<div class="agent-group-items">`;
      for (const agent of groupAgents) {
        const label = agent.display_name
          ? `${agent.display_name} (${agent.name})`
          : agent.name;
        html += `<div class="agent-option" onclick="app.selectAgentFromSelector('${this._escapeHtml(agent.name)}')">
          <span>${this._escapeHtml(label)}</span>
          <span class="agent-option-status">${this._escapeHtml(agent.status || '')}</span>
        </div>`;
      }
      html += `</div>`;
    }

    if (!html) {
      html = `<div style="padding:20px;text-align:center;color:var(--muted)">${this._escapeHtml(this.t('agents.no_agents'))}</div>`;
    }

    list.innerHTML = html;
  },

  selectAgentFromSelector(agentName) {
    this.closeAgentSelector();

    // If active tab has no agent yet, assign to it
    const tab = this._activeTab();
    if (tab && !tab.agent) {
      tab.agent = agentName;
      this._renderTabs();
      this._updateDiagnostics();
      return;
    }

    // Otherwise open a new tab
    this.openNewTab(agentName);
  }
};

// Expose to global scope for inline event handlers in HTML
window.app = app;

// Boot
document.addEventListener('DOMContentLoaded', () => { void app.init(); });
