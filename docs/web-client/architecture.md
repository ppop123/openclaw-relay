# Web Client Architecture

This document describes the runtime structure of the browser reference client in `client/`.

## Runtime Model

The browser client is a **static HTML page plus ES modules**:

- `client/index.html` provides the DOM, styles, and module entry
- `client/js/app.js` is the browser application entry point
- there is no bundler, no framework, and no server-side rendering layer

The client is intentionally small and explicit so protocol behavior is easy to audit.

## Module Layout

| File | Responsibility |
|------|----------------|
| `client/index.html` | DOM structure, styles, module bootstrap |
| `client/js/app.js` | Application state, UI wiring, identity status rendering, settings persistence, chat flow |
| `client/js/transport.js` | WebSocket lifecycle, Layer 0 framing, Layer 1 handshake orchestration, Layer 2 request lifecycle, browser identity load/import/export/reset |
| `client/js/crypto.js` | X25519 key generation/import/export, fingerprinting, HKDF session-key derivation, AES-GCM encrypt/decrypt, replay tracking |
| `client/js/identity-store.js` | IndexedDB persistence for the browser identity keypair |
| `client/js/markdown.js` | Safe Markdown subset renderer for assistant output |
| `client/js/utils.js` | Small helpers for base64, ids, random values, buffer concatenation |

## Object Graph

At runtime the browser client is centered around four collaborating pieces:

```text
app (UI + state)
  └── RelayConnection (network + protocol)
        ├── RelayCrypto (key agreement + encryption)
        └── identity-store (IndexedDB persistence)
```

### `app`

`app` owns:

- DOM event handling
- settings load / save
- identity summary rendering
- agent list state
- current chat session id
- streaming text accumulation for the active assistant response
- status and toast display

### `RelayConnection`

`RelayConnection` owns:

- relay URL and derived `channelHash`
- persistent opaque `clientId`
- pinned gateway public key provided by the user
- browser identity lifecycle for transport use
- WebSocket lifecycle
- handshake sequencing
- pending request tracking
- active stream tracking
- reconnection backoff

### `RelayCrypto`

`RelayCrypto` owns:

- the browser-side X25519 identity keypair
- import / export of that identity for persistence
- the public-key fingerprint used by UI / pairing flows
- the current per-connection client nonce
- the current AES-GCM session key
- send and receive counters
- replay window bookkeeping
- decrypt-time counter validation used by transport drop/fail decisions

### `identity-store`

`identity-store.js` owns:

- IndexedDB database/schema initialization
- reading the persisted browser identity record
- writing the persisted browser identity record
- deleting the persisted browser identity record during reset

## Callback Boundaries

The transport layer is UI-agnostic. `RelayConnection` exports callbacks that `app.js` wires into the DOM:

| Callback | Set By | Meaning |
|----------|--------|---------|
| `onStateChange(state)` | `app.js` | Reflect connection state in the header and send button |
| `onNotify(event, data)` | `app.js` | Apply gateway `notify` events to UI state |
| `onToast(message, type)` | `app.js` | Surface relay / connection / reconnect / identity status |

This keeps protocol code out of DOM rendering logic.

## Connection State Model

The top-level state machine is intentionally simple:

```text
disconnected -> connecting -> connected
      ^             |            |
      |             v            v
      +-------- disconnected <---+
```

Important details:

- `state` becomes `connecting` before the WebSocket is opened
- `state` becomes `connected` only after the Layer 1 handshake succeeds
- encrypted application traffic is guarded by the separate `encrypted` flag
- reconnect transitions temporarily move back through `connecting`
- a user-initiated `disconnect()` marks the connection as closed and disables auto-reconnect
- identity reset reuses the same UI return-to-connect path as disconnect, then clears the persisted browser identity

## Data Ownership

| Concern | Owned By |
|---------|----------|
| DOM elements and chat rendering | `app.js` |
| Connection and frame handling | `transport.js` |
| Cryptographic session state and replay bookkeeping | `crypto.js` |
| IndexedDB identity persistence | `identity-store.js` |
| Decrypt failure handling and frame-drop policy | `transport.js` |
| Markdown rendering safety | `markdown.js` |
| Random ids / base64 helpers | `utils.js` |

## Deliberate Non-Features

The browser client deliberately does **not** try to do all of the following today:

- provide a reusable SDK surface for external applications
- maintain local message history across page refreshes
- implement background reconnect queues or offline drafts
- support multiple concurrent gateway profiles in one UI

Those are product features, not part of the current reference-client contract.

## Architectural Invariants

Any future refactor of the browser client must preserve these properties:

1. `transport.js` must remain usable without importing DOM code.
2. Once a session key exists, `data` frames must never fall back to plaintext parsing.
3. `channelToken` must never be written to browser storage.
4. The gateway public key used during handshake must be the pinned value supplied by the user.
5. `clientId` and the cryptographic identity keypair are different concepts and must not be conflated.
6. If the browser identity private key is persisted, it must not be written to `localStorage`; use the dedicated IndexedDB identity store.

## Related Reading

- `docs/web-client/identity-and-storage.md`
- `docs/web-client/transport.md`
- `docs/web-client/ui-and-state.md`
