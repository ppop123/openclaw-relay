# OpenClaw Relay Desktop Shell

This directory contains the official Windows/macOS desktop shell for OpenClaw Relay.

It does not implement a second client. It wraps the shared `client/` frontend in a native Tauri window so non-technical users can install an app, click one pairing link, and connect to their own OpenClaw.

## Product boundary

- Supports Windows and macOS.
- Does not target phones or tablets.
- Does not add peer discovery or agent-to-agent controls.
- Shares the same frontend and security model as the browser client.
- Keeps `channelToken` out of persistent storage.

## Local development

```bash
cd desktop
npm install
npm run dev
```

## Local build

```bash
cd desktop
npm install
npm run build:app   # local app bundle (no DMG/NSIS)
npm run build       # release bundles
```

## User-facing behavior

- Pairing-link first onboarding
- Shared connection screen and chat UI from `client/` (synced into `desktop/webview-dist/` before dev/build)
- Close window = quit app
- Minimal native menu for documentation and update page

## Install and connect (end users)

1. Download the latest desktop installer from the GitHub Releases page.
2. Ask OpenClaw for a pairing link via `/relay_pair` in Feishu / Telegram and click it.
3. The desktop shell auto-fills the pairing values and connects.
4. Next time you open the app, it reconnects using the saved profile and browser identity.
