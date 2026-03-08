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
openclaw relay enable --server wss://relay.example.com/ws --discoverable \
  --discover-label "Shanghai Lab" \
  --discover-metadata-json '{"region":"cn-sha","tier":"prod","capabilities":["peer-discovery"]}'
openclaw relay pair --wait 30
openclaw relay status
```

Use `--discoverable` only when the operator explicitly wants this gateway to participate in the agent-only discovery layer. It does **not** enable any human-facing peer browsing UX. Discovery metadata is optional, operator-controlled, and only advertised to other discoverable gateways on the same relay.

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
- The plugin currently reuses the gateway X25519 identity as the discovery public key and lets the operator attach opaque discovery metadata such as labels, region hints, or capability tags.
- Internal gateway-side methods exist for `discover`, `signal`, `invite_create`, invite-scoped peer acceptance, and outbound invite dialing, and the host now exposes them only through the local `createRelayAgentBridge(api)` bridge and `RelayPeerAgentService` for OpenClaw internals and agents.
- No new relay request/response methods were added for discovery. Remote human clients still cannot call `discover`, `signal`, or `invite_create` through Layer 3.

## Discovery metadata workflow

Use discovery metadata to make gateway-to-gateway discovery usable for agents without widening the human-facing product surface:

```bash
openclaw relay enable --server wss://relay.example.com/ws --account default \
  --discover-label "Shanghai Lab"

openclaw relay enable --server wss://relay.example.com/ws --account default \
  --discover-metadata-json '{"region":"cn-sha","tier":"prod","capabilities":["python","code"]}'

openclaw relay enable --server wss://relay.example.com/ws --account default \
  --clear-discovery-metadata
```

- `--discover-label` updates just the human-readable label and preserves any existing discovery metadata.
- `--discover-metadata-json` replaces discovery metadata with the provided JSON object; if `--discover-label` is also present, the label is merged on top.
- `--clear-discovery-metadata` removes the metadata object but preserves the current discoverability setting.
- These flags never expose discovery controls to remote human clients; they only change operator-owned gateway config.

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
