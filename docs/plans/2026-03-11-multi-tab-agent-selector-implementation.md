# Multi-Tab Chat + Hierarchical Agent Selector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace single-agent flat dropdown with tabbed multi-agent chat and grouped agent selector.

**Architecture:** Tab bar replaces `.agent-bar`. Each tab holds independent chat state (agent, sessionId, transcript, stream). Custom popup panel with collapsible groups replaces native `<select>`. Backend adds `group` field to `agents.list`. Split view via CSS flexbox.

**Tech Stack:** Vanilla JS (ES modules), inline CSS in index.html, Vitest for tests.

---

### Task 1: Backend — Add `group` field to agent type

**Files:**
- Modify: `plugin/src/types.ts`
- Modify: `plugin/src/handlers/agents.ts`

**Step 1: Add `group` to the TypeScript type**

In `plugin/src/types.ts`, find the agent-related interface returned by `agentsList()`. Add:

```typescript
group?: string;
```

**Step 2: Pass through `group` in the handler**

In `plugin/src/handlers/agents.ts`, ensure the `group` field is included when mapping agent data to the response. The Go relay passes JSON fields transparently, so no Go changes needed.

**Step 3: Commit**

```bash
git add plugin/src/types.ts plugin/src/handlers/agents.ts
git commit -m "feat(plugin): add group field to agents.list response"
```

---

### Task 2: CSS — Tab bar and agent selector styles

**Files:**
- Modify: `client/index.html` (CSS section, lines 721-751)

**Step 1: Replace `.agent-bar` CSS with tab bar styles**

Replace the existing `.agent-bar` block (lines 721-751) with:

```css
/* ── Tab bar ─────────────────────────────────── */

.tab-bar {
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  overflow-x: auto;
  gap: 2px;
  min-height: 40px;
}

.tab-bar::-webkit-scrollbar { height: 0; }

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover { color: var(--text); }

.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.tab.split-active {
  color: var(--text);
  border-bottom-color: var(--warning);
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  border: none;
  background: none;
  padding: 0;
}

.tab-close:hover { background: rgba(255,255,255,0.1); color: var(--text); }

.tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 16px;
  color: var(--muted);
  cursor: pointer;
  border: none;
  background: none;
  flex-shrink: 0;
}

.tab-add:hover { background: rgba(255,255,255,0.08); color: var(--text); }
```

**Step 2: Add agent selector panel CSS**

Append after the tab bar styles:

```css
/* ── Agent selector panel ────────────────────── */

.agent-selector-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 80px;
}

.agent-selector-overlay[hidden] { display: none; }

.agent-selector {
  width: min(420px, 90%);
  max-height: min(60vh, 500px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.35);
}

.agent-selector-search {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.agent-selector-search input {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.agent-selector-search input:focus { border-color: var(--accent); }

.agent-selector-list {
  overflow-y: auto;
  padding: 6px 0;
}

.agent-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.agent-group-header:hover { color: var(--text); }

.agent-group-arrow {
  font-size: 10px;
  transition: transform 0.15s;
}

.agent-group-header.collapsed .agent-group-arrow {
  transform: rotate(-90deg);
}

.agent-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 8px 28px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}

.agent-option:hover { background: rgba(255,255,255,0.05); }

.agent-option-status {
  font-size: 11px;
  color: var(--muted);
}
```

**Step 3: Add split view CSS**

Append:

```css
/* ── Split view ──────────────────────────────── */

.chat-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.chat-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.chat-pane + .chat-pane {
  border-left: 1px solid var(--border);
}
```

**Step 4: Run tests to verify nothing broke**

```bash
cd client && npx vitest run
```
Expected: All 74 tests pass (CSS-only change).

**Step 5: Commit**

```bash
git add client/index.html
git commit -m "feat(web-client): add CSS for tab bar, agent selector, and split view"
```

---

### Task 3: HTML — Replace agent-bar with tab bar and selector panel

**Files:**
- Modify: `client/index.html` (lines 1128-1134 agent-bar, and add selector panel)

**Step 1: Replace the `.agent-bar` div**

Replace lines 1128-1134:

```html
<div class="agent-bar">
  <label for="agentSelect" data-i18n="agent.label">Agent</label>
  <select id="agentSelect">
    <option value="" data-i18n="agents.loading">正在加载 Agent…</option>
  </select>
  <span class="agent-status" id="agentStatus"></span>
</div>
```

With:

```html
<div class="tab-bar" id="tabBar">
  <button class="tab-add" id="tabAddBtn" onclick="app.openAgentSelector()" title="新建对话">+</button>
</div>
```

**Step 2: Wrap `#messages` and `.input-area` in chat-content/chat-pane structure**

Replace:
```html
<div class="messages" id="messages"></div>

<div class="input-area">
```

With:
```html
<div class="chat-content" id="chatContent">
  <div class="chat-pane" id="chatPane0">
    <div class="messages" id="messages"></div>
    <div class="input-area">
```

And close the new wrappers after the input-area's closing `</div>`:
```html
    </div><!-- /input-area -->
  </div><!-- /chat-pane -->
</div><!-- /chat-content -->
```

**Step 3: Add the agent selector overlay**

Before the `</div><!-- /chatPanel -->` closing tag, add:

```html
<div class="agent-selector-overlay" id="agentSelectorOverlay" hidden>
  <div class="agent-selector">
    <div class="agent-selector-search">
      <input type="text" id="agentSearchInput" placeholder="搜索 agent..." oninput="app.filterAgentSelector(this.value)">
    </div>
    <div class="agent-selector-list" id="agentSelectorList"></div>
  </div>
</div>
```

**Step 4: Commit**

```bash
git add client/index.html
git commit -m "feat(web-client): HTML structure for tab bar, chat panes, agent selector"
```

---

### Task 4: Tab state management in app.js

**Files:**
- Modify: `client/js/app.js` (lines 411-426 properties, lines 867-884 startNewChat, lines 1206-1212 handleAgentSelectChange, lines 1469-1515 _fetchAgents/_updateAgentStatus)

**Step 1: Add tab state properties**

Replace the existing properties at lines 412-426:

```javascript
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
```

With:

```javascript
export const app = {
  language: 'zh',
  connection: new RelayConnection(),
  agents: [],
  profiles: [],
  selectedAgentPreference: '',

  // Tab state
  tabs: [],
  activeTabId: null,
  splitTabId: null,
  _tabCounter: 0,

  // Legacy accessors (computed from active tab)
  get chatTranscript() { const t = this._activeTab(); return t ? t.transcript : []; },
  set chatTranscript(v) { const t = this._activeTab(); if (t) t.transcript = v; },
  get sessionId() { const t = this._activeTab(); return t ? t.sessionId : null; },
  set sessionId(v) { const t = this._activeTab(); if (t) t.sessionId = v; },
  get currentStreamEl() { const t = this._activeTab(); return t ? t.currentStreamEl : null; },
  set currentStreamEl(v) { const t = this._activeTab(); if (t) t.currentStreamEl = v; },
  get currentStreamText() { const t = this._activeTab(); return t ? t.currentStreamText : ''; },
  set currentStreamText(v) { const t = this._activeTab(); if (t) t.currentStreamText = v; },
  get streamEpoch() { const t = this._activeTab(); return t ? t.streamEpoch : 0; },
  set streamEpoch(v) { const t = this._activeTab(); if (t) t.streamEpoch = v; },
```

**Step 2: Add tab helper methods**

Add these methods to the app object (after `_shortFingerprint`, before the closing `};`):

```javascript
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
    document.getElementById('messages').innerHTML = '';
    this._addSystemMessage(this.t('chat.new_thread'));
    this._renderTabs();
    this._updateDiagnostics();
  },

  closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    // Cancel streams for closing tab
    if (this.tabs[idx].agent) {
      this.tabs[idx].streamEpoch += 1;
    }

    // If closing split tab
    if (this.splitTabId === tabId) {
      this.splitTabId = null;
      this._updateSplitView();
    }

    this.tabs.splice(idx, 1);

    // If closing active tab, switch to neighbor
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
    // Remove all tabs (keep the + button)
    bar.querySelectorAll('.tab').forEach(el => el.remove());

    for (const tab of this.tabs) {
      const el = document.createElement('div');
      el.className = 'tab';
      if (tab.id === this.activeTabId) el.classList.add('active');
      if (tab.id === this.splitTabId) el.classList.add('split-active');

      const agent = this.agents.find(a => a.name === tab.agent);
      const label = agent?.display_name || tab.agent || this.t('chat.new_tab');

      el.innerHTML = `
        <span onclick="app.switchTab('${tab.id}')">${this._escapeHtml(label)}</span>
        <button class="tab-close" onclick="event.stopPropagation(); app.closeTab('${tab.id}')">&times;</button>
      `;
      el.addEventListener('click', (e) => {
        if (e.shiftKey && tab.id !== this.activeTabId) {
          e.preventDefault();
          this.toggleSplit(tab.id);
        } else if (!e.target.closest('.tab-close')) {
          this.switchTab(tab.id);
        }
      });
      bar.insertBefore(el, addBtn);
    }
  },
```

**Step 3: Update `startNewChat()` to work with tabs**

Replace `startNewChat()` (lines 867-884):

```javascript
  startNewChat() {
    if (this.connection.state !== 'connected') {
      showToast(this.t('chat.connect_first'), 'warning');
      return;
    }

    const tab = this._activeTab();
    if (!tab) return;

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
```

**Step 4: Remove old `handleAgentSelectChange()`**

Replace `handleAgentSelectChange()` (lines 1206-1212) with a no-op or remove it. The agent is now determined by the tab, not a select element.

```javascript
  handleAgentSelectChange() {
    // Legacy no-op — agent selection is now per-tab via agent selector
  },
```

**Step 5: Update `sendMessage()` to read agent from tab**

In `sendMessage()` (line 1524), replace:

```javascript
    const agent = document.getElementById('agentSelect').value;
    if (!agent) {
      showToast(this.t('agents.select_required'), 'warning');
      return;
    }
```

With:

```javascript
    const tab = this._activeTab();
    const agent = tab?.agent || '';
    if (!agent) {
      this.openAgentSelector();
      return;
    }
```

**Step 6: Update `handleConnect()` to create initial tab**

In `handleConnect()` (around line 812, after `_fetchAgents()`), add:

```javascript
    // Create initial tab if none exist
    if (this.tabs.length === 0) {
      const preferred = this.selectedAgentPreference || (this.agents[0]?.name ?? '');
      this.openNewTab(preferred);
    }
```

**Step 7: Update `_fetchAgents()` to not use `<select>`**

Replace the `_fetchAgents()` method (lines 1469-1501):

```javascript
  async _fetchAgents() {
    try {
      const result = await this.connection.sendRequest('agents.list', {});
      this.agents = result.agents || [];
    } catch (err) {
      showToast(this.t('agents.fetch_failed', { error: err.message }), 'error');
    }
  },
```

**Step 8: Remove `_updateAgentStatus()` and `_resolveAvailableAgent()`**

These depended on the `<select>` element. Remove or stub them:

```javascript
  _updateAgentStatus() {
    // Legacy no-op — status shown in tab bar / agent selector
  },

  _resolveAvailableAgent(preference) {
    if (this.agents.find(a => a.name === preference)) return preference;
    return this.agents[0]?.name || '';
  },
```

**Step 9: Run tests**

```bash
cd client && npx vitest run
```

Some tests will fail because they reference `agentSelect` element. Fix these in the next task.

**Step 10: Commit**

```bash
git add client/js/app.js
git commit -m "feat(web-client): tab state management and multi-tab chat logic"
```

---

### Task 5: Agent selector panel logic

**Files:**
- Modify: `client/js/app.js`

**Step 1: Add agent selector methods**

Add to the app object:

```javascript
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
    for (const [groupName, agents] of Object.entries(groups)) {
      html += `<div class="agent-group-header" onclick="this.classList.toggle('collapsed'); this.nextElementSibling.hidden = !this.nextElementSibling.hidden">
        <span class="agent-group-arrow">▾</span> ${this._escapeHtml(groupName)}
      </div>`;
      html += `<div class="agent-group-items">`;
      for (const agent of agents) {
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
      return;
    }

    // Otherwise open a new tab
    this.openNewTab(agentName);
  },
```

**Step 2: Close selector when clicking overlay background**

Add an onclick to the overlay in index.html:

```html
<div class="agent-selector-overlay" id="agentSelectorOverlay" hidden onclick="if(event.target===this) app.closeAgentSelector()">
```

**Step 3: Add Escape key to close selector**

In `init()`, add a keydown listener:

```javascript
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeAgentSelector();
      }
    });
```

**Step 4: Add i18n keys**

Add to `UI_STRINGS.zh`:
```javascript
'agents.ungrouped': '未分组',
'chat.new_tab': '新对话',
```

Add to `UI_STRINGS.en`:
```javascript
'agents.ungrouped': 'Ungrouped',
'chat.new_tab': 'New Chat',
```

**Step 5: Commit**

```bash
git add client/js/app.js client/index.html
git commit -m "feat(web-client): grouped agent selector panel with search"
```

---

### Task 6: Split view

**Files:**
- Modify: `client/js/app.js`
- Modify: `client/index.html`

**Step 1: Add split view methods to app.js**

```javascript
  toggleSplit(tabId) {
    if (this.splitTabId === tabId) {
      // Unsplit
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
              <button class="send-btn" id="sendBtn1" onclick="app.sendMessage(1)" disabled>${this._escapeHtml(this.t('chat.send_button'))}</button>
            </div>
          </div>`;
        content.appendChild(pane1);
      }
      // Restore split tab DOM
      const splitTab = this._splitTab();
      if (splitTab) {
        document.getElementById('messages1').innerHTML = splitTab.messagesHTML;
      }
      // Enable send button if connected
      const btn1 = document.getElementById('sendBtn1');
      if (btn1) btn1.disabled = this.connection.state !== 'connected';
    } else {
      if (pane1) pane1.remove();
    }
  },
```

**Step 2: Update `sendMessage()` to support pane index**

Change the signature and DOM references:

```javascript
  async sendMessage(paneIdx = 0) {
    const inputId = paneIdx === 0 ? 'messageInput' : 'messageInput1';
    const messagesId = paneIdx === 0 ? 'messages' : 'messages1';
    const sendBtnId = paneIdx === 0 ? 'sendBtn' : 'sendBtn1';
    const tabId = paneIdx === 0 ? this.activeTabId : this.splitTabId;
    const tab = this.tabs.find(t => t.id === tabId);

    const input = document.getElementById(inputId);
    const text = input.value.trim();
    if (!text || this.connection.state !== 'connected') return;

    const agent = tab?.agent || '';
    if (!agent) {
      this.openAgentSelector();
      return;
    }
    // ... rest of sendMessage uses tab instead of this.sessionId etc.
    // and messagesId for DOM lookups
```

(This is the most complex refactor — `sendMessage`, `_addMessage`, and stream handling must be parameterized by pane/tab.)

**Step 3: Commit**

```bash
git add client/js/app.js client/index.html
git commit -m "feat(web-client): split view with Shift+click tab"
```

---

### Task 7: Fix tests

**Files:**
- Modify: `client/tests/app.test.js`

**Step 1: Update test setup**

In `beforeEach`, replace:
```javascript
app.chatTranscript = [];
app.streamEpoch = 0;
```

With:
```javascript
app.tabs = [];
app.activeTabId = null;
app.splitTabId = null;
app._tabCounter = 0;
```

**Step 2: Add helper to create a tab for tests that need one**

```javascript
function setupActiveTab(agentName = 'demo') {
  app.tabs = [{
    id: 'tab-test',
    agent: agentName,
    sessionId: null,
    transcript: [],
    currentStreamEl: null,
    currentStreamText: '',
    streamEpoch: 0,
    messagesHTML: '',
  }];
  app.activeTabId = 'tab-test';
}
```

**Step 3: Update tests that reference `agentSelect`**

Replace `getElement('agentSelect').value = 'analyst'` patterns with `setupActiveTab('analyst')`.

**Step 4: Run tests**

```bash
cd client && npx vitest run
```

Expected: All tests pass.

**Step 5: Add new tests for tab management**

```javascript
describe('tab management', () => {
  it('creates a new tab with agent', () => {
    app.agents = [{ name: 'diting', display_name: '谛听', group: '西游记' }];
    app.openNewTab('diting');
    expect(app.tabs).toHaveLength(1);
    expect(app.activeTabId).toBe(app.tabs[0].id);
    expect(app.tabs[0].agent).toBe('diting');
  });

  it('switches between tabs preserving state', () => {
    app.openNewTab('agent1');
    app.chatTranscript = [{ role: 'user', text: 'hello' }];
    app.openNewTab('agent2');
    expect(app.chatTranscript).toHaveLength(0);
    app.switchTab(app.tabs[0].id);
    expect(app.chatTranscript).toHaveLength(1);
  });

  it('closes tab and switches to neighbor', () => {
    app.openNewTab('agent1');
    app.openNewTab('agent2');
    const firstId = app.tabs[0].id;
    app.closeTab(app.tabs[1].id);
    expect(app.tabs).toHaveLength(1);
    expect(app.activeTabId).toBe(firstId);
  });
});

describe('agent selector grouping', () => {
  it('groups agents by group field', () => {
    app.agents = [
      { name: 'diting', display_name: '谛听', group: '西游记', status: 'idle' },
      { name: 'ins-daiyu', display_name: '黛玉', group: '红楼梦', status: 'idle' },
      { name: 'ins-baoyu', display_name: '宝玉', group: '红楼梦', status: 'idle' },
    ];
    app._renderAgentSelector('');
    const list = getElement('agentSelectorList');
    expect(list.innerHTML).toContain('西游记');
    expect(list.innerHTML).toContain('红楼梦');
  });

  it('filters agents by search query', () => {
    app.agents = [
      { name: 'diting', display_name: '谛听', group: '西游记' },
      { name: 'ins-daiyu', display_name: '黛玉', group: '红楼梦' },
    ];
    app._renderAgentSelector('黛玉');
    const list = getElement('agentSelectorList');
    expect(list.innerHTML).toContain('黛玉');
    expect(list.innerHTML).not.toContain('谛听');
  });
});
```

**Step 6: Run tests**

```bash
cd client && npx vitest run
```

Expected: All tests pass.

**Step 7: Commit**

```bash
git add client/tests/app.test.js
git commit -m "test(web-client): update tests for tab management and agent selector"
```

---

### Task 8: Deploy to Mac Mini

**Step 1: Sync files**

```bash
rsync -avz --delete /Users/wangyan/openclaw-relay/client/ wangyan@192.168.50.8:~/openclaw-relay/client/
```

**Step 2: Rebuild and restart Docker**

```bash
ssh wangyan@192.168.50.8 "cd ~/openclaw-relay && ~/.orbstack/bin/docker compose build --no-cache && ~/.orbstack/bin/docker compose up -d"
```

**Step 3: Verify**

Open `https://relay.wanghui.cc` in browser. Connect and verify:
- Tab bar shows with `+` button
- Clicking `+` opens grouped agent selector
- Selecting agent creates a new tab
- Can switch between tabs
- Shift+click a tab enters split view
- Close button on tabs works

**Step 4: Commit version bump for cache busting**

Update the `?v=` param in index.html script tag:
```html
<script type="module" src="js/app.js?v=20260311b"></script>
```

```bash
git add client/index.html
git commit -m "chore(web-client): bump cache version for multi-tab deploy"
```
