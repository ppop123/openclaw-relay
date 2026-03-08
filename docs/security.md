# Security

## Relay Visibility

The relay is a **blind forwarder**. It cannot read, modify, or inspect the content of messages passing through it. All application data is end-to-end encrypted between the client and the gateway. The relay only sees:

- Channel hashes derived from channel tokens (SHA-256 routing identifiers)
- Client IDs (opaque identifiers for connection management)
- Frame metadata (direction, size)
- Encrypted ciphertext blobs

It does **not** see plaintext payloads, API keys, user prompts, model responses, or any application-layer data.

## Key Exchange and Session Key Derivation

The encryption pipeline uses:

1. **X25519 ECDH** -- Gateway and SDK identities use long-lived X25519 identity keypairs. The web reference client now persists its browser identity keypair in IndexedDB when available, so the same X25519 identity is reused across reconnects and normal page reloads in the same browser profile. If IndexedDB is unavailable or persistence fails, the browser falls back to a page-memory identity that is regenerated after reload. In every case, the shared secret is derived via Diffie-Hellman key agreement using the current long-lived identity keys for that client session.
2. **HKDF-SHA256** -- The shared secret is expanded into a 256-bit session key using HKDF with SHA-256. A fresh random session nonce from each side is mixed into the HKDF salt, ensuring a unique session key per connection.
3. **AES-256-GCM** -- All frames are encrypted and authenticated using AES-256-GCM with the derived session key.

The ECDH shared secret is the same across connections (static identity keys), but the session key is unique per connection because each side contributes a fresh 32-byte random nonce to the HKDF salt. A compromised session key does not affect other sessions. However, v1 does **not** provide forward secrecy — compromising an identity private key allows computing the shared secret and (combined with captured session nonces from HELLO/HELLO_ACK) deriving all past and future session keys.

## Nonce Structure

Each AES-256-GCM nonce is 12 bytes, structured as:

```
[4-byte direction][8-byte counter]
```

- **Direction**: `1` = client-to-gateway, `2` = gateway-to-client
- **Counter**: monotonically increasing, starting from 0 for each direction

The direction prefix prevents nonce reuse between the two communication directions, even if counters happen to match.

## Anti-Replay Protection

A **sliding window** of 64 counters is maintained per direction. Incoming frames are checked against this window:

- The first frame in each direction must use counter `0`.
- Frames with a counter below the window floor are rejected.
- Frames with a counter already seen within the window are rejected.
- Valid frames advance the window.

This prevents replay attacks without requiring strict in-order delivery.

## Fresh Session Keys

Every new connection generates:

- A fresh 32-byte random session nonce (mixed into the HKDF salt)
- A new AES-256-GCM session key derived from the static ECDH shared secret and the fresh nonces

Gateway and SDK identity keypairs are **static** and reused across connections. The browser reference client persists its identity keypair in IndexedDB when available, so it is reused across reconnects and normal reloads in the same browser profile. If persistence is unavailable, the browser falls back to a page-memory identity that is reused only until the page is reloaded. The session key is unique per connection because of the fresh nonces. If a session key is compromised, it cannot be used to decrypt other sessions (different nonces produce different keys). However, compromising an identity private key compromises all sessions derived from that identity — see the forward secrecy note above.

## Gateway Key Pinning

In the current web reference client, gateway public-key verification uses **user-supplied pinned gateway public-key verification**:

- The user enters the expected gateway public key in the connect form.
- The browser persists that pinned key in safe settings.
- On every handshake, the client verifies that `hello_ack.gateway_public_key` exactly matches the pinned value.
- If the key changes, the handshake is rejected as a potential MITM or misconfiguration.

This is stronger than automatic Trust On First Use because the browser client does not silently accept and store the first observed key. There is still no certificate authority or PKI layer; users who require stronger guarantees should verify the gateway public key through a separate trusted channel or through the pairing flow that produced the key.

## Browser Storage Policy

The web client stores only the minimum data needed for reconnection:

| Item | Stored | Reason |
|------|--------|--------|
| `relayUrl` | Yes | Needed to reconnect to the same relay |
| `gatewayPubKey` | Yes | Needed for pinned gateway public-key verification |
| `clientId` | Yes | Provides relay-level reconnection stability; it is not the cryptographic identity |
| `identityKeyPair` | **Yes, in IndexedDB when available** | Stored only in the dedicated IndexedDB identity store so the same browser identity can survive reconnects and normal page reloads. If IndexedDB is unavailable, the client falls back to page-memory only. |
| `channelToken` | **Never** | Bearer secret -- storing it would allow anyone with access to the browser storage to impersonate the user |

### Historical channelToken Migration

Older versions of the client may have persisted `channelToken` to local storage. On load, the current client automatically detects and **deletes** any saved `channelToken`. No user action is required.

## Gateway-Only Discovery Boundary

Layer 0.5 discovery and signaling are **gateway-scoped**, not human-scoped:

- Human-facing clients may talk only to their own OpenClaw instance. They must not discover, browse, or contact other OpenClaw instances through relay discovery or signaling.
- The relay may expose discoverable gateway public keys, opaque metadata, and online timestamps to other gateways, but it must never expose `channel_hash` or `channel_token` through this surface.
- Signal payloads remain opaque encrypted bytes to the relay.
- Invite aliases are short-lived, memory-only, and single-use in the MVP. The raw invite token must move only inside encrypted gateway-to-gateway signaling or another gateway-controlled secure channel.

This keeps the relay as an exchange for agents rather than a human social directory.

## Origin Validation

The relay validates the `Origin` header on incoming WebSocket upgrade requests:

- **Default behavior**: Only **same-origin** requests and requests with **no Origin header** (non-browser clients such as SDKs and CLI tools) are accepted. All other origins receive a `403 Forbidden` response.
- **Cross-origin access**: Use the `--allow-origin` flag to explicitly permit specific cross-origin hosts. Only listed origins will be allowed; all others remain blocked.

This prevents unauthorized browser-based clients from connecting to the relay while allowing SDK and CLI clients to connect freely.
