/**
 * Application layer: UI state management, DOM interaction, settings.
 *
 * This is the entry point for the browser client. It wires the transport
 * layer to the DOM and handles user interactions.
 */

import { renderMarkdown } from './markdown.js';
import { RelayConnection } from './transport.js';

// ── Storage keys ──
const STORAGE_KEY_SETTINGS = 'openclaw-relay-settings';
const STORAGE_KEY_CLIENT_ID = 'openclaw-relay-client-id';

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
  sessionId: null,
  currentStreamEl: null,
  currentStreamText: '',

  async init() {
    // Migration: clean up any historically saved channelToken (bearer secret)
    const saved = this._loadSettings();
    if (saved.channelToken) {
      delete saved.channelToken;
      try {
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(saved));
      } catch {}
    }

    // Restore safe settings
    if (saved.relayUrl) document.getElementById('relayUrl').value = saved.relayUrl;
    // channelToken is never persisted — user must enter each session
    if (saved.gatewayPubKey) document.getElementById('gatewayPubKey').value = saved.gatewayPubKey;

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

    await this.connection.hydratePersistedIdentity();
    this._updateIdentityStatus();
  },

  // ── Connection ──

  async handleConnect(e) {
    e.preventDefault();

    const relayUrl = document.getElementById('relayUrl').value.trim();
    const channelToken = document.getElementById('channelToken').value.trim();
    const gatewayPubKey = document.getElementById('gatewayPubKey').value.trim();

    // Validate
    if (!relayUrl || !channelToken || !gatewayPubKey) return false;

    // Ensure URL ends with /ws if it doesn't already
    let url = relayUrl;
    if (!url.includes('/ws')) {
      url = url.replace(/\/$/, '') + '/ws';
    }

    // Save settings (channelToken is stripped by _saveSettings)
    this._saveSettings({ relayUrl: url, channelToken, gatewayPubKey });

    const btn = document.getElementById('connectBtn');
    const errorEl = document.getElementById('connectError');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    errorEl.style.display = 'none';

    try {
      await this.connection.connect(url, channelToken, gatewayPubKey);
      this._updateIdentityStatus();

      // Switch to chat view
      document.getElementById('connectPanel').style.display = 'none';
      document.getElementById('chatPanel').classList.add('active');
      document.getElementById('disconnectBtn').style.display = '';

      // Fetch agent list
      await this._fetchAgents();

      // Add system message
      this._addSystemMessage('Connected. End-to-end encryption active.');

      // Focus input
      document.getElementById('messageInput').focus();

    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
      this._updateIdentityStatus();
    }

    return false;
  },

  disconnect() {
    this.connection.disconnect();

    this._returnToConnectView();
    this._updateIdentityStatus();
  },

  async resetIdentity() {
    const btn = document.getElementById('resetIdentityBtn');
    btn.disabled = true;

    try {
      await this.connection.resetIdentity();
      this._returnToConnectView();
      document.getElementById('connectError').style.display = 'none';
      this._updateIdentityStatus();
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

    // Clear messages
    document.getElementById('messages').innerHTML = '';
    this.sessionId = null;
    this.agents = [];
  },

  // ── Agents ──

  async _fetchAgents() {
    const select = document.getElementById('agentSelect');
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

      this._updateAgentStatus();
      select.addEventListener('change', () => this._updateAgentStatus());
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
    this._addMessage('user', text);

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('sendBtn').disabled = true;

    // Create streaming message element
    const msgEl = this._addMessage('assistant', '', agent);
    const contentEl = msgEl.querySelector('.msg-content');
    this.currentStreamEl = contentEl;
    this.currentStreamText = '';

    // Add cursor
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    contentEl.appendChild(cursor);

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
          // Handle stream chunk
          if (chunk && chunk.delta) {
            this.currentStreamText += chunk.delta;
            contentEl.innerHTML = renderMarkdown(this.currentStreamText);
            // Re-add cursor during streaming
            const c = document.createElement('span');
            c.className = 'cursor';
            contentEl.appendChild(c);
            this._scrollToBottom();
          }
          if (chunk && chunk.session_id) {
            this.sessionId = chunk.session_id;
          }
        }
      );

      // Stream complete: remove cursor and do final render
      if (result && result.session_id) {
        this.sessionId = result.session_id;
      }
      contentEl.innerHTML = renderMarkdown(this.currentStreamText);
      this._scrollToBottom();

    } catch (err) {
      contentEl.innerHTML = renderMarkdown(this.currentStreamText || '(Error: ' + err.message + ')');
      if (!this.currentStreamText) {
        msgEl.remove();
        showToast('Failed to send: ' + err.message, 'error');
      }
    } finally {
      this.currentStreamEl = null;
      this.currentStreamText = '';
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
    const container = document.getElementById('messages');
    const el = document.createElement('div');
    el.className = 'message system';
    el.textContent = text;
    container.appendChild(el);
    this._scrollToBottom();
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

    dot.className = 'status-dot ' + (state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : '');

    const labels = {
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      connected: 'Connected'
    };
    text.textContent = labels[state] || state;

    if (state === 'connected') {
      const url = new URL(this.connection.relayUrl);
      const suffix = this.connection.encrypted ? ' (encrypted)' : '';
      const fingerprint = this.connection.identityFingerprint
        ? ` · ${this._shortFingerprint(this.connection.identityFingerprint)}`
        : '';
      details.textContent = url.host + suffix + fingerprint;
      document.getElementById('sendBtn').disabled = !document.getElementById('messageInput').value.trim();
    } else {
      details.textContent = '';
      document.getElementById('sendBtn').disabled = true;
    }
  },

  _updateIdentityStatus() {
    const modeEl = document.getElementById('identityMode');
    const fingerprintEl = document.getElementById('identityFingerprint');
    const resetBtn = document.getElementById('resetIdentityBtn');
    const summary = this.connection.getIdentitySummary();

    resetBtn.disabled = !summary.canReset;

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
      return;
    }

    if (summary.persistence === 'unsupported') {
      modeEl.textContent = 'Persistence unavailable';
      fingerprintEl.textContent = 'This browser cannot persist the client identity; a new key will be created after every reload.';
      fingerprintEl.title = '';
      return;
    }

    modeEl.textContent = 'Not created yet';
    fingerprintEl.textContent = 'A stable client identity will be created on first connect and saved in this browser.';
    fingerprintEl.title = '';
  },

  // ── Settings persistence ──

  _saveSettings(settings) {
    try {
      // Never persist channelToken — it's a bearer secret
      const { channelToken, ...safe } = settings;
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(safe));
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
