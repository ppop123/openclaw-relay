# OpenClaw Relay Plugin

This package contains the OpenClaw Relay gateway plugin. Install it into your own OpenClaw runtime to expose your local gateway through an OpenClaw Relay server.

## Status

- Implemented and covered by CI tests
- Verified locally against a real OpenClaw runtime build
- Officially supported as part of `v0.1.0`
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
openclaw relay pair --wait 30
openclaw relay status
```

## Manage clients

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

## Runtime requirements

- Node.js `>=22`
- WebCrypto with X25519 support
- A current OpenClaw runtime build that exposes channel + CLI plugin APIs

## Development checks

```bash
cd client && npm ci && cd .. && client/node_modules/.bin/vitest run plugin/tests
cd deploy/cloudflare-worker && npm ci && cd ../.. && deploy/cloudflare-worker/node_modules/.bin/tsc -p plugin/tsconfig.json --noEmit
```

See `docs/plans/2026-03-08-gateway-plugin-design.md` for the design source and `docs/quick-start.md` for the short install flow.
