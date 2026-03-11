# Web Client UX Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the "pairing 三个参数不知道怎么填" 痛点，同时重构 connect panel 为 L0/L1/L2 信息层级，用干净的状态栏替换现有的裸诊断栏。

**Architecture:** 跨 client + plugin 改动。Phase 0 涉及 plugin CLI（`--open-web` / `--print-web-url`）和 client 的 URL fragment 解析。Phase 1–3 是纯 client 前端改动（`index.html` + `app.js`）。不改 transport、crypto、identity-store。

**Tech Stack:** Vanilla HTML/CSS/JS (ES modules), Vitest, plugin 侧 TypeScript.

**Pairing URI 格式（已有）：** `openclaw-relay://<host>/<channelToken>#<publicKey>`

---

## Phase 0: Pairing Handoff

解决核心痛点：用户第一次 pairing 时不知道三个参数怎么填。

### Task 1: Client — 从 URL Fragment 读取 Pairing 参数

**Files:**
- Modify: `client/js/app.js`
- Modify: `client/tests/app.test.js`

**Step 1: 写失败测试**

在 `client/tests/app.test.js` 末尾添加：

```javascript
describe('pairing handoff via URL fragment', () => {
  it('auto-fills form fields from URL fragment and clears fragment', async () => {
    const fragment = '#relay=wss%3A%2F%2Frelay.example.com%2Fws&token=test-token-123&key=BASE64PUBKEY';
    delete globalThis.location;
    globalThis.location = {
      hash: fragment,
      href: `http://localhost${fragment}`,
      origin: 'http://localhost',
      pathname: '/',
    };
    const replaceStateSpy = vi.fn();
    globalThis.history = { replaceState: replaceStateSpy };

    app._applyPairingFragment();

    expect(getElement('relayUrl').value).toBe('wss://relay.example.com/ws');
    expect(getElement('channelToken').value).toBe('test-token-123');
    expect(getElement('gatewayPubKey').value).toBe('BASE64PUBKEY');
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', 'http://localhost/');
  });

  it('does not fill fields when fragment is empty', () => {
    delete globalThis.location;
    globalThis.location = { hash: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' };

    app._applyPairingFragment();

    expect(getElement('relayUrl').value).toBe('');
  });

  it('does not fill fields when fragment has no recognized params', () => {
    delete globalThis.location;
    globalThis.location = { hash: '#foo=bar', href: 'http://localhost/#foo=bar', origin: 'http://localhost', pathname: '/' };

    app._applyPairingFragment();

    expect(getElement('relayUrl').value).toBe('');
  });
});
```

**Step 2: 跑测试确认失败**

Run: `cd /Users/wangyan/openclaw-relay/client && npm test -- --run`
Expected: FAIL — `_applyPairingFragment` 不存在。

**Step 3: 实现 `_applyPairingFragment`**

在 `app` 对象中添加（在 `init` 方法附近）：

```javascript
_applyPairingFragment() {
  const hash = globalThis.location?.hash;
  if (!hash || hash.length < 2) return;

  const params = new URLSearchParams(hash.slice(1));
  const relay = params.get('relay');
  const token = params.get('token');
  const key = params.get('key');

  if (!relay && !token && !key) return;

  if (relay) document.getElementById('relayUrl').value = relay;
  if (token) document.getElementById('channelToken').value = token;
  if (key) document.getElementById('gatewayPubKey').value = key;

  // 立即清理 fragment，避免敏感信息留在地址栏和浏览器历史中
  const cleanUrl = globalThis.location.origin + globalThis.location.pathname;
  globalThis.history?.replaceState(null, '', cleanUrl);
},
```

在 `init()` 方法开头（`this._loadSettings()` 之前）调用：

```javascript
this._applyPairingFragment();
```

注意顺序：fragment 填充 → 加载设置 → profile 恢复。如果 fragment 已经填了字段，后续的 profile 恢复不会覆盖（因为 `_applyProfileToForm` 只在 `selectedProfile` 存在时才填）。但需确认：如果 fragment 参数存在，应跳过 profile 自动选择。在 `init()` 中，fragment 填充后设置一个标记：

```javascript
const hasFragment = this._applyPairingFragment();
```

让 `_applyPairingFragment` 返回 `boolean`。如果返回 `true`，跳过后面的 profile 恢复逻辑。

**Step 4: 跑测试确认通过**

Run: `cd /Users/wangyan/openclaw-relay/client && npm test -- --run`
Expected: PASS

**Step 5: 提交**

```bash
git add client/js/app.js client/tests/app.test.js
git commit -m "feat(web-client): auto-fill pairing params from URL fragment

Read relay/token/key from location.hash, fill the connect form,
then immediately clear the fragment via history.replaceState to
prevent sensitive values from persisting in the address bar or
browser history."
```

---

### Task 2: Plugin — 添加 `--print-web-url` 和 `--open-web` 选项

**Files:**
- Modify: `plugin/src/openclaw-host.ts:1633-1665`（CLI 参数注册 + pair action）
- Modify: `plugin/src/pairing.ts:49-62`（`buildPairingInfo` — 添加 `webUrl` 派生）
- Modify: `plugin/src/types.ts:319-327`（`PairingSessionInfo` — 添加 `webUrl` 可选字段）

**设计原则：** web handoff URL 从现有 `buildPairingInfo()` 返回的 canonical pairing info 派生，不造第二套语义。`webUrl` 作为可选字段加到 `PairingSessionInfo`，只在调用方传入 `webBase` 时生成。

**Step 1: 在 `PairingSessionInfo` 中添加可选字段**

```typescript
// plugin/src/types.ts
export interface PairingSessionInfo {
  accountId: string;
  relayUrl: string;
  channelToken: string;
  gatewayPublicKey: string;
  gatewayFingerprint: string;
  uri: string;
  expiresAt: string;
  webUrl?: string;  // 从 canonical pairing info 派生，仅当传入 webBase 时生成
}
```

**Step 2: 在 `buildPairingInfo` 中派生 `webUrl`**

```typescript
// plugin/src/pairing.ts — buildPairingInfo 添加可选参数
export async function buildPairingInfo(
  accountId: string, config: RelayAccountConfig,
  pairing: PairingManager, webBase?: string,
): Promise<PairingSessionInfo> {
  const relayUrl = config.server;
  const channelToken = config.channelToken;
  const gatewayPublicKey = config.gatewayKeyPair.publicKey;
  const gatewayFingerprint = await fingerprintFromPublicKeyBase64(gatewayPublicKey);
  const expiresAt = pairing.expiresAt() ?? new Date().toISOString();

  const info: PairingSessionInfo = {
    accountId, relayUrl, channelToken, gatewayPublicKey, gatewayFingerprint,
    uri: `openclaw-relay://${new URL(relayUrl).host}/${channelToken}#${gatewayPublicKey}`,
    expiresAt,
  };

  if (webBase) {
    const base = webBase.replace(/\/$/, '');
    const fragment = `relay=${encodeURIComponent(relayUrl)}&token=${encodeURIComponent(channelToken)}&key=${encodeURIComponent(gatewayPublicKey)}`;
    info.webUrl = `${base}#${fragment}`;
  }

  return info;
}
```

**Step 3: 在 `openclaw-host.ts` 中注册 CLI 参数**

在 `pair` 命令（line 1633）添加两个 option：

```typescript
.option('--print-web-url <base>', 'Print a one-click web client URL with pairing params in fragment')
.option('--open-web <base>', 'Open the web client in the default browser with pairing params')
```

在 action 中（line 1646 附近），将 `webBase` 传给 `handleRelayPair` / `buildPairingInfo`：

```typescript
const webBase = options.printWebUrl || options.openWeb || undefined;
const info = await handleRelayPair(store, record.pairing, accountId, webBase);
console.log(JSON.stringify({ ok: true, pairing: info }, null, 2));

if (info.webUrl) {
  if (options.openWeb) {
    const { exec } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} "${info.webUrl}"`);
  }
}
```

注意：channelToken 放在 fragment 中（`#` 之后），不放 query string。Fragment 不会发送到服务器，也不会出现在 HTTP 日志中。

输出示例：
```
Web client URL: http://localhost:8080/client/#relay=wss%3A%2F%2Frelay.example.com%2Fws&token=kx8f-a3mv-9pqz&key=LoXYz0QKx...
```

**Step 4: 跑 plugin 测试**

Run: `cd /Users/wangyan/openclaw-relay/plugin && npm test`
Expected: PASS

**Step 5: 提交**

```bash
git add plugin/src/openclaw-host.ts plugin/src/pairing.ts plugin/src/types.ts
git commit -m "feat(plugin): add --print-web-url and --open-web to pair command

Derive webUrl from canonical PairingSessionInfo. --print-web-url
prints a one-click URL, --open-web also opens the default browser.
Pairing parameters are encoded in the URL fragment (never sent to
the server)."
```

---

### Task 3: 更新文档 — 修正 `--wait 30` 误导 + 添加 pairing handoff

**背景：** 真实默认值是 `PAIR_WAIT_SECONDS = 300`（`plugin/src/openclaw-host.ts:41`），但现有文档全部写着 `--wait 30`，给用户造成 "30 秒内必须完成配对" 的误导。

**Files:**
- Modify: `docs/quick-start.md:60,63`
- Modify: `README.md:44,141`
- Modify: `plugin/README.md:44`
- Modify: `docs/deployment.md:180`

**Step 1: 全局修正 `--wait 30` → 去掉或改为默认值**

策略：大部分场景直接用 `openclaw relay pair`（不带 `--wait`，使用默认 300 秒）。只在需要自定义时才显式写 `--wait`。

| 文件 | 改法 |
|------|------|
| `docs/quick-start.md:60` | `openclaw relay pair --wait 30` → `openclaw relay pair` |
| `docs/quick-start.md:63` | 修正描述文字：删除 "30 seconds"，改为 "keeps the pairing window open (default 5 minutes)" |
| `README.md:44` | `openclaw relay pair --wait 30` → `openclaw relay pair` |
| `README.md:141` | `openclaw relay pair --wait 30` → `openclaw relay pair` |
| `plugin/README.md:44` | `openclaw relay pair --wait 30` → `openclaw relay pair` |
| `docs/deployment.md:180` | `openclaw relay pair --wait 30` → `openclaw relay pair` |

注意：`scripts/smoke-openclaw-plugin.sh` 中的 `--wait 30` 保留不动——那是测试脚本，30 秒超时是故意的。

**Step 2: 在 quick-start.md 中添加 pairing handoff 说明**

在配对步骤中补充：

```markdown
如果 Web 客户端部署在已知地址（比如 `http://localhost:8080/client/`），
可以使用 `--print-web-url` 直接生成一键连接链接：

\`\`\`bash
openclaw relay pair --print-web-url http://localhost:8080/client/
\`\`\`

终端会打印一个 URL，浏览器打开即可自动填入所有配对参数。
```

**Step 3: 同步更新 README 中的三步上手**

在第 3 步中补充 `--print-web-url` 用法。

**Step 4: 提交**

```bash
git add docs/quick-start.md README.md plugin/README.md docs/deployment.md
git commit -m "docs: fix misleading --wait 30 (default is 300s) and add pairing handoff URL

All user-facing docs now use plain 'openclaw relay pair' which defaults
to a 5-minute pairing window. Added --print-web-url example for
one-click browser connection."
```

---

## Phase 1: Reduce Noise

### Task 4: 重构 HTML — L0 / L1 / L2 层级 + 术语更新

**Files:**
- Modify: `client/index.html:610-674`（connect form）

**Step 1: 重写 connect form HTML**

替换 `<form class="connect-form">` 内容为 L0/L1/L2 结构。关键差异（对比旧计划）：

**折叠控制用 `aria-expanded` + `hidden` attribute，不用 `style.display`：**

```html
<form class="connect-form" id="connectForm" onsubmit="return app.handleConnect(event)">
  <!-- L0: Core (always visible) -->
  <h2>Connect to your OpenClaw</h2>
  <p class="subtitle">Use the three values from OpenClaw pairing to connect this browser.</p>

  <div class="form-group">
    <label for="relayUrl">Server address</label>
    <span class="field-subtitle">Relay URL</span>
    <input type="text" id="relayUrl" placeholder="wss://relay.example.com/ws" autocomplete="off" required>
  </div>

  <div class="form-group">
    <label for="channelToken">Access token</label>
    <span class="field-subtitle">Channel token</span>
    <div class="input-with-toggle">
      <input type="password" id="channelToken" placeholder="kx8f-a3mv-9pqz" autocomplete="off" required>
      <button type="button" class="toggle-visibility-btn" id="tokenVisibilityBtn"
        onclick="app.toggleTokenVisibility()" title="Show/hide token"
        aria-label="Toggle token visibility">&#x1F441;</button>
    </div>
  </div>

  <div class="form-group">
    <label for="gatewayPubKey">Gateway verification key</label>
    <input type="text" id="gatewayPubKey" placeholder="base64-encoded 32-byte X25519 public key" autocomplete="off" required>
  </div>

  <button type="submit" class="connect-btn" id="connectBtn">Connect</button>
  <div class="connect-error" id="connectError"></div>

  <!-- Identity summary (L0, clickable to expand L2) -->
  <div class="identity-summary" id="identitySummary" onclick="app.toggleSection('identity')">
    <span id="identitySummaryText">Browser identity: loading…</span>
  </div>

  <!-- Identity load failure banner (L0, visible only on error) -->
  <div class="identity-error-banner" id="identityErrorBanner" hidden>
    Identity load failed — import a backup or reset
  </div>

  <!-- L1: Saved Profiles (always present, shows empty state when no profiles) -->
  <div class="collapsible-section" id="profilesSection">
    <button type="button" class="section-toggle" id="profilesToggle"
      onclick="app.toggleSection('profiles')"
      aria-expanded="false" aria-controls="profilesContent">
      <span class="toggle-arrow" id="profilesArrow">&#x25B8;</span> Saved profiles
    </button>
    <div class="section-content" id="profilesContent" hidden>
      <!-- Empty state (shown when no profiles) -->
      <div class="profiles-empty" id="profilesEmpty">
        <p class="empty-hint">No saved profiles yet. Connect to a relay, then save it here for quick access.</p>
        <button type="button" class="secondary-btn" id="saveConnectionBtn" onclick="app.saveProfile()">Save current connection</button>
      </div>
      <!-- Profile list (shown when profiles exist) -->
      <div class="profiles-list" id="profilesList" hidden>
        <div class="form-group">
          <div class="profile-actions">
            <select id="profileSelect">
              <option value="">Custom / unsaved</option>
            </select>
            <button type="button" class="secondary-btn" id="saveProfileBtn" onclick="app.saveProfile()">Save</button>
            <button type="button" class="secondary-btn" id="deleteProfileBtn" onclick="app.deleteProfile()" disabled>Delete</button>
          </div>
        </div>
        <div class="form-group">
          <label for="profileName">Profile name</label>
          <input type="text" id="profileName" placeholder="Office relay" autocomplete="off">
        </div>
      </div>
    </div>
  </div>

  <!-- L2: Browser Identity (collapsed) -->
  <div class="collapsible-section" id="identitySection">
    <button type="button" class="section-toggle" id="identityToggle"
      onclick="app.toggleSection('identity')"
      aria-expanded="false" aria-controls="identityContent">
      <span class="toggle-arrow" id="identityArrow">&#x25B8;</span> Browser identity
    </button>
    <div class="section-content" id="identityContent" hidden>
      <div class="identity-card">
        <div class="identity-card-header">
          <span class="identity-title">Client Identity</span>
          <div class="identity-actions">
            <button type="button" class="secondary-btn" id="exportIdentityBtn" onclick="app.exportIdentity()" disabled>Export</button>
            <button type="button" class="secondary-btn" id="importIdentityBtn" onclick="app.triggerImportIdentity()">Import</button>
            <button type="button" class="secondary-btn" id="resetIdentityBtn" onclick="app.resetIdentity()" disabled>Reset</button>
          </div>
        </div>
        <div class="identity-mode" id="identityMode">Loading…</div>
        <div class="identity-fingerprint" id="identityFingerprint">Checking browser identity storage…</div>
        <div class="identity-meta" id="identityMeta"></div>
        <div class="identity-copy-actions">
          <button type="button" class="secondary-btn" id="copyFingerprintBtn" onclick="app.copyIdentityFingerprint()" disabled>Copy Fingerprint</button>
          <button type="button" class="secondary-btn" id="copyPublicKeyBtn" onclick="app.copyIdentityPublicKey()" disabled>Copy Public Key</button>
        </div>
        <div class="identity-note identity-recovery" id="identityRecoveryHint">Checking browser identity storage…</div>
        <div class="identity-passphrase">
          <label for="identityPassphrase">Identity File Passphrase (optional)</label>
          <input type="password" id="identityPassphrase" placeholder="Used only for export/import" autocomplete="off">
          <div class="identity-note">Never stored. Set it to encrypt exports or unlock protected identity files.</div>
        </div>
        <input type="file" id="identityImportInput" accept="application/json" style="display:none">
      </div>
    </div>
  </div>
</form>
```

**Step 2: 提交**

```bash
git add client/index.html
git commit -m "refactor(web-client): restructure connect form into L0/L1/L2 with aria

Use aria-expanded/aria-controls + hidden attribute for collapsible
sections. Profiles section always visible with empty state fallback.
Dual-layer field naming per UX redesign."
```

---

### Task 5: 添加新 CSS

**Files:**
- Modify: `client/index.html`（CSS 部分）

**Step 1: 添加 CSS 规则**

在 `.connect-error` 样式之后添加：

```css
/* ── Dual-layer field labels ─────────────────── */
.field-subtitle {
  display: block;
  font-size: 11px;
  color: #666;
  margin-top: -4px;
  margin-bottom: 4px;
}

/* ── Password visibility toggle ──────────────── */
.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}
.input-with-toggle input { flex: 1; padding-right: 40px; }
.toggle-visibility-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  color: var(--muted);
  padding: 4px;
  line-height: 1;
  opacity: 0.6;
  transition: opacity 0.2s;
}
.toggle-visibility-btn:hover { opacity: 1; }

/* ── Identity summary line ───────────────────── */
.identity-summary {
  margin-top: 12px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  text-align: center;
  transition: color 0.2s;
}
.identity-summary:hover { color: var(--text); }

/* ── Collapsible sections ────────────────────── */
.collapsible-section {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.section-toggle {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  padding: 6px 0;
  width: 100%;
  text-align: left;
  transition: color 0.2s;
}
.section-toggle:hover { color: var(--text); }
.toggle-arrow {
  display: inline-block;
  transition: transform 0.2s;
  font-size: 11px;
}
.section-toggle[aria-expanded="true"] .toggle-arrow {
  transform: rotate(90deg);
}

/* ── Profiles empty state ────────────────────── */
.profiles-empty { padding: 8px 0; }
.empty-hint {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
  line-height: 1.4;
}

/* ── Identity error banner ───────────────────── */
.identity-error-banner {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius);
  color: var(--error);
  font-size: 13px;
  text-align: center;
}

/* ── Profile save banner (below status bar) ──── */
.profile-save-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 20px;
  background: rgba(74, 222, 128, 0.08);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--muted);
  flex-shrink: 0;
}
```

**Step 2: 提交**

```bash
git add client/index.html
git commit -m "style(web-client): add CSS for L0/L1/L2 layout and profile save banner"
```

---

### Task 6: JavaScript — 折叠/展开、Token 切换、Identity Summary

**Files:**
- Modify: `client/js/app.js`

**Step 1: 实现 `toggleSection`（用 `hidden` + `aria-expanded`，不用 `style.display`）**

```javascript
toggleSection(section) {
  const config = {
    profiles:          { toggle: 'profilesToggle',     content: 'profilesContent' },
    identity:          { toggle: 'identityToggle',     content: 'identityContent' },
    connectionDetails: { toggle: 'connDetailsToggle',  content: 'connectionDetailsContent' },
  };
  const cfg = config[section];
  if (!cfg) return;

  const toggleBtn = document.getElementById(cfg.toggle);
  const content = document.getElementById(cfg.content);
  if (!toggleBtn || !content) return;

  const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
  toggleBtn.setAttribute('aria-expanded', String(!isExpanded));
  content.hidden = isExpanded;
},
```

**Step 2: 实现 `toggleTokenVisibility`**

```javascript
toggleTokenVisibility() {
  const input = document.getElementById('channelToken');
  input.type = input.type === 'password' ? 'text' : 'password';
},
```

**Step 3: 实现 `_updateIdentitySummary`**

```javascript
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
    const mode = summary.persistence === 'persisted' ? 'persistent' : 'temporary';
    el.textContent = `Browser identity: ${this._shortFingerprint(summary.fingerprint)} · ${mode}`;
    return;
  }
  if (summary.persistence === 'unsupported') {
    el.textContent = 'Browser identity: persistence unavailable';
    return;
  }
  el.textContent = 'Browser identity: not created yet';
},
```

**Step 4: 实现 `_updateProfilesView`（空状态 vs 列表切换）**

```javascript
_updateProfilesView() {
  const empty = document.getElementById('profilesEmpty');
  const list = document.getElementById('profilesList');
  if (!empty || !list) return;

  const hasProfiles = this.profiles.length > 0;
  empty.hidden = hasProfiles;
  list.hidden = !hasProfiles;
},
```

**Step 5: 在 `_updateIdentityStatus` 开头调用 summary（不在末尾）**

在 `_updateIdentityStatus()` 的**第一行**（在所有 DOM 获取之前）插入：

```javascript
this._updateIdentitySummary();
```

这确保无论 `_updateIdentityStatus` 后续有多少个提前 return，summary 行始终更新。

**Step 6: 在 `init`、`saveProfile`、`deleteProfile` 中调用 `_updateProfilesView`**

**Step 7: 更新术语**

- `handleConnect` 中：`'Connected. End-to-end encryption active.'` → `'Connected securely to your OpenClaw.'`
- `_updateStatus` 中：`disconnected: 'Disconnected'` → `disconnected: 'Not connected'`

**Step 8: 提交**

```bash
git add client/js/app.js
git commit -m "feat(web-client): add collapse/expand with aria, token toggle, identity summary

toggleSection uses aria-expanded + hidden attribute for accessibility.
_updateIdentitySummary called at start of _updateIdentityStatus to
avoid early-return bypass. Profiles section shows empty state instead
of hiding entirely."
```

---

### Task 7: Phase 1 测试

**Files:**
- Modify: `client/tests/app.test.js`

**Step 1: Token 切换测试**

```javascript
describe('token visibility toggle', () => {
  it('toggles channelToken input between password and text', () => {
    getElement('channelToken').type = 'password';
    app.toggleTokenVisibility();
    expect(getElement('channelToken').type).toBe('text');
    app.toggleTokenVisibility();
    expect(getElement('channelToken').type).toBe('password');
  });
});
```

**Step 2: 折叠/展开测试（aria 版）**

```javascript
describe('collapsible sections', () => {
  it('toggles profiles section via aria-expanded and hidden', () => {
    const toggle = getElement('profilesToggle');
    const content = getElement('profilesContent');
    toggle.getAttribute = vi.fn(() => 'false');
    toggle.setAttribute = vi.fn();
    content.hidden = true;

    app.toggleSection('profiles');

    expect(toggle.setAttribute).toHaveBeenCalledWith('aria-expanded', 'true');
    expect(content.hidden).toBe(false);
  });

  it('collapses expanded section', () => {
    const toggle = getElement('identityToggle');
    const content = getElement('identityContent');
    toggle.getAttribute = vi.fn(() => 'true');
    toggle.setAttribute = vi.fn();
    content.hidden = false;

    app.toggleSection('identity');

    expect(toggle.setAttribute).toHaveBeenCalledWith('aria-expanded', 'false');
    expect(content.hidden).toBe(true);
  });
});
```

**Step 3: Identity summary 测试**（和原计划相同）

**Step 4: Profiles 空状态 vs 列表测试**

```javascript
describe('profiles view state', () => {
  it('shows empty state when no profiles exist', () => {
    app.profiles = [];
    app._updateProfilesView();
    expect(getElement('profilesEmpty').hidden).toBe(false);
    expect(getElement('profilesList').hidden).toBe(true);
  });

  it('shows list when profiles exist', () => {
    app.profiles = [{ id: 'p1', name: 'Test' }];
    app._updateProfilesView();
    expect(getElement('profilesEmpty').hidden).toBe(true);
    expect(getElement('profilesList').hidden).toBe(false);
  });
});
```

**Step 5: 跑测试确认通过**

Run: `cd /Users/wangyan/openclaw-relay/client && npm test -- --run`

**Step 6: 提交**

```bash
git add client/tests/app.test.js
git commit -m "test(web-client): add Phase 1 tests for aria toggle, token, identity summary, profiles"
```

---

### Task 8: Phase 1 文档

**Files:**
- Modify: `docs/web-client/manifest.json`
- Modify: `docs/web-client/ui-and-state.md`

**Step 1: 更新 manifest.json**

在 `app.js` 的 `responsibilities` 数组中添加：
- `"pairing fragment auto-fill"`
- `"collapsible section toggle (aria-expanded)"`
- `"token visibility toggle"`
- `"identity summary rendering"`
- `"profiles empty/list view toggle"`

**Step 2: 更新 ui-and-state.md**

添加关于 L0/L1/L2 信息层级和 pairing handoff 的描述。

**Step 3: 提交**

```bash
git add docs/web-client/manifest.json docs/web-client/ui-and-state.md
git commit -m "docs(web-client): update manifest and UI docs for Phase 1"
```

---

## Phase 2: Status Bar

### Task 9: 替换 Session Bar HTML

**Files:**
- Modify: `client/index.html:686-705`

**Step 1: 用状态栏 + 连接详情替换 session-bar**

```html
<!-- Status bar -->
<div class="status-bar" id="statusBar">
  <div class="status-bar-info">
    <span id="statusBarText">Not connected</span>
  </div>
  <div class="status-bar-actions">
    <button class="secondary-btn" id="newChatBtn" onclick="app.startNewChat()" disabled>New chat</button>
    <button class="secondary-btn" id="exportChatBtn" onclick="app.exportCurrentChat()" disabled>Save conversation</button>
  </div>
</div>

<!-- Profile save banner (below status bar, not in messages) -->
<div class="profile-save-banner" id="profileSaveBanner" hidden>
  <span>Save this connection as a profile?</span>
  <button class="secondary-btn" onclick="app._acceptProfileSave()">Save</button>
  <button class="secondary-btn" onclick="app._dismissProfileSave()">Dismiss</button>
</div>

<!-- Connection details (expandable) -->
<div class="connection-details-section">
  <button type="button" class="section-toggle" id="connDetailsToggle"
    onclick="app.toggleSection('connectionDetails')"
    aria-expanded="false" aria-controls="connectionDetailsContent">
    Connection details <span class="toggle-arrow">&#x25B8;</span>
  </button>
  <div id="connectionDetailsContent" hidden>
    <div class="connection-details">
      <div class="detail-row"><span class="detail-label">Session</span><span class="detail-value" id="detailSession">New chat</span></div>
      <div class="detail-row"><span class="detail-label">Client</span><span class="detail-value" id="detailClient">Pending</span></div>
      <div class="detail-row"><span class="detail-label">Gateway</span><span class="detail-value" id="detailGateway">Not set</span></div>
      <div class="detail-row"><span class="detail-label">Profile</span><span class="detail-value" id="detailProfile">Custom / unsaved</span></div>
      <div class="detail-row"><span class="detail-label">Encryption</span><span class="detail-value" id="detailEncryption">—</span></div>
      <div class="detail-row"><span class="detail-label">Identity</span><span class="detail-value" id="detailIdentity">—</span></div>
    </div>
  </div>
</div>
```

注意：`statusBarText` 由 JS 动态设置（不写死 "Encrypted"），`profileSaveBanner` 在状态栏下方（不在消息流中）。

**Step 2: 提交**

```bash
git add client/index.html
git commit -m "refactor(web-client): replace session-bar with status bar, save banner, connection details"
```

---

### Task 10: Status Bar CSS + Connection Details CSS

**Files:**
- Modify: `client/index.html`（CSS 部分）

（CSS 与原计划类似，此处不重复。添加 `.status-bar`、`.status-bar-info`、`.status-bar-actions`、`.connection-details-section`、`.connection-details`、`.detail-row`、`.detail-label`、`.detail-value` 样式。）

**Step 1: 提交**

```bash
git add client/index.html
git commit -m "style(web-client): add CSS for status bar, save banner, connection details"
```

---

### Task 11: JavaScript — 状态栏动态文案 + 连接详情 + Profile 保存提示

**Files:**
- Modify: `client/js/app.js`

**Step 1: 状态栏文案按 connection.state 动态显示**

在 `_updateDiagnostics` 中，status bar 文案逻辑：

```javascript
const statusBarText = document.getElementById('statusBarText');
if (statusBarText) {
  const state = this.connection.state;
  if (state === 'connected') {
    try {
      const url = new URL(this.connection.relayUrl || '');
      const agent = document.getElementById('agentSelect')?.value || '';
      statusBarText.textContent = `Connected to ${url.host} · Encrypted` + (agent ? ` · ${agent}` : '');
    } catch {
      statusBarText.textContent = 'Connected securely';
    }
  } else if (state === 'connecting') {
    statusBarText.textContent = 'Connecting…';
  } else {
    statusBarText.textContent = 'Not connected';
  }
}
```

Connection details 中的 Encryption 字段也要动态：

```javascript
const detailEncryption = document.getElementById('detailEncryption');
if (detailEncryption) {
  detailEncryption.textContent = this.connection.encrypted ? 'AES-256-GCM' : '—';
}
```

**Step 2: Profile 保存提示（inline banner，不进消息流）**

```javascript
_showProfileSavePrompt() {
  if (this._profileSavePromptDismissed) return;
  const relayUrl = this.connection.relayUrl || '';
  const gatewayPubKey = this.connection.gatewayPubKeyB64 || '';
  if (!relayUrl || !gatewayPubKey) return;
  if (this.profiles.some(p => p.relayUrl === relayUrl && p.gatewayPubKey === gatewayPubKey)) return;

  const banner = document.getElementById('profileSaveBanner');
  if (banner) banner.hidden = false;
},

_acceptProfileSave() {
  const relayUrl = this.connection.relayUrl || '';
  const gatewayPubKey = this.connection.gatewayPubKeyB64 || '';
  const name = this._deriveProfileName(relayUrl);
  const now = new Date().toISOString();
  this.profiles.push({
    id: this._generateProfileId(), name, relayUrl, gatewayPubKey,
    createdAt: now, updatedAt: now,
  });
  this._saveProfiles();
  this._updateProfilesView();
  const banner = document.getElementById('profileSaveBanner');
  if (banner) banner.hidden = true;
  showToast(`Saved as "${name}".`, 'info');
},

_dismissProfileSave() {
  this._profileSavePromptDismissed = true;
  const banner = document.getElementById('profileSaveBanner');
  if (banner) banner.hidden = true;
},
```

在 `handleConnect` 成功后调用 `_showProfileSavePrompt()`。在 `disconnect()` 中重置 `_profileSavePromptDismissed = false` 并隐藏 banner。

**Step 3: 保留旧 DOM ID 兼容（legacy fallback）**

现有测试依赖 `sessionValue`、`clientValue` 等 ID。在 `_updateDiagnostics` 末尾保留条件更新。

**Step 4: 提交**

```bash
git add client/js/app.js
git commit -m "feat(web-client): dynamic status bar, inline profile save banner, connection details

Status bar shows state-dependent text (Not connected / Connecting /
Connected to host · Encrypted · agent). Profile save prompt is an
inline banner below the status bar, not injected into the message
stream. Encryption field in connection details is dynamic."
```

---

### Task 12: Phase 2 测试

**Files:**
- Modify: `client/tests/app.test.js`

**Step 1: 状态栏三态文案测试**

```javascript
describe('status bar text', () => {
  it('shows "Not connected" when disconnected', () => {
    app.connection.state = 'disconnected';
    app._updateDiagnostics();
    expect(getElement('statusBarText').textContent).toBe('Not connected');
  });

  it('shows "Connecting…" when connecting', () => {
    app.connection.state = 'connecting';
    app._updateDiagnostics();
    expect(getElement('statusBarText').textContent).toBe('Connecting…');
  });

  it('shows host and Encrypted when connected', () => {
    app.connection.state = 'connected';
    app.connection.relayUrl = 'wss://relay.example.com/ws';
    app.connection.encrypted = true;
    getElement('agentSelect').value = 'wukong';

    app._updateDiagnostics();

    expect(getElement('statusBarText').textContent).toMatch(/relay\.example\.com/);
    expect(getElement('statusBarText').textContent).toMatch(/Encrypted/);
    expect(getElement('statusBarText').textContent).toMatch(/wukong/);
  });
});
```

**Step 2: Connection details 和 profile save 测试**

（与原计划类似，检查 `detailSession`、`detailClient` 等新 ID，以及 banner hidden 状态切换。）

**Step 3: 跑全部测试**

Run: `cd /Users/wangyan/openclaw-relay/client && npm test -- --run`

**Step 4: 提交**

```bash
git add client/tests/app.test.js
git commit -m "test(web-client): add status bar state tests, connection details, profile save banner"
```

---

### Task 13: Phase 2 文档

**Files:**
- Modify: `docs/web-client/state-machine.json`
- Modify: `docs/web-client/ui-and-state.md`
- Modify: `docs/web-client.md`

**Step 1: state-machine.json**

在 `chat_panel` 的 `visible_sections` 中，替换 `"session diagnostics bar"` 为：
- `"status bar"`
- `"profile save banner (conditional)"`
- `"connection details (collapsed)"`

**Step 2: 提交**

```bash
git add docs/web-client/state-machine.json docs/web-client/ui-and-state.md docs/web-client.md
git commit -m "docs(web-client): update state machine and UI docs for Phase 2"
```

---

## Phase 3: Visual Polish

### Task 14: 过渡动画和 Hover 状态

**Files:**
- Modify: `client/index.html`（CSS 部分）

**Step 1: 在 class 基础上做动画（已有 `[aria-expanded]` + `hidden`，动画用 class 切换）**

```css
.section-content {
  overflow: hidden;
  transition: max-height 0.2s ease, opacity 0.2s ease;
}
.connect-btn:active { transform: scale(0.98); }
.secondary-btn:active:not(:disabled) { transform: scale(0.96); }
```

**Step 2: 更新移动端适配**

在 `@media (max-width: 600px)` 中添加 `.status-bar`、`.connection-details` 等规则。

**Step 3: 提交**

```bash
git add client/index.html
git commit -m "style(web-client): add transitions, hover states, mobile responsive"
```

---

### Task 15: 最终验证

**Step 1: 单元测试**

Run: `cd /Users/wangyan/openclaw-relay/client && npm test -- --run`

**Step 2: Browser E2E**

Run: `cd /Users/wangyan/openclaw-relay/client && npm run test:e2e`

**Step 3: Plugin 测试**

Run: `cd /Users/wangyan/openclaw-relay/plugin && npm test`

**Step 4: 人工验证清单**

- [ ] 打开带 fragment 的 URL，表单自动填充，fragment 立即清除
- [ ] L0 核心字段可见，双层标签
- [ ] Token 字段为 password 类型，眼睛按钮切换可见性
- [ ] Identity summary 行显示在 Connect 按钮下方
- [ ] Saved Profiles 折叠时展示空状态文案 + Save 按钮
- [ ] 有 profile 时展示下拉列表
- [ ] Browser Identity 折叠/展开正常
- [ ] 连接后状态栏显示 `Connected to host · Encrypted · agent`
- [ ] 断连状态显示 `Not connected`
- [ ] Profile 保存提示在状态栏下方（不在消息流中）
- [ ] Connection details 展开/折叠
- [ ] Save conversation 按钮名称
- [ ] 375px 宽度移动端布局正常

**Step 5: 提交**

```bash
git add -A
git commit -m "chore(web-client): final verification for UX redesign"
```
