# Web Client Identity and Storage

This document explains how the browser client currently models identity, what it stores, and what it explicitly refuses to store.

## Identity Concepts

The browser client uses several identifiers that must not be confused with each other.

| Name | Where It Lives | Purpose |
|------|----------------|---------|
| `clientId` | `localStorage` | Stable opaque client label for relay-level reconnection and presence |
| identity keypair | IndexedDB + runtime memory | Layer 1 cryptographic client identity used in `hello` |
| identity fingerprint | derived from the public key | Stable user-visible summary of the cryptographic identity |
| `gatewayPubKey` | persisted settings | Pinned expected gateway X25519 public key |
| `channelToken` | connect-form input + runtime memory | Bearer secret used to derive `channelHash`; retained in `RelayConnection.channelToken` for the active connection lifecycle |
| `channelHash` | memory only | SHA-256 of `channelToken`, used in Layer 0 frames |

## Persistent Browser Storage

The browser uses two storage backends.

### `localStorage`

The browser uses two `localStorage` keys:

#### `openclaw-relay-settings`

JSON object containing only non-secret fields:

- `relayUrl`
- `gatewayPubKey`

#### `openclaw-relay-client-id`

String value used as the stable relay-side client identifier.

### IndexedDB

The browser stores the long-lived cryptographic identity in:

- database: `openclaw-relay-browser`
- object store: `identity`
- record id: `default`

The stored identity record contains:

- public key
- private key (`pkcs8`-encoded, base64)
- fingerprint
- creation/update timestamps
- storage-format metadata

## What Is Never Stored

The browser client intentionally never persists:

- `channelToken`
- session keys
- decrypted chat history
- replay-window state
- per-connection nonces
- identity private key in `localStorage`

## Historical Migration Behavior

Older iterations could leave `channelToken` inside saved settings.

On startup, `app.init()`:

1. loads `openclaw-relay-settings`
2. checks for a legacy `channelToken`
3. deletes it if present
4. writes back the sanitized object

This means old browser state is cleaned automatically.

## Current Identity Lifecycle

### First connect in a fresh browser profile

- `RelayConnection` loads or creates a persistent `clientId`
- if no stored identity exists, `RelayCrypto.generateKeyPair()` creates a new X25519 keypair
- the new identity is persisted to IndexedDB when available
- a fresh 32-byte client nonce is generated
- the public key is sent inside Layer 1 `hello`

### Reconnect within the same page session

- the same `clientId` is reused
- the same X25519 identity keypair is reused
- a fresh client nonce is generated via `regenerateNonce()`
- a new per-connection session key is derived

### Full page reload in the same browser profile

- the same `clientId` is reused
- the persisted X25519 identity keypair is reloaded from IndexedDB
- the same cryptographic identity fingerprint remains stable
- a fresh client nonce is generated for the new connection

### Identity reset

- the user may delete the stored browser identity from the connect panel
- reset disconnects any active session first
- the next connect creates a brand-new X25519 identity keypair

### Persistence-unavailable fallback

If IndexedDB is unavailable or the write fails:

- the browser still creates an in-memory X25519 identity keypair
- reconnect inside the same page session still reuses that keypair
- a full reload generates a new cryptographic identity again

## `clientId` vs Cryptographic Identity

`clientId` is **not** the same thing as the cryptographic identity.

- `clientId` is a relay-facing, persistent opaque label
- the X25519 keypair is the Layer 1 identity presented to the gateway

Operational consequence:

- after a normal page reload with working IndexedDB, the relay still sees the same `clientId`
- and the gateway also sees the same `client_public_key`
- a gateway that pins approved client public keys therefore recognizes the same browser identity across reloads
- only identity reset or storage failure should produce a new browser client fingerprint

## Gateway Key Pinning

The current browser client does not perform automatic “accept first key and save it” behavior.

Instead:

- the user provides a `gatewayPubKey` in the connect form
- the browser persists that pinned key in safe settings
- the handshake refuses any `hello_ack` carrying a different gateway public key

So in the current implementation the browser uses **user-supplied pinned gateway public-key verification**, not automatic TOFU.

## Storage Security Rules

The browser client must continue to follow all of these rules:

1. never persist `channelToken`
2. never persist the current session key
3. never persist decrypted relay traffic as part of transport state
4. treat `gatewayPubKey` as safe-to-store, but security-relevant
5. treat `clientId` as persistent, but non-secret
6. keep the identity private key out of `localStorage`; if persisted, store it only in the IndexedDB identity store

## Current Operational Limits

The current identity model is much stronger than the old page-memory-only behavior, but it still has limits:

- there is no identity export / import workflow yet
- moving the browser client between machines still creates a different cryptographic identity
- clearing browser site data deletes the stored identity
- if the browser blocks IndexedDB, identity persistence falls back to page memory only

## Recommended Future Direction

A future product-grade browser client should additionally support:

- explicit identity export / import for advanced users
- richer fingerprint presentation / QR display
- multi-profile identity management
- browser-specific recovery flows when IndexedDB is disabled by policy

That work does not exist yet; this document describes the current implementation only.
