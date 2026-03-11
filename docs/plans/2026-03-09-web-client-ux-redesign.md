# Web Client UX Redesign

Status: approved design
Scope: `client/index.html`, `client/js/app.js`, embedded CSS

## Goal

Make the web client easier to use on first contact without losing technical accuracy or weakening the security model.

Core principle: **reduce noise, don't lose truth.**

## Constraints (non-negotiable)

- Human-facing web client only connects to the user's own OpenClaw instance.
- No peer discovery or contact UX in the browser client.
- `channelToken` is never persisted to storage.
- Gateway verification remains user-supplied pinned key.
- Browser identity model (IndexedDB persistence, memory fallback) is unchanged.
- All existing functionality is preserved — nothing is removed, only reorganized.

## Design

### Connect Panel: Quick Connect + Advanced

Current first screen shows 8+ controls. Redesign splits into three layers:

```
┌─ OpenClaw Relay ───────────────────────────────────────┐
│                                                         │
│  Connect to your OpenClaw                               │
│  Use the three values from OpenClaw pairing             │
│  to connect this browser.                               │
│                                                         │
│  Server address                                         │
│  Relay URL                                              │
│  [wss://relay.example.com/ws                         ]  │
│                                                         │
│  Access token                                           │
│  Channel token                                          │
│  [•••••••••••••••••••••••••••]  👁                      │
│                                                         │
│  Gateway verification key                               │
│  [base64...                                          ]  │
│                                                         │
│  [Connect]                                              │
│                                                         │
│  Browser identity: a1b2...c3d4 · persistent             │
│                                                         │
│  ▸ Saved profiles                                       │
│  ▸ Browser identity                                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### L0: Core (always visible)

- Page brand: **OpenClaw Relay** (header, unchanged)
- Card title: **Connect to your OpenClaw**
- First-use hint: `Use the three values from OpenClaw pairing to connect this browser.`
- Three input fields with dual-layer naming:
  - **Server address** (subtitle: `Relay URL`)
  - **Access token** (subtitle: `Channel token`) — `type="password"` with visibility toggle
  - **Gateway verification key** (no subtitle needed, "gateway" preserved in label)
- **Connect** button (short label, full-width)
- Identity summary line: `Browser identity: a1b2...c3d4 · persistent` — visible without expanding L2. Shows fingerprint shorthand + persistence mode. Clickable, opens L2.

#### L1: Saved Profiles (collapsed)

- **Hidden entirely when no profiles are saved.** First-time users see no dropdown, no empty state.
- After first successful connection, a toast or inline prompt: `Save this connection as a profile?`
- When profiles exist, `▸ Saved profiles` is visible. Expanding shows:
  - Profile dropdown
  - Profile name input
  - Save / Delete buttons
- Selecting a profile auto-fills L0 fields (except token, which is never persisted).

#### L2: Browser Identity (collapsed)

- `▸ Browser identity` — collapsed by default.
- Expanding shows the full identity card:
  - Fingerprint (monospace, full)
  - Persistence mode label + creation timestamp
  - Copy Fingerprint / Copy Public Key buttons
  - Export / Import / Reset buttons
  - Passphrase input (for export protection)
  - Recovery hint (contextual, inline)
- **Exception — load failure:** If identity load fails, a red banner appears ABOVE the fold (in L0 area), visible without expanding: `Identity load failed — import a backup or reset`

### Chat Panel: Status Bar + Details

Current diagnostics bar shows Session ID, Client ID, Profile, Gateway Key as raw technical fields with missing CSS.

#### Status bar (one line, always visible)

```
Connected to relay.example.com · Encrypted · wukong       [New chat] [Save conversation]
```

Content:
- Relay hostname (extracted from URL)
- Encryption status (always "Encrypted" when connected)
- Selected agent name
- Action buttons: New chat, Save conversation (renamed from "Export Chat")

#### Connection details (expandable, not ⋯)

Below the status bar, a clickable `Connection details ▸` link. Expanding shows:

```
Connection details ▾
  Session    sess_abc123def
  Client     a1b2c3d4e5f6...
  Gateway    Xk9mN2pQ...
  Profile    My server
  Encryption AES-256-GCM
  Identity   Persistent (IndexedDB)
```

This replaces the current unstyled `session-bar`. All the same data, but opt-in instead of always-visible.

### Terminology Changes

| Current | New | Where |
|---------|-----|-------|
| Relay URL (label) | Server address (primary) + Relay URL (subtitle) | Connect form |
| Channel Token (label) | Access token (primary) + Channel token (subtitle) | Connect form |
| Gateway Public Key (label) | Gateway verification key | Connect form |
| Connect to your OpenClaw (button) | Connect | Button (keep short) |
| Connected. End-to-end encryption active. | Connected securely to your OpenClaw. | System message |
| Disconnected | Not connected | Status indicator |
| Export Chat | Save conversation | Chat panel button |

#### Not changed

- Page brand: stays **OpenClaw Relay**
- Agent dropdown: stays "Agent"
- New Chat: stays "New Chat"
- Error messages: keep technical detail (users paste these to operators)
- Toast messages: keep current wording
- Identity card internals: keep technical terms (advanced users who expand L2 expect them)

### Password-style Token Input

`channelToken` input changes from `type="text"` to `type="password"` with a visibility toggle (eye icon button).

Benefits:
- Reinforces that this is a sensitive value
- Makes "not persisted" behavior feel natural (users don't expect password fields to be remembered)
- Prevents shoulder-surfing
- Aligns with the security model (bearer secret)

The toggle is purely client-side — no storage behavior changes.

### First-Connection Profile Save Prompt

After first successful connection, if no profile exists for the current relay URL + gateway key combination:

- Show a toast or inline banner in the chat panel: `Save this connection as a profile? [Save] [Dismiss]`
- Clicking Save creates a profile with auto-derived name (from relay hostname)
- Clicking Dismiss hides the prompt for this session

This replaces the need to discover the "Saved profiles" section before first use.

## Phasing

### Phase 1: Reduce Noise

Files: `client/index.html`, `client/js/app.js`

Changes:
- Restructure connect panel into L0 / L1 / L2
- Token field to `type="password"` + visibility toggle
- Identity summary line in L0
- Collapse/expand for Saved Profiles and Browser Identity sections
- Hide Saved Profiles when empty
- Terminology updates on labels and system messages
- First-use hint text
- JS: collapse/expand logic, visibility toggle, identity summary rendering, profile-empty detection

This phase touches HTML structure, CSS, and `app.js` UI methods.

### Phase 2: Status Bar

Files: `client/index.html`, `client/js/app.js`

Changes:
- Replace diagnostics bar with one-line status bar
- Add "Connection details" expandable section
- "Save conversation" rename
- Post-connect profile save prompt
- CSS for status bar (fix the current unstyled `session-bar`)

### Phase 3: Visual Polish

Files: `client/index.html` (CSS section)

Changes:
- Spacing, border-radius, transition animations for collapse/expand
- Hover states for all interactive elements
- Mobile-responsive layout (media queries)
- Optional: light theme support via CSS custom properties

Each phase is independently shippable.

## What Does NOT Change

- Transport layer (`transport.js`) — zero changes
- Crypto layer (`crypto.js`) — zero changes
- Identity store (`identity-store.js`) — zero changes
- Identity bundle (`identity-bundle.js`) — zero changes
- Markdown renderer (`markdown.js`) — zero changes
- Utility functions (`utils.js`) — zero changes
- WebSocket protocol behavior — zero changes
- Security model — zero changes
- State machine transitions — zero changes
- Test suite — existing tests remain valid; new tests for collapse/expand and visibility toggle

## Files Modified

| File | Phase | Nature of change |
|------|-------|-----------------|
| `client/index.html` | 1, 2, 3 | HTML structure + CSS |
| `client/js/app.js` | 1, 2 | UI rendering methods, DOM event handlers |
| `docs/web-client/manifest.json` | 1 | Update UI section descriptions |
| `docs/web-client/state-machine.json` | 2 | Add `connection_details_expanded` to ui_mode_model if needed |
