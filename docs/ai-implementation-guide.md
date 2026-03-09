# AI Implementation Guide

This document states the facts an AI needs to correctly understand, implement against, or extend OpenClaw Relay. No interpretation required — if something is ambiguous, this document is wrong and should be fixed.

## Canonical Sources of Truth

| Fact | Source | Format |
|------|--------|--------|
| Component support status | `docs/support-matrix.json` | JSON |
| Release scope and security claims | `docs/release-manifest.json` | JSON |
| Protocol error codes | `protocol/error-codes.json` | JSON |
| Protocol frame examples | `protocol/examples/*.json` | JSON |
| Web client implementation manifest | `docs/web-client/manifest.json` | JSON |
| Web client storage contract | `docs/web-client/storage-schema.json` | JSON |
| Web client state model | `docs/web-client/state-machine.json` | JSON |
| Layer 0 spec (channel protocol) | `protocol/layer0-channel.md` | Markdown |
| Layer 1 spec (security) | `protocol/layer1-security.md` | Markdown |
| Layer 2 spec (transport) | `protocol/layer2-transport.md` | Markdown |
| Layer 3 spec (application) | `protocol/layer3-application.md` | Markdown |
| CLI flags and operational config | `docs/deployment.md` | Markdown |
| Security properties and limitations | `docs/security.md` | Markdown |

When a Markdown document and a JSON source disagree, the JSON source is authoritative.

## Mandatory OpenClaw Source-First Rule

When changing any code that depends on **OpenClaw runtime behavior**, do **not** guess from prose docs alone.

This is mandatory for work involving any of the following:

- gateway method shapes and request / response payloads
- plugin SDK behavior and runtime hooks
- session storage, transcript files, cron store, or agent routing
- local gateway process lifecycle, readiness, or restart behavior
- any `plugin/` implementation that adapts to OpenClaw internals

Required workflow:

1. Read the relevant local OpenClaw source first.
2. Use OpenClaw docs only as secondary guidance.
3. If OpenClaw docs and source disagree, treat the source as authoritative for implementation behavior.
4. If this repository's code or docs disagree with observed OpenClaw source behavior, update this repository to match the verified source behavior or explicitly document the compatibility boundary.

On this machine, one validated local OpenClaw source root is:

- `/opt/homebrew/lib/node_modules/openclaw/dist`

Do not hardcode that path into automation or docs for other machines. Verify the actual local install root first (for example by inspecting the installed `openclaw` package location or using the machine's package-manager metadata), then inspect that local source tree.

Do not implement OpenClaw-facing behavior from memory or assumption when the local source is available.

## Officially Supported Components

These are implemented, tested in CI, and covered by stability guarantees:

| Component | Path | Test Command |
|-----------|------|-------------|
| Go relay server | `relay/` | `cd relay && go test -v -count=1` |
| Python SDK (client-side only) | `sdk/python/` | `cd sdk/python && pip install -e '.[dev]' && pytest -q` |
| Web reference client | `client/` | `cd client && npm ci && npm test` |
| OpenClaw gateway plugin | `plugin/` | `cd plugin && npm ci && npm test && npm run typecheck` (requires `go` on PATH for integration test) |
| Protocol spec | `protocol/` | (no executable tests) |

## Not Yet Implemented

| Component | Path |
|-----------|------|
| JavaScript SDK | `sdk/js/` |

These directories may contain placeholder files. Do not treat them as functional.

## Security Properties — What v1 DOES and DOES NOT Guarantee

| Property | Status | Details |
|----------|--------|---------|
| Confidentiality | **Yes** | AES-256-GCM |
| Integrity | **Yes** | GCM authentication tag |
| Authenticity | **Yes** | User-supplied pinned gateway public-key verification during handshake |
| Forward secrecy | **No** | Static identity keypairs are reused across reconnects for the same long-lived identity. The browser reference client persists its keypair in IndexedDB when available, so it normally survives reconnects and page reloads within the same browser profile; if persistence is unavailable, it falls back to a temporary page-memory identity. Compromising an identity private key allows deriving all session keys for that identity (past and future). |
| Replay protection | **Yes** | Monotonic nonce counters with 64-message sliding window |
| Relay blindness | **Yes** | Relay sees only encrypted bytes and channel hash |

**Do not claim forward secrecy anywhere.** If you see it claimed in any document, that document is wrong.

## Protocol Invariants (Non-Negotiable)

1. Protocol version is **1**. Reject frames with `version > 1`.
2. Channel token is a **bearer secret** — never persist it to disk on the client side.
3. **Key model:** Static X25519 identity keypairs are reused across reconnects for the same long-lived client identity. Session key uniqueness comes from a fresh 32-byte random nonce generated by each side per connection, mixed into the HKDF salt. Do **not** generate a new keypair on reconnect. For the current browser reference client, do **not** generate a new keypair on a normal page reload when a persisted browser identity exists in IndexedDB; only identity reset or persistence failure should lead to a new browser identity.
4. Nonce structure: 12 bytes = `[4-byte direction][8-byte counter]`. Direction 1 = client→gateway, direction 2 = gateway→client.
5. Session key derivation: `HKDF-SHA256(ikm=ECDH_shared_secret, salt=SHA256(client_pub||gateway_pub||client_nonce||gateway_nonce), info="openclaw-relay-v1", len=32)`.
6. Decryption failures must be **silently dropped** — no error response (prevents information leakage).
7. After Layer 1 session key is established, **all DATA frame payloads MUST be encrypted**. Never fall back to plaintext.
8. The relay MUST NOT parse, modify, or persist DATA frame payloads.
9. Gateway identity verification in the browser client uses a user-supplied pinned public key — abort the handshake if `hello_ack.gateway_public_key` differs from the pinned value.

## Agent-to-Agent Discovery Boundary (Layer 0.5)

These facts are non-negotiable for AI agents implementing discovery or peer-contact features:

- `discover`, `discover_result`, `signal`, `signal_error`, `invite_create`, and `invite_created` are **relay-level gateway control frames**.
- Human-facing clients must **never** expose peer discovery, peer browsing, or peer-contact UX for other OpenClaw instances.
- Host-only agent automation may use the plugin's internal bridge and `RelayPeerAgentService`, but those flows must remain unavailable to relay remote clients.
- Any registered gateway may send `discover`; only gateways that registered with `discoverable: true` are returned in the peer list.
- Only a discoverable gateway may send `signal` or `invite_create`.
- Discovery responses may include only `public_key`, opaque `metadata`, and `online_since` — never `channel_hash` or `channel_token`.
- Peer establishment uses a short-lived invite alias in `JOIN.channel`, not the gateway's long-lived `channel_token`.

## `--allow-origin` CLI Flag

- **Type:** Single flag, comma-separated host patterns
- **Format:** Host patterns only (not full URLs)
- **Example:** `--allow-origin app.example.com,*.example.com`
- **Default:** Same-origin only + no-Origin (non-browser clients)
- **Implementation:** `nhooyr.io/websocket` `OriginPatterns` matching against `Origin` header's host via `path.Match` globs

## Release Gate

All commands in `docs/release-manifest.json` → `required_test_commands` where `blocks_release: true` must pass. Currently:

```bash
cd relay && go test -v -count=1
cd sdk/python && pip install -e '.[dev]' && pytest -q
cd client && npm ci && npm test
cd plugin && npm install && npm test
cd plugin && npm ci && npm run typecheck
```

Plugin tests and plugin type checking are part of the official release gate.
For local release-manager verification, run `bash scripts/smoke-openclaw-plugin.sh` to exercise plugin install → pairing → real gateway request → revoke → re-pair → rotate-token → disable over a local relay. This smoke flow is intentionally local/manual because hosted CI does not ship with an OpenClaw runtime.

## Implementation-Specific Notes

### Web Reference Client (`client/`)

The web client now persists its browser identity keypair in IndexedDB when available. During startup it may hydrate only the stored metadata for UI display; on connect it imports the persisted private key into runtime memory before the handshake. This means:

- The client normally sends the same `client_public_key` in HELLO across reconnects and normal page reloads in the same browser profile.
- A gateway implementing client identity pinning should therefore recognize the same browser identity across normal reloads.
- If IndexedDB is unavailable, blocked, or a persistence operation fails, the client falls back to a temporary page-memory identity for that page session only.
- User-triggered identity reset intentionally deletes the stored identity so the next connect presents a new `client_public_key`.

AI-specific implementation sources for the browser client are:

- `docs/web-client/manifest.json`
- `docs/web-client/storage-schema.json`
- `docs/web-client/state-machine.json`

Use these JSON files for browser module ownership, storage keys, and state transitions before relying on prose summaries.

### Python SDK (`sdk/python/`)

The Python SDK exports `RelayClient` — a **client-side** SDK only. It does not include gateway-side abstractions (accepting connections, responding to requests, managing paired clients). The `KeyPair` export allows callers to persist and restore identity keys across process restarts.

There is no gateway SDK. Implementing a gateway requires directly handling the Layer 0-2 protocol.

## Common Mistakes to Avoid

1. Do not guess OpenClaw-facing behavior from this repo's docs alone — inspect the local OpenClaw source first.
2. Do not claim forward secrecy — v1 does not have it.
3. Do not persist `channelToken` on the client — it is a bearer secret.
4. Do not use `--allow-origin` with full URLs — it takes host patterns only.
5. Do not fall back to plaintext after session key is established — this breaks E2E integrity.
6. Do not treat `docs/technical-design.md` code examples for the JS SDK as real — `sdk/js/` is still not implemented.
