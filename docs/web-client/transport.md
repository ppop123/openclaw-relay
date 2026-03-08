# Web Client Transport and Protocol Behavior

This document describes how the browser client implements Layers 0, 1, and 2.

## RelayConnection Responsibilities

`client/js/transport.js` implements a single class: `RelayConnection`.

It is responsible for:

- opening the WebSocket connection
- deriving `channelHash` from the bearer token
- issuing `join`
- loading or creating the browser identity keypair
- persisting or resetting that identity when needed
- running the Layer 1 handshake
- encrypting outgoing Layer 2 messages
- decrypting incoming encrypted `data` frames
- tracking pending requests and streams
- propagating relay errors to the application layer
- reconnecting with backoff and jitter

## Layer 0 Overview

### Outgoing Layer 0 frames

The browser client may send:

- `join`
- `data`
- `pong`

### Incoming Layer 0 frames

The browser client handles:

- `joined`
- `registered` (accepted but not used by the browser flow)
- `presence`
- `ping`
- `pong`
- `error`
- `data`

## Handshake Sequence

The current handshake is:

1. derive `channelHash = SHA-256(channelToken)`
2. open WebSocket to the relay
3. send:
   - `type = "join"`
   - `channel = <channelHash>`
   - `version = 1`
   - `client_id = <persistent clientId>`
4. wait for `joined`
5. require `joined.gateway_online === true`
6. ensure a browser identity keypair exists:
   - restore it from IndexedDB if already persisted
   - otherwise generate a new one and persist it when possible
7. refresh the client session nonce for this connection
8. send plaintext Layer 1 `hello` inside a Layer 0 `data` frame
9. wait for plaintext `hello_ack`
10. verify `hello_ack.gateway_public_key === pinned gatewayPubKey`
11. derive the AES-GCM session key
12. mark the connection as encrypted and connected

## Layer 1 Details

### Browser identity reuse

Under normal browser conditions:

- the X25519 keypair is reused across reconnects
- the same X25519 keypair is restored across full page reloads in the same browser profile
- the client session nonce is refreshed per connection

Fallback behavior:

- if IndexedDB is unavailable or identity persistence fails, the page falls back to an in-memory identity keypair
- in that fallback mode, reconnect still reuses the same keypair within the page session
- a full reload creates a new cryptographic identity again

### Session-key derivation

The browser client follows the shared Layer 1 v1 rules:

- X25519 ECDH
- HKDF-SHA256
- `salt = SHA256(client_pub || gateway_pub || client_nonce || gateway_nonce)`
- `info = "openclaw-relay-v1"`
- output key = AES-256-GCM session key

## Identity Control Operations

### Startup hydration

During `app.init()`, the transport attempts to hydrate an already-persisted browser identity from IndexedDB so the UI can display its status and fingerprint before connect.

### Identity reset

`RelayConnection.resetIdentity()`:

- disconnects any active session
- clears in-memory session state
- clears the in-memory identity keypair
- deletes the persisted IndexedDB identity record
- leaves `clientId`, `relayUrl`, and `gatewayPubKey` untouched

## Encrypted Data Path

Once `encrypted === true` and a session key exists:

- every outgoing Layer 2 message is encrypted before being wrapped in Layer 0 `data`
- every incoming Layer 0 `data` frame must decrypt successfully
- decryption failures are logged and dropped
- the browser does **not** fall back to plaintext parsing

This is critical for preserving end-to-end integrity.

## Layer 2 Request Lifecycle

### Non-streaming requests

`sendRequest(method, params)`:

1. generates a request id
2. creates a pending promise record with a 120s timeout
3. sends an encrypted Layer 2 `request`
4. waits for a `response`
5. resolves with `result` or rejects with `error`

### Streaming requests

`sendStreamRequest(method, params, onChunk)`:

1. generates a request id
2. creates a pending promise record with a 300s timeout
3. registers an active stream callback
4. sends an encrypted Layer 2 `request`
5. forwards each `stream_chunk` to `onChunk`
6. treats `stream_start` as a no-op and returns immediately
7. records `stream_end` as stream lifecycle only and does not resolve yet
8. resolves only when the final `response` arrives

This matches the current project-wide streaming contract.

## Incoming Frame Handling Matrix

| Frame / Payload | Browser Behavior |
|-----------------|------------------|
| `joined` | resolves handshake waiter |
| `presence` from gateway | emits UI toast for gateway offline/online transitions |
| `ping` | sends `pong` |
| relay `error` | rejects handshake waiters, data waiters, pending requests, clears active streams |
| `data` before encryption | parsed as plaintext JSON during handshake only |
| `data` after encryption | must decrypt; otherwise dropped |
| `response` | resolves or rejects pending request |
| `stream_chunk` | forwarded to registered chunk callback |
| `stream_end` | observed as stream lifecycle only; final completion still waits for `response` |
| `notify` | forwarded to `app.js` |

## Error Propagation Rules

The browser client intentionally treats several classes of failure differently.

### Relay errors

A Layer 0 `error` frame:

- surfaces a toast
- interrupts handshake waiters
- interrupts pending requests
- clears stream state

### Decryption failures

A decryption failure:

- is logged to the console
- drops the offending frame
- does not emit an application-level error response

This avoids creating an oracle for an attacker who can tamper with ciphertext.

### Identity persistence failures

An IndexedDB persistence failure:

- is logged to the console
- keeps the freshly generated identity in memory for the current page session
- surfaces a warning toast
- does not block the transport from connecting

### Request timeout

Each pending request owns its own timer:

- non-streaming default: 120 seconds
- streaming default: 300 seconds

Timeout removes the request from pending state and rejects the caller promise.

## Reconnect Behavior

Automatic reconnect happens only when:

- the connection was previously established
- the close was not user-initiated

Reconnect properties:

- starts at 1 second backoff
- doubles up to a maximum of 60 seconds
- adds a random positive jitter in the range `[0%, 25%)` of the current backoff
- resets backoff to 1 second after a successful connection
- shows toast updates during retry
- reuses the same `clientId`
- reuses the same long-lived X25519 identity keypair already loaded into memory
- derives a fresh session key after every successful reconnect

A user-triggered `disconnect()` disables reconnect.

## Protocol Invariants Specific to the Browser Client

1. `join` always includes `version = 1`.
2. `clientId` is stable across reloads unless the user manually clears browser storage.
3. after encryption is established, plaintext `data` is never accepted.
4. a mismatched gateway public key aborts the handshake.
5. streaming requests resolve on the final `response`, not on `stream_end`.
6. browser-generated request ids follow `msg_<8 lowercase hex>` via `generateMsgId()`.
7. browser identity reset is the only supported in-product way to intentionally rotate the web client's cryptographic identity.

## Related Reading

- `docs/web-client/identity-and-storage.md`
- `docs/web-client/ui-and-state.md`
- `protocol/layer0-channel.md`
- `protocol/layer1-security.md`
- `protocol/layer2-transport.md`
