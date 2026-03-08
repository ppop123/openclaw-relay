# AI Implementation Guide

This document states the facts an AI needs to correctly understand, implement against, or extend OpenClaw Relay. No interpretation required — if something is ambiguous, this document is wrong and should be fixed.

## Canonical Sources of Truth

| Fact | Source | Format |
|------|--------|--------|
| Component support status | `docs/support-matrix.json` | JSON |
| Release scope and security claims | `docs/release-manifest.json` | JSON |
| Protocol error codes | `protocol/error-codes.json` | JSON |
| Protocol frame examples | `protocol/examples/*.json` | JSON |
| Layer 0 spec (channel protocol) | `protocol/layer0-channel.md` | Markdown |
| Layer 1 spec (security) | `protocol/layer1-security.md` | Markdown |
| Layer 2 spec (transport) | `protocol/layer2-transport.md` | Markdown |
| Layer 3 spec (application) | `protocol/layer3-application.md` | Markdown |
| CLI flags and operational config | `docs/deployment.md` | Markdown |
| Security properties and limitations | `docs/security.md` | Markdown |

When a Markdown document and a JSON source disagree, the JSON source is authoritative.

## Officially Supported Components

These are implemented, tested in CI, and covered by stability guarantees:

| Component | Path | Test Command |
|-----------|------|-------------|
| Go relay server | `relay/` | `cd relay && go test -v -count=1` |
| Python SDK | `sdk/python/` | `cd sdk/python && pip install -e '.[dev]' && pytest -q` |
| Web reference client | `client/` | `cd client && npm ci && npm test` |
| Protocol spec | `protocol/` | (no executable tests) |

## Experimental (NOT Officially Supported)

| Component | Path | Why Excluded |
|-----------|------|-------------|
| Cloudflare Worker | `deploy/cloudflare-worker/` | Incompatible routing model (URL-based, not frame-based). Standard clients cannot connect. No runtime tests. Wide-open CORS. Not security-reviewed. |

## Not Yet Implemented

| Component | Path |
|-----------|------|
| JavaScript SDK | `sdk/js/` |
| OpenClaw gateway plugin | `plugin/` |

These directories may contain placeholder files. Do not treat them as functional.

## Security Properties — What v1 DOES and DOES NOT Guarantee

| Property | Status | Details |
|----------|--------|---------|
| Confidentiality | **Yes** | AES-256-GCM |
| Integrity | **Yes** | GCM authentication tag |
| Authenticity | **Yes** | TOFU identity pinning at pairing |
| Forward secrecy | **No** | Static identity keys during pairing. Compromising them allows decryption of future sessions. |
| Replay protection | **Yes** | Monotonic nonce counters with 64-message sliding window |
| Relay blindness | **Yes** | Relay sees only encrypted bytes and channel hash |

**Do not claim forward secrecy anywhere.** If you see it claimed in any document, that document is wrong.

## Protocol Invariants (Non-Negotiable)

1. Protocol version is **1**. Reject frames with `version > 1`.
2. Channel token is a **bearer secret** — never persist it to disk on the client side.
3. Nonce structure: 12 bytes = `[4-byte direction][8-byte counter]`. Direction 1 = client→gateway, direction 2 = gateway→client.
4. Session key derivation: `HKDF-SHA256(ikm=ECDH_shared_secret, salt=SHA256(client_pub||gateway_pub||client_nonce||gateway_nonce), info="openclaw-relay-v1", len=32)`.
5. Decryption failures must be **silently dropped** — no error response (prevents information leakage).
6. After Layer 1 session key is established, **all DATA frame payloads MUST be encrypted**. Never fall back to plaintext.
7. The relay MUST NOT parse, modify, or persist DATA frame payloads.
8. Gateway identity verification follows TOFU — abort connection if public key changes unexpectedly.

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
```

The Worker type check (`tsc --noEmit`) is informational and does not block release.

## Common Mistakes to Avoid

1. Do not claim the Worker is compatible with standard clients — it uses a different routing model.
2. Do not claim forward secrecy — v1 does not have it.
3. Do not persist `channelToken` on the client — it is a bearer secret.
4. Do not use `--allow-origin` with full URLs — it takes host patterns only.
5. Do not fall back to plaintext after session key is established — this breaks E2E integrity.
6. Do not treat `docs/technical-design.md` code examples for JS SDK or gateway plugin as real — those components are not yet implemented.
