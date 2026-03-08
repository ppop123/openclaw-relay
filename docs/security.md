# Security

## Relay Visibility

The relay is a **blind forwarder**. It cannot read, modify, or inspect the content of messages passing through it. All application data is end-to-end encrypted between the client and the gateway. The relay only sees:

- Channel tokens (opaque identifiers for routing)
- Client IDs (opaque identifiers for connection management)
- Frame metadata (direction, size)
- Encrypted ciphertext blobs

It does **not** see plaintext payloads, API keys, user prompts, model responses, or any application-layer data.

## Key Exchange and Session Key Derivation

The encryption pipeline uses:

1. **X25519 ECDH** -- Each side has a static X25519 identity keypair generated once during pairing. The shared secret is derived via Diffie-Hellman key agreement using these long-lived keys.
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

The identity keypairs are **static** (generated once during pairing, reused across connections). The session key is unique per connection because of the fresh nonces. If a session key is compromised, it cannot be used to decrypt other sessions (different nonces produce different keys). However, compromising an identity private key compromises all sessions — see the forward secrecy note above.

## TOFU (Trust On First Use)

Gateway public key verification follows the **Trust On First Use** model:

- On first connection, the client accepts the gateway's public key and stores it.
- On subsequent connections, the client verifies that the gateway presents the same public key.
- If the key changes, the client warns the user (potential MITM).

There is no certificate authority or out-of-band verification mechanism. Users who require stronger guarantees should verify the gateway public key through a separate trusted channel.

## Browser Storage Policy

The web client stores only the minimum data needed for reconnection:

| Item | Stored | Reason |
|------|--------|--------|
| `relayUrl` | Yes | Needed to reconnect to the same relay |
| `gatewayPubKey` | Yes | Needed for TOFU verification |
| `clientId` | Yes | Provides reconnection stability (same client identity) |
| `identityKeyPair` | **No** | Kept in-memory only. Lost on page reload; a new keypair is generated on next handshake. Production clients should persist to IndexedDB for stable cross-session identity. |
| `channelToken` | **Never** | Bearer secret -- storing it would allow anyone with access to the browser storage to impersonate the user |

### Historical channelToken Migration

Older versions of the client may have persisted `channelToken` to local storage. On load, the current client automatically detects and **deletes** any saved `channelToken`. No user action is required.

## Origin Validation

The relay validates the `Origin` header on incoming WebSocket upgrade requests:

- **Default behavior**: Only **same-origin** requests and requests with **no Origin header** (non-browser clients such as SDKs and CLI tools) are accepted. All other origins receive a `403 Forbidden` response.
- **Cross-origin access**: Use the `--allow-origin` flag to explicitly permit specific cross-origin hosts. Only listed origins will be allowed; all others remain blocked.

This prevents unauthorized browser-based clients from connecting to the relay while allowing SDK and CLI clients to connect freely.
