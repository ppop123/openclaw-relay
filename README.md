# OpenClaw Relay

An open-source, decentralized remote connection solution for OpenClaw.

Connect to your OpenClaw instance from anywhere — no public IP required, no third-party platform dependency, end-to-end encrypted.

> **AI-first project.** All code in this repository was written by [Claude Code](https://claude.ai/code) and reviewed by [Codex](https://openai.com/codex). The project is designed to be unambiguously consumable by AI agents — with machine-readable truth sources, structured protocol fixtures, and documentation that prioritizes precision over prose. See [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md).

## The Problem

OpenClaw typically runs on a local machine behind NAT. Users currently rely on third-party chat platforms (Feishu, Telegram, Discord) to interact with their agents remotely. This creates platform dependency and limits what you can do to plain text messaging.

## The Solution

OpenClaw Relay provides a simple, secure tunnel between any client and your OpenClaw gateway:

```
[Client]  ──WSS──>  [Relay]  <──WSS──  [OpenClaw Gateway]
  (anywhere)        (public)           (your local machine)
```

Both sides connect **outbound** — no port forwarding, no public IP, no DNS setup. All messages are **end-to-end encrypted** — the relay only sees opaque bytes.

## Key Principles

- **No vendor lock-in**: Relay is trivially self-hostable (single binary, no database)
- **No official service**: Community members can run public relays; a curated list is maintained in this repo
- **E2E encrypted**: Relay operators cannot read your messages
- **Open protocol**: Anyone can build alternative clients or relay implementations
- **Extensible**: The reference client is a starting point — build your own

## Latest Release / 最新发布

`OpenClaw Relay v0.2.0` is now available. / `OpenClaw Relay v0.2.0` 已发布。

Official release scope / 正式支持范围：

- `relay/` — Go relay server
- `sdk/python/` — Python client SDK (Layers 0–2)
- `client/` — Web reference client
- `protocol/` — Protocol docs and canonical fixtures
- `plugin/` — OpenClaw gateway plugin

Excluded from official release scope / 不在正式发布范围内：

- `deploy/cloudflare-worker/` — Experimental
- `sdk/js/` — Not yet implemented

Release notes / 发布说明：

- 中文：[`docs/releases/v0.2.0-github-release.zh-CN.md`](docs/releases/v0.2.0-github-release.zh-CN.md)
- English: [`docs/releases/v0.2.0-github-release.en.md`](docs/releases/v0.2.0-github-release.en.md)

## Project Status

The core relay stack (Go server, Python SDK, web client), the OpenClaw gateway plugin, and the protocol specification are **implemented and tested**. Architecture design and operational guides are also included.

v1 targets a **single relay node** deployment. Clustering, federation, and high-availability are explicitly out of scope.

## Components

| Component | Description | Status |
|-----------|-------------|--------|
| [Protocol Spec](protocol/) | Wire protocol specification | v1 |
| Relay Server (`relay/`) | Reference relay implementation (Go) | Implemented, tested |
| Python SDK (`sdk/python/`) | Client SDK (protocol layers 0-2) | Implemented, tested |
| Reference Client (`client/`) | Browser-based web client | Implemented, tested |
| Cloudflare Worker (`deploy/cloudflare-worker/`) | Edge relay on Workers + Durable Objects | **Experimental** |
| JavaScript SDK (`sdk/js/`) | Protocol library for JS | Not yet implemented |
| OpenClaw Plugin (`plugin/`) | Gateway channel plugin | Implemented, tested |

> **Cloudflare Worker (Experimental):** The Worker deployment under `deploy/cloudflare-worker/` is an experimental alternative relay that runs on Cloudflare's edge network using Durable Objects. It uses **URL-based routing** (`?role=gateway&id=...`) instead of the standard in-band `register`/`join` protocol — standard SDK clients and the reference client **cannot connect to it directly**. It requires a purpose-built adapter. Do not use it in production.

## Quick Start

### Deploy a relay server

```bash
cd relay && go build -o openclaw-relay
./openclaw-relay
# Listens on :8443 by default
```

See [Deployment Guide](docs/deployment.md) for TLS, origin validation, and production configuration.

### Run tests

```bash
cd relay && go test -v -count=1         # Go relay
cd sdk/python && pip install -e ".[dev]" && pytest -q  # Python SDK
cd client && npm ci && npm test          # Web client
cd client && npm ci && cd .. && client/node_modules/.bin/vitest run plugin/tests  # OpenClaw plugin
cd deploy/cloudflare-worker && npm ci && cd ../.. && deploy/cloudflare-worker/node_modules/.bin/tsc -p plugin/tsconfig.json --noEmit  # Plugin typecheck
bash scripts/smoke-openclaw-plugin.sh  # OpenClaw plugin real-host smoke (local/manual)
```

> **Gateway plugin:** Install `plugin/` into your own OpenClaw runtime with `openclaw plugins install --link /path/to/openclaw-relay/plugin`, then run `openclaw relay enable --server <relay>` and `openclaw relay pair --wait 30`. See [Quick Start Guide](docs/quick-start.md).

### Contribute a public relay

Run a relay with `--public`, ensure `/status` is accessible, and submit a PR to add it to [`relays.json`](relays.json).

## Architecture

```
                   E2E Encrypted (relay cannot read)
              ╔══════════════════════════════════════╗
              ║  App Protocol (JSON-RPC, streaming)  ║
              ║  Security Layer (X25519 + AES-GCM)   ║
              ╚══════════════════════════════════════╝
                          │            │
  [Client] ──WSS──> [Relay Server] <──WSS── [OpenClaw Gateway]
                          │
                    Relay only sees:
                    • channel token hash
                    • encrypted payload
                    • online/offline status
```

## Public Relay Nodes

See [`relays.json`](relays.json) for the current list of community-operated public relays.

To add your relay: ensure it passes the health check (`GET /status`), then submit a PR.

## License

MIT
