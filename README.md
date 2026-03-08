# OpenClaw Relay

An open-source, decentralized remote connection solution for OpenClaw.

Connect to your OpenClaw instance from anywhere — no public IP required, no third-party platform dependency, end-to-end encrypted.

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

## Project Status

The core relay stack (Go server, Python SDK, web client) is **implemented and tested**. The protocol specification, architecture design, and operational guides are also included.

v1 targets a **single relay node** deployment. Clustering, federation, and high-availability are explicitly out of scope.

## Components

| Component | Description | Status |
|-----------|-------------|--------|
| [Protocol Spec](protocol/) | Wire protocol specification | v1 |
| Relay Server (`relay/`) | Reference relay implementation (Go) | Implemented, tested |
| Python SDK (`sdk/python/`) | Client and gateway SDK | Implemented, tested |
| Reference Client (`client/`) | Browser-based web client | Implemented, tested |
| Cloudflare Worker (`deploy/cloudflare-worker/`) | Edge relay on Workers + Durable Objects | **Experimental** |
| JavaScript SDK (`sdk/js/`) | Protocol library for JS | Not yet implemented |
| OpenClaw Plugin (`plugin/`) | Gateway channel plugin | Not yet implemented |

> **Cloudflare Worker (Experimental):** The Worker deployment under `deploy/cloudflare-worker/` is an experimental alternative relay that runs on Cloudflare's edge network using Durable Objects. It uses **URL-based routing** (`?role=gateway&id=...`) instead of the standard in-band `register`/`join` protocol — standard SDK clients and the reference client **cannot connect to it directly**. It requires a purpose-built adapter. Do not use it in production.

## Quick Start

### Deploy a relay server

```bash
cd relay && go build -o openclaw-relay
./openclaw-relay --port 8080
```

See [Deployment Guide](docs/deployment.md) for TLS, origin validation, and production configuration.

### Run the Python SDK tests

```bash
cd sdk/python && pip install -e ".[dev]" && pytest -q
```

### Run the web client tests

```bash
cd client && npm ci && npm test
```

> **Planned (not yet runnable):** The `openclaw relay enable` CLI for zero-config gateway integration and the `openclaw relay pair` pairing flow depend on the gateway plugin (`plugin/`), which is not yet implemented. See `docs/technical-design.md` for the planned UX.

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
