# Desktop Shell Implementation Plan

**Goal:** Ship one complete official desktop shell for Windows and macOS that wraps the existing shared web client and is simple enough for non-technical users.

**Product rule:** This is not a second client implementation. `desktop/` is a native shell around the shared `client/` frontend. Anything that would split behavior, vocabulary, or security semantics between browser and desktop is out of scope.

**Success bar:** A non-technical user can install the app, paste one pairing link, connect to their own OpenClaw, and reopen the app later without learning the underlying protocol terms.

---

## Phase 0: Shared Onboarding Simplification

### Task 1: Add pairing-link parsing to the shared client

**Why first:** Desktop v1 is not complete if users still have to manually copy Relay URL, Channel Token, and Gateway Key.

**Files:**
- Modify: `client/index.html`
- Modify: `client/js/app.js`
- Modify: `client/tests/app.test.js`
- Modify: `docs/quick-start.md`
- Modify: `README.md`

**Requirements:**
- Add a primary `Pairing link` input path to the shared connect screen.
- Parse a full pairing link into the existing underlying fields.
- Keep the existing manual fields as an advanced fallback, not the default first-use path.
- Do not persist `channelToken`.
- Keep browser and desktop behavior aligned.

**Accepted inputs:**
- Existing fragment handoff URLs
- Canonical `openclaw-relay://...` pairing links if already produced by OpenClaw/plugin

**Tests:**
- parsing success
- malformed link rejection
- fragment cleanup still works
- saved profiles are not incorrectly overwritten

---

### Task 2: Rewrite the connect screen copy for ordinary users

**Files:**
- Modify: `client/index.html`
- Modify: `client/js/app.js`
- Modify: `docs/web-client.md`
- Modify: `docs/web-client/ui-and-state.md`

**Requirements:**
- The first visible path should read like a normal product, not a protocol console.
- First-use copy should explain the task in one sentence.
- Manual fields should be labeled in plain language first, technical mapping second.
- The status line must stay simple:
  - `Not connected`
  - `Connecting`
  - `Connected securely`

**Do not add:**
- peer wording
- relay internals as first-layer copy
- extra diagnostics on the default path

---

## Phase 1: Minimal Desktop Shell

### Task 3: Scaffold a minimal Tauri v2 project

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/README.md`
- Create: `desktop/src-tauri/Cargo.toml`
- Create: `desktop/src-tauri/build.rs`
- Create: `desktop/src-tauri/tauri.conf.json`
- Create: `desktop/src-tauri/src/main.rs`
- Create: `desktop/src-tauri/src/lib.rs`
- Create: `desktop/src-tauri/icons/`

**Requirements:**
- `frontendDist` points to `../../client`
- no forked desktop frontend
- no bundler requirement for the shared client
- app name and version follow the main repo version

**Keep it minimal:**
- one main window
- no tray
- no updater plugin
- no notification plugin

---

### Task 4: Add only the native shell features that reduce complexity

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/tauri.conf.json`

**Requirements:**
- Standard app window
- Close window = quit app
- Add a minimal application/help menu entry for:
  - `Open documentation`
  - `Check for updates`
- Both actions open external URLs in the default browser

**Do not add in v1:**
- tray icon
- background hide behavior
- startup update checks
- automatic update logic
- JS-driven native notification plumbing

---

### Task 5: Generate and wire the desktop icons

**Files:**
- Create: `desktop/src-tauri/icons/icon.png`
- Create: `desktop/src-tauri/icons/32x32.png`
- Create: `desktop/src-tauri/icons/128x128.png`
- Create: `desktop/src-tauri/icons/128x128@2x.png`
- Create: `desktop/src-tauri/icons/icon.icns`
- Create: `desktop/src-tauri/icons/icon.ico`

**Requirements:**
- Use one clean app icon set
- no connected/disconnected icon variants in v1
- no tray-only assets needed

---

## Phase 2: Packaging and Release

### Task 6: Build installers for the supported desktop platforms

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json`

**Requirements:**
- macOS target: `.dmg`
- Windows target: NSIS installer
- Configure WebView2 install mode explicitly for Windows
- No Linux package target in v1

**Validation:**
- `npm run tauri build` works locally on supported platforms
- produced artifacts install and open cleanly

---

### Task 7: Attach desktop assets to the same main release line

**Files:**
- Create: `.github/workflows/desktop-release.yml`
- Modify: `README.md`
- Modify: `docs/support-matrix.md`

**Requirements:**
- Desktop assets follow the same repo version as the main release
- No `desktop-v*` tag family
- Build from normal `v*` tags
- Publish desktop assets onto the same GitHub Release page for that version

**Reason:**
- one version line is simpler for users and operators
- no split between “main release” and “desktop release”

---

## Phase 3: Documentation for Non-Technical Users

### Task 8: Add a short install-and-connect guide

**Files:**
- Modify: `README.md`
- Modify: `docs/quick-start.md`
- Create or modify: `desktop/README.md`

**Requirements:**
- Explain the desktop app in plain language
- Show only the supported platforms: Windows and macOS
- Make pairing-link onboarding the recommended path
- Explain the fallback manual path only as advanced help

**The guide must answer only these questions:**
- How do I install it?
- How do I connect it to my OpenClaw?
- What do I do next time I open it?
- Where do I download updates?

---

### Task 9: Update support and product-boundary docs

**Files:**
- Modify: `docs/support-matrix.md`
- Modify: `docs/web-client.md`
- Modify: `docs/README.md`

**Requirements:**
- State clearly that official first-party user clients are:
  - browser client on desktop
  - desktop shell on Windows/macOS
- State clearly that phones/tablets are not official supported clients
- Preserve the human-client boundary:
  - user clients only connect to their own OpenClaw
  - no peer discovery / peer contact UX

---

## Phase 4: Validation

### Task 10: Validate the shared client before building desktop

**Commands:**
- `cd client && npm test -- --run`
- `cd client && npm run test:e2e`

**Must verify:**
- pairing-link onboarding works
- manual fallback still works
- connection state text stays correct
- saved profiles and identity behavior did not regress

---

### Task 11: Validate the desktop shell locally

**Commands:**
- `cd desktop && npm install`
- `cd desktop && npm run tauri dev`
- `cd desktop && npm run tauri build`

**Must verify manually on supported platforms:**
- app opens
- close quits
- help/update links open external pages
- pairing-link flow works
- reconnect / reopen behavior matches the browser client

---

### Task 12: Final release checklist

A desktop release is ready only if all of the following are true:

- browser and desktop still share one frontend codepath
- pairing link is the primary first-use path
- no new storage path was added for `channelToken`
- no peer capabilities leaked into the desktop shell
- Windows installer works with explicit WebView2 handling
- macOS dmg opens and launches cleanly
- docs are understandable to non-technical users

---

## Explicit Non-Goals

These are intentionally excluded from the first official desktop release:

- system tray
- hide-to-tray behavior
- desktop-native notifications
- automatic update checks
- automatic update download/install
- deep-link OS registration
- native secret vault integration
- Linux desktop packaging
- mobile packaging

If any of these become important later, they should be proposed as a separate enhancement after the simple desktop shell is already shipped and proven useful.

---

## Implementation Order Summary

1. Shared client: pairing-link onboarding
2. Shared client: simpler copy and status wording
3. Desktop scaffold
4. Minimal native menu + packaging
5. Docs and support matrix
6. Build and validate on macOS + Windows

That order is deliberate: the user-facing onboarding problem must be solved before the desktop wrapper is worth shipping.
