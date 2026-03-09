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

  async init() {
    const usedPairingFragment = this._applyPairingFragment();

    // Migration: clean up any historically saved channelToken (bearer secret)
    const saved = this._loadSettings();
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

    await this.connection.hydratePersistedIdentity();
    this._updateIdentityStatus();
    this._updateDiagnostics();
  },

  _applyPairingFragment() {
    const hash = globalThis.location?.hash;
    if (!hash || hash.length < 2) return false;

    const params = new URLSearchParams(hash.slice(1));
    const relay = params.get('relay');
    const token = params.get('token');
    const key = params.get('key');

    if (!relay && !token && !key) return false;

    if (relay) document.getElementById('relayUrl').value = relay;
    if (token) document.getElementById('channelToken').value = token;
    if (key) document.getElementById('gatewayPubKey').value = key;

    const cleanUrl = `${globalThis.location.origin}${globalThis.location.pathname}`;
    globalThis.history?.replaceState?.(null, '', cleanUrl);
    return true;
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

    const relayUrl = document.getElementById('relayUrl').value.trim();
    const channelToken = document.getElementById('channelToken').value.trim();
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim();

    // Validate
    if (!relayUrl || !channelToken || !gatewayPubKey) {
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

      // Fetch agent list
      await this._fetchAgents();

      // Add system message
      this._addSystemMessage('Connected securely to your OpenClaw.');
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
      showToast('Connect before starting a new chat.', 'warning');
      return;
    }

    this.streamEpoch += 1;
    document.getElementById('messages').innerHTML = '';
    this.chatTranscript = [];
    this.sessionId = null;
    this.currentStreamEl = null;
    this.currentStreamText = '';
    this._addSystemMessage('Started a new chat thread.');
    this._updateDiagnostics();
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
    showToast(existingId ? 'Profile updated.' : 'Profile saved.', 'info');
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
    showToast('Profile deleted.', 'info');
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
      showToast('Failed to fetch agents: ' + err.message, 'error');
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
      showToast('Please select an agent', 'warning');
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
      const label = visible ? 'Hide access token' : 'Show access token';
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
      disconnected: 'Not connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      connected: 'Connected',
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
        const parts = [relayHost ? `Connected to ${relayHost}` : 'Connected securely'];
        parts.push(this.connection.encrypted ? 'Encrypted' : 'Security pending');
        if (agentName) parts.push(agentName);
        statusBarText.textContent = parts.join(' · ');
      } else if (this.connection.state === 'connecting') {
        statusBarText.textContent = 'Connecting…';
      } else if (this.connection.state === 'reconnecting') {
        statusBarText.textContent = 'Reconnecting…';
      } else {
        statusBarText.textContent = 'Not connected';
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

    if (newChatBtn) newChatBtn.disabled = this.connection.state !== 'connected';
    if (exportChatBtn) exportChatBtn.disabled = this.chatTranscript.length === 0;
  },

  _updateIdentitySummary() {
    const el = document.getElementById('identitySummaryText');
    const banner = document.getElementById('identityErrorBanner');
    if (!el) return;

    const summary = this.connection.getIdentitySummary();

    if (summary.loadFailed) {
      el.textContent = 'Browser identity: load failed';
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
      el.textContent = 'Browser identity: persistence unavailable';
      return;
    }

    el.textContent = 'Browser identity: not created yet';
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
      modeEl.textContent = 'Persistent browser identity';
      fingerprintEl.textContent = `Fingerprint: ${this._shortFingerprint(summary.fingerprint)}`;
      fingerprintEl.title = summary.fingerprint;
      return;
    }

    if (summary.persistence === 'memory') {
      modeEl.textContent = 'Temporary page identity';
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
      modeEl.textContent = 'Persistence unavailable';
      fingerprintEl.textContent = 'This browser cannot persist the client identity; a new key will be created after every reload.';
      fingerprintEl.title = '';
      if (!metaEl.textContent) {
        metaEl.textContent = 'You can still import an identity file for the current page session.';
      }
      return;
    }

    modeEl.textContent = 'Not created yet';
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
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
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
