# Web Client Testing and Troubleshooting

This document explains how the browser client is tested today and how to reason about common failures.

## Automated Test Coverage

The browser client uses `vitest`.

| Test File | Focus |
|-----------|-------|
| `client/tests/markdown.test.js` | HTML escaping, safe links, XSS resistance, Markdown formatting |
| `client/tests/crypto.test.js` | Real `RelayCrypto`, identity import/export, fingerprinting, key derivation, encrypt/decrypt, replay rules, direction checks |
| `client/tests/identity-store.test.js` | IndexedDB identity persistence layout and CRUD behavior |
| `client/tests/identity-bundle.test.js` | Passphrase-protected identity-file encryption and decryption |
| `client/tests/transport.test.js` | Real `RelayConnection` frame handling, identity lifecycle, pending request lifecycle, relay error propagation, stream semantics |
| `client/tests/app.test.js` | Settings migration, storage safety, identity UI status, `channelToken` stripping |

Run the full browser-client test suite with:

```bash
cd client && npm ci && npm test
```

## What the Tests Prove

The current test suite is strongest at these guarantees:

- `channelToken` is not persisted
- saved relay profiles persist only non-secret connection settings
- historical stored `channelToken` is cleaned on startup
- browser identity export and import actions preserve the expected fingerprint
- passphrase-protected identity exports decrypt only with the correct passphrase
- persisted identity storage uses the expected IndexedDB layout
- transport falls back to page-memory identity if persistence fails
- encrypted data is not allowed to fall back to plaintext parsing
- wrong nonce direction is rejected
- replay and duplicate counters are rejected
- relay `error` interrupts pending requests and waiters
- streaming resolves only on the final `response`
- Markdown rendering blocks common injection vectors

## What the Tests Do Not Fully Prove

Current automated tests do **not** fully cover:

- a real browser-driven end-to-end handshake against a live relay in hosted CI
- user interaction timing in a real DOM renderer
- browser-policy edge cases where IndexedDB is disabled or quota-limited in unusual ways
- multi-tab coordination, because the client is designed as a single-page reference client

## Manual Verification Checklist

When validating the web client manually, check the following:

1. page loads and form fields render correctly
2. saved `relayUrl` and `gatewayPubKey` restore correctly
3. saving a relay profile persists only profile name, relay URL, and gateway public key
4. selecting a saved profile repopulates the form without restoring `channelToken`
5. `channelToken` does not restore after refresh
6. identity card shows whether a browser identity is already available
7. connect succeeds against a live gateway
8. the diagnostics bar shows session/client/profile/gateway context after connect
9. `agents.list` populates the selector
10. `chat.send` streams chunks and final text renders correctly
11. `New Chat` clears the local transcript and resets `sessionId` without disconnecting
12. disconnect returns the UI to connect mode
13. reconnect after transient relay loss restores chat functionality
14. gateway public-key mismatch is rejected
15. exporting the current identity with a passphrase downloads an encrypted JSON file successfully
16. importing that protected file with the same passphrase restores the expected fingerprint
17. exporting without a passphrase shows a confirmation warning
18. full page reload preserves the same client fingerprint when IndexedDB is available
19. identity reset causes the next connect to present a different client fingerprint

## Common Failure Patterns

### `WebSocket connection failed`

Likely causes:

- bad relay URL
- relay not running
- browser origin blocked by relay origin policy
- TLS / certificate failure on the relay endpoint

Check:

- relay address
- browser console
- relay deployment flags in `docs/deployment.md`

### `Gateway is offline`

The browser reached the relay, but the relay reported no active gateway registration for the channel.

Check:

- the gateway plugin is running
- the gateway uses the same channel token
- pairing and relay enable flow completed successfully

### `SECURITY WARNING: Gateway public key does not match`

The browser received a `hello_ack` with a gateway public key that differs from the pinned key.

Possible causes:

- wrong key pasted into the browser
- gateway identity rotated
- wrong relay / token pairing data
- real security issue requiring investigation

Do not ignore this mismatch.

### `Browser identity could not be persisted`

The browser generated a new identity keypair, but the IndexedDB write failed.

Possible causes:

- IndexedDB disabled by browser policy or private mode restrictions
- quota / storage permission issue
- browser-specific IndexedDB error

Effect:

- the current page session can still connect successfully
- reconnect continues to use the same in-memory identity
- a full reload will create a new client fingerprint again

### `Failed to import identity: ...`

The selected identity file was malformed, unsupported, or did not match the supplied key material.

Possible causes:

- invalid JSON
- missing `publicKey` / `privateKeyPkcs8` fields
- unsupported file format or future version
- hand-edited or corrupted export file
- missing or incorrect passphrase for a protected export

Effect:

- the existing browser identity stays unchanged
- the UI remains on the connect panel

### `Stored browser identity was invalid and has been reset`

The persisted identity record existed, but import/validation failed on load.

Possible causes:

- old or corrupted browser storage
- manual tampering in dev tools
- incompatible local experiment build

Effect:

- the stored identity is deleted
- the next connect will create a brand-new identity

### `Failed to fetch agents`

The connection is up, but `agents.list` failed.

Likely causes:

- gateway-side runtime issue
- transport error propagated from the plugin
- plugin is connected but not routing successfully into the OpenClaw runtime

Check gateway logs and plugin status.

### `Request timeout` or `Stream timeout`

The request was accepted locally but no final response arrived before timeout.

Possible causes:

- gateway lost connection mid-request
- runtime handler stalled
- stream never emitted final `response`
- relay error was not visible in UI because only the timeout surfaced to the user

Check browser console, relay logs, and gateway/plugin logs together.

### Decrypt failures in console

A console line like `Failed to decrypt data frame (dropping)` indicates an incoming encrypted payload was rejected.

Possible causes:

- corrupted or tampered ciphertext
- wrong session key due to handshake mismatch
- replay or duplicate counter
- protocol implementation bug

The browser intentionally drops these frames silently at the protocol level.

## Browser-Specific Operational Notes

- The browser client is a static module app; there is no build pipeline to debug.
- Relay URL normalization appends `/ws` when the user omits it.
- The send button is disabled unless the client is connected and the message input is non-empty.
- A full page reload preserves both `clientId` and the cryptographic identity keypair when IndexedDB is available.
- Clearing browser site data removes the persisted identity and forces the next connect to create a new one.

## When to Change Tests

If you touch any of the following, update or add tests in the corresponding suite:

| Change Area | Test Suite |
|-------------|------------|
| storage keys / migration / identity UI | `client/tests/app.test.js` |
| key derivation / nonce / replay / identity import-export | `client/tests/crypto.test.js` |
| IndexedDB identity persistence | `client/tests/identity-store.test.js` |
| request / response / stream flow / identity lifecycle | `client/tests/transport.test.js` |
| HTML / Markdown rendering | `client/tests/markdown.test.js` |

Keep tests pointed at the real exported modules. Do not replace production logic with test-local reimplementations.
