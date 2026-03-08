# Web Client

This document is the entry point for the browser-side OpenClaw Relay client under `client/`.

The web client is the shipped **browser reference client**. It is not a standalone JavaScript SDK and it does not expose a supported embedding API. Its job is to demonstrate and implement the client side of the relay protocol in a real browser environment.

## What This Client Is

The current web client is responsible for:

- opening a WebSocket connection to the relay
- performing the Layer 1 handshake in the browser
- deriving the per-connection session key
- encrypting and decrypting Layer 2 traffic
- managing request / response / streaming state
- rendering a minimal chat-oriented UI
- persisting safe browser settings
- persisting the browser identity keypair in IndexedDB when available

## What This Client Is Not

The current web client is **not**:

- a reusable JavaScript SDK
- a gateway implementation
- a relay implementation
- a full-featured production chat application
- a cross-browser identity export / import manager

## Current Status

The web client is officially supported and covered by CI.

It currently provides:

- real browser-side Layer 0 / 1 / 2 behavior
- gateway public-key pinning via user-supplied pinned key
- stable browser cryptographic identity across reloads in the same browser profile
- named saved relay profiles for non-secret connection settings
- identity fingerprint plus copy, protected export / import, and reset actions in the connect UI
- streaming `chat.send`
- agent list loading via `agents.list`
- preferred agent restore across reconnects and reloads when that agent is still available
- in-chat diagnostics for session, client, profile, and gateway key state
- local `New Chat` control that resets `sessionId` without disconnecting
- explicit export of the current in-memory chat transcript as JSON
- secure Markdown rendering for assistant output
- automated tests for UI state, identity persistence, crypto, transport, and Markdown safety
- a local real-browser E2E smoke flow for connect, streaming chat, reload persistence, and transcript export

Its largest current limitations are:

- no persisted local conversation history
- if IndexedDB is unavailable or blocked, identity falls back to page-memory only

## Document Map

| Document | Scope |
|----------|-------|
| `docs/web-client/architecture.md` | Runtime structure, module boundaries, state model |
| `docs/web-client/identity-and-storage.md` | `clientId`, keypair lifecycle, browser storage rules |
| `docs/web-client/transport.md` | Handshake, encryption, request/response, reconnect behavior |
| `docs/web-client/ui-and-state.md` | DOM structure, app state, user flows, rendering behavior |
| `docs/web-client/testing-and-troubleshooting.md` | Test coverage, manual checks, common failure patterns |
| `docs/web-client/manifest.json` | Machine-readable component manifest for the browser client |
| `docs/web-client/storage-schema.json` | Machine-readable browser storage contract |
| `docs/web-client/state-machine.json` | Machine-readable connection, request, UI, and identity state model |

## Quick Facts

| Topic | Current Behavior |
|-------|------------------|
| Runtime model | Plain browser modules loaded from `client/index.html` |
| Build step | None |
| LocalStorage | `openclaw-relay-settings` (`relayUrl`, `gatewayPubKey`, `selectedProfileId`, `selectedAgent`), `openclaw-relay-profiles` (saved relay profiles), and `openclaw-relay-client-id` (`clientId`) |
| IndexedDB | `openclaw-relay-browser` → `identity` store for the browser X25519 keypair |
| Never persisted to browser storage | `channelToken`, session keys, decrypted messages |
| Identity keypair | Loaded from IndexedDB on startup when available; otherwise created on first connect and then persisted if possible |
| Reload behavior | Reuses the same identity after full reload in the same browser profile unless the user resets it or persistence is unavailable |
| Identity file workflow | Export/import portable JSON identity files, with optional passphrase protection plus copyable fingerprint/public key helpers |
| Main transport class | `client/js/transport.js` → `RelayConnection` |
| Main crypto class | `client/js/crypto.js` → `RelayCrypto` |
| Identity store module | `client/js/identity-store.js` |
| App entry | `client/js/app.js` |
| Test command | `cd client && npm ci && npm test` for unit tests, `cd client && npm run test:e2e` for local browser E2E |

## Reading Order

Recommended reading order for engineers changing the browser client:

1. `docs/web-client/architecture.md`
2. `docs/web-client/identity-and-storage.md`
3. `docs/web-client/transport.md`
4. `docs/web-client/ui-and-state.md`
5. `docs/web-client/testing-and-troubleshooting.md`

For exact wire behavior, always fall through to:

- `protocol/layer0-channel.md`
- `protocol/layer1-security.md`
- `protocol/layer2-transport.md`
- `protocol/layer3-application.md`

## Source of Truth Rule

This document explains the current implementation. When this document conflicts with code, the code wins. When protocol behavior is in question, the protocol documents and machine-readable fixtures remain authoritative.

For browser-client-specific facts, the machine-readable companion sources are:

- `docs/web-client/manifest.json`
- `docs/web-client/storage-schema.json`
- `docs/web-client/state-machine.json`

If a browser-client Markdown explanation and one of these JSON files disagree about storage keys, module ownership, or state transitions, the JSON file should be treated as authoritative until the prose is corrected.
