# OpenClaw Relay Plugin

This package contains the OpenClaw Relay gateway plugin. Install it into your own OpenClaw runtime to expose your local gateway through an OpenClaw Relay server.

## Status

- Implemented and covered by CI tests
- Verified locally against a real OpenClaw runtime build
- Officially supported as part of `v0.3.1`
- Requires a current OpenClaw runtime with channel and CLI plugin APIs enabled

## What it provides

- Relay channel configuration and account management
- Layer 1 crypto and session establishment
- Layer 2 request / response / stream handling
- Pairing state and approved-client persistence
- CLI commands: `enable`, `pair`, `clients`, `revoke`, `disable`, `rotate-token`, `status`

## Install

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

## Enable and pair

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay enable --server wss://relay.example.com/ws --discoverable
openclaw relay pair --wait 30
openclaw relay status
```

Use `--discoverable` only when the operator explicitly wants this gateway to participate in the agent-only discovery layer. It does **not** enable any human-facing peer browsing UX.

## Manage clients

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

## Agent Discovery Boundary

The plugin now understands the relay's gateway-only Layer 0.5 control plane, but it keeps the product boundary strict:

- Human-facing clients still talk only to their own OpenClaw instance.
- Human-facing clients must not browse or contact other OpenClaw instances through this plugin.
- Operator opt-in for discoverability is controlled by `channels.relay.accounts.<id>.peerDiscovery.enabled` in the OpenClaw config.
- The plugin currently reuses the gateway X25519 identity as the discovery public key and advertises generated metadata based on gateway capabilities.
- Internal gateway-side methods exist for `discover`, `signal`, and `invite_create`, but higher-level OpenClaw agent policy is still being built on top.

## Runtime requirements

- Node.js `>=22`
- WebCrypto with X25519 support
- Go toolchain on `PATH` for the plugin integration test suite
- A current OpenClaw runtime build that exposes channel + CLI plugin APIs

## Development checks

```bash
cd plugin && npm ci
npm test
npm run typecheck
```

See `docs/plans/2026-03-08-gateway-plugin-design.md` for the design source and `docs/quick-start.md` for the short install flow.

## Smoke validation

For a real-host local smoke check:

```bash
cd plugin && npm run smoke
```

The smoke script uses an isolated OpenClaw state/config under `.tmp/`, starts a local relay, completes pairing, verifies a `system.status` request over the real relay path, then validates `revoke`, re-pair, `rotate-token`, and `disable` behavior.
