# Technical Design Document

> This document describes the architecture of OpenClaw Relay. The core stack (Go relay server, Python SDK, web reference client) is implemented and tested. Details may evolve as the project matures.

## 1. Project Overview

OpenClaw Relay is an open-source system that enables remote access to OpenClaw instances behind NAT, without relying on third-party chat platforms.

v1 targets a **single relay node** deployment. Clustering, federation, and high-availability are explicitly out of scope for v1.

### Goals

- Replace Feishu/Telegram/Discord dependency for OpenClaw remote interaction
- End-to-end encrypted — relay operators cannot read user data
- Trivially self-hostable relay (single binary, no database)
- Public relay discovery via community-curated list
- Extensible reference client that users can customize

### Non-Goals

- Not a managed service (no official relay)
- Not a full-featured product (client is a reference implementation)
- Not a replacement for OpenClaw itself (no AI logic in relay or client)

### Non-Functional Requirements (v1 Targets)

| Requirement | Target |
|-------------|--------|
| Concurrent channels per relay | 500 |
| Clients per channel | 10 |
| Message throughput per channel | 100 msg/s |
| Maximum payload size | 1 MB |
| Relay restart recovery | Clients reconnect within 60s (exponential backoff) |
| Memory per channel | ~10 KB |
| Base memory footprint | ~50 MB |
| /status response time | < 100ms |

### Architectural Constraints

- v1 targets a **single relay node** per deployment. Horizontal clustering and shared relay state are intentionally out of scope for the first implementation.
- **End-to-end encryption, explicit pairing, and per-connection session key uniqueness are MVP requirements**, not later enhancements.
- The gateway only accepts a new client key during an explicit **pairing mode** initiated by the user; outside pairing mode, unknown client keys are rejected.
- Public relay discovery must survive registry fetch failures by using a cached last-known-good list and optional mirror URLs.

### Non-Functional Targets

| Area | v1 Target |
|------|-----------|
| Security | Relay cannot decrypt application traffic; every connection derives a fresh session key |
| Availability | Existing sessions may break on relay restart; clients should reconnect automatically within 10 seconds |
| Capacity | One relay instance supports up to 500 active channels and 10 clients per channel |
| Operability | Structured logs, `/status`, rate limits, payload limits, and health monitoring are mandatory |
| Evolvability | Protocol layers remain separable so future SDKs and custom clients can reuse the same contract |

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Client App                            │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │  Connection Mgr    │    │      Application UI          │ │
│  │                    │    │                              │ │
│  │  ┌──────┐ ┌─────┐ │    │  Chat, Agents, Sessions,    │ │
│  │  │Direct│ │Relay│ │    │  Cron, Files, ...            │ │
│  │  │(LAN) │ │(WAN)│ │    │  (users customize this)     │ │
│  │  └──────┘ └─────┘ │    └──────────────────────────────┘ │
│  └────────────────────┘                                      │
└──────────────┬───────────────────────────────────────────────┘
               │
               │  WSS (or direct local transport with the same Layer 1 security model)
               │
┌──────────────▼───────────────┐
│        Relay Server          │
│                              │
│  • Channel matching (by      │
│    token hash)               │
│  • Presence tracking         │
│  • Heartbeat                 │
│  • Rate limiting             │
│  • Structured logging        │
│  • Abuse controls            │
│  • /status health endpoint   │
│                              │
│  Does NOT:                   │
│  • Parse message content     │
│  • Store any data to disk    │
│  • Require a database        │
│  • Know about agents/chat    │
└──────────────┬───────────────┘
               │  WSS
               │
┌──────────────▼───────────────────────────────────────────────┐
│                     OpenClaw Gateway                          │
│                                                              │
│  ┌────────────────────────────────────────┐                  │
│  │         Relay Channel Plugin           │                  │
│  │                                        │                  │
│  │  • Connects outbound to relay          │                  │
│  │  • E2E encryption / decryption         │                  │
│  │  • Translates relay protocol to        │                  │
│  │    gateway API calls                   │                  │
│  │  • Sends notifications to clients      │                  │
│  └────────────────┬───────────────────────┘                  │
│                   │  localhost HTTP                           │
│  ┌────────────────▼───────────────────────┐                  │
│  │        Gateway API (unchanged)         │                  │
│  └────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

## 3. Component Specifications

### 3.1 Relay Server

**Language**: Go (single static binary, cross-compile for all platforms)

**Dependencies**: Standard library only (net/http, crypto/tls, nhooyr.io/websocket)

**Deployment options**:
- Single binary: `./openclaw-relay --tls auto --domain relay.example.com`
- Docker: `docker run -p 443:443 ghcr.io/openclaw/relay`
- Systemd unit file provided

**Configuration** (CLI flags only, no config file):

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 8443 | Listen port |
| `--tls` | off | TLS mode: `off`, `auto` (ACME/Let's Encrypt), or `manual` |
| `--cert` | — | TLS cert path (when `--tls manual`) |
| `--key` | — | TLS key path (when `--tls manual`) |
| `--max-channels` | 500 | Maximum concurrent channels |
| `--max-clients-per-channel` | 10 | Maximum clients per channel |
| `--rate-limit` | 100 | Messages per second per channel |
| `--max-payload` | 1048576 | Maximum payload size in bytes (1 MB) |
| `--public` | false | Advertise in /status as a public relay |
| `--domain` | — | Domain name (for ACME TLS) |
| `--log-format` | `text` | Log format: `text` or `json` |

**Internal state** (all in-memory, lost on restart):

```go
type Relay struct {
    channels map[string]*Channel  // key: channel_hash
}

type Channel struct {
    gateway *websocket.Conn
    clients map[string]*websocket.Conn  // key: client_id
}
```

**Estimated code size**: 300-500 lines of Go.

### 3.2 OpenClaw Channel Plugin

**Integration**: Follows the same pattern as the Feishu channel plugin — registers as a channel, receives messages from the gateway message bus, sends replies back.

**Responsibilities**:
1. On startup: connect to relay (specified or auto-discovered)
2. Register channel with token hash
3. Handle E2E encryption (Layer 1)
4. Enter pairing mode when the user runs `openclaw relay pair`, approve exactly one new client key, and persist the approved client record
5. Translate incoming relay requests to gateway API calls
6. Send gateway events (cron completions, agent outputs) as notifications to connected clients

**Configuration** (in `openclaw.json`):

```json5
{
  channels: {
    relay: {
      enabled: true,
      // Explicit relay server (optional — auto-discover if omitted)
      server: "wss://my-relay.example.com",
      // Generated on first enable
      channelToken: "kx8f-a3mv-9pqz",
      // Gateway's X25519 private key (generated on first enable)
      privateKey: "base64(...)",
      // Approved client public keys
      clients: {
        "client_uuid_1": {
          publicKey: "base64(...)",
          name: "My Phone",
          addedAt: "2026-03-07T10:00:00Z"
        }
      }
    }
  }
}
```

**CLI commands**:

```bash
# Enable relay channel (generates keys, discovers relay)
openclaw relay enable [--server wss://...]

# Show pairing code / QR for a new client
openclaw relay pair

# List connected clients
openclaw relay clients

# Revoke a client
openclaw relay revoke <client_id>

# Disable relay
openclaw relay disable
```

### 3.3 Reference Client

**Technology**: Single-page web application (vanilla JS or lightweight framework)

**Deployment**:
- Served by OpenClaw gateway on LAN: `http://gateway:18789/console/`
- Hosted as static files for remote access (GitHub Pages, any CDN)
- Can be wrapped in Tauri (desktop) or Capacitor (mobile) by users

**Core features** (reference implementation):
- Connect to relay or direct to gateway
- Pairing (scan QR or enter code)
- Send messages to agents, receive streaming responses
- Markdown rendering for agent output
- Notification inbox for async results (cron, background tasks)
- Basic session history browsing

**What it deliberately does NOT include** (left to users):
- Agent configuration UI
- File management
- Cron editor
- System monitoring dashboard
- Custom themes / branding

The client is meant to be forked and extended. The `sdk/js` package provides the protocol implementation so custom clients can focus on UI.

### 3.4 SDK

**JavaScript SDK** (`sdk/js/`):

```javascript
import { RelayClient } from '@openclaw/relay-sdk';

const client = new RelayClient({
  relay: 'wss://relay.example.com',
  token: 'kx8f-a3mv-9pqz',
  gatewayPublicKey: '...',
});

await client.connect();

// Send a chat message with streaming
const stream = await client.chat('tangseng', 'What is the news today?');
for await (const chunk of stream) {
  process.stdout.write(chunk.delta);
}

// List agents
const agents = await client.agents.list();

// Receive notifications
client.on('agent.output', (data) => {
  console.log(`${data.agent} produced: ${data.title}`);
});
```

**Python SDK** (`sdk/python/`):

```python
from openclaw_relay import RelayClient

client = RelayClient(
    relay="wss://relay.example.com",
    token="kx8f-a3mv-9pqz",
    gateway_public_key="...",
)

async with client.connect() as conn:
    # Chat with streaming
    async for chunk in conn.chat("tangseng", "What is the news today?"):
        print(chunk.delta, end="")

    # List agents
    agents = await conn.agents.list()
```

## 4. Public Relay Discovery

### Registry Format

The file `relays.json` in the project repository:

```json
[
  {
    "url": "wss://relay.alice.dev",
    "region": "cn-east",
    "operator": "alice",
    "operator_url": "https://github.com/alice",
    "capacity": 500,
    "since": "2026-03-01",
    "notes": "Hosted on Aliyun Shanghai"
  }
]
```

### Discovery Flow

```
1. Plugin loads the last-known-good relay list from local cache (if present)
2. Plugin reads the primary registry URL plus any configured mirrors
3. Fetches and parses the first reachable registry
4. If all registry fetches fail, continue with the cached list and surface a warning
5. For each relay: GET /status (with 5s timeout)
6. Filters: only relays with status.public == true and available capacity
7. Sorts by: latency (primary), available capacity (secondary)
8. Selects the best relay
9. User can override with --server flag
```

The OpenClaw plugin SHOULD cache the last-known-good relay list locally. If the registry URL is unreachable, the plugin falls back to the cached list. This prevents a single point of failure in relay discovery.

### Adding a Public Relay

1. Deploy a relay with `--public` flag
2. Ensure `/status` endpoint is accessible
3. Fork the repo, add entry to `relays.json`
4. Submit a PR
5. CI validates the relay is reachable and healthy
6. Community reviews and merges

### Relay Health Monitoring

A GitHub Action runs daily:
- Probes all relays in `relays.json`
- Opens an issue if a relay is unreachable for 3+ consecutive days
- Maintainers can remove dead relays

### Discovery Resilience

- The registry format should remain static and cacheable so clients can safely keep a last-known-good copy.
- Public deployments should publish at least one mirror URL outside a single hosting provider.
- A future hardening step should add a signed registry manifest so clients can detect tampering independently of transport availability.

## 5. Security Analysis

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Relay reads messages | E2E encryption; relay only sees ciphertext |
| Relay modifies messages | AES-GCM authentication; tampering detected |
| Relay replays messages | Monotonic nonce counters; replay detected |
| Man-in-the-middle during pairing | Pairing info transferred out-of-band (QR/manual); TOFU model |
| Unauthorized client connects | Channel token is secret; unknown client keys are accepted only during explicit pairing mode |
| Unauthorized client sends messages | E2E encryption; can't decrypt without shared secret |
| Nonce reuse after reconnect | Derive a fresh session key for every connection using both peers' session nonces |
| Relay denial of service | Switch to another relay; token and keys are portable |
| Compromised gateway keys | Revoke and re-pair; rotate keys |

### What the Relay Can See

- That a connection exists on a given channel hash
- When gateway and clients are online/offline
- Volume and timing of messages (traffic analysis)
- Encrypted payload sizes

### What the Relay Cannot See

- Channel token (only the hash)
- Message content
- Who the user is (no authentication required to run a relay)
- Which agent is being used
- What is being discussed

## 6. LAN Direct Connection

When the client and OpenClaw are on the same network, the relay is unnecessary.

### Discovery

The OpenClaw gateway plugin advertises via mDNS:

```
Service: _openclaw._tcp.local.
Port: 18789
TXT: version=2026.3.2, relay=enabled
```

The client app:
1. On startup, queries mDNS for `_openclaw._tcp.local.`
2. If found, connects directly to the gateway over the local transport exposed by the gateway
3. Uses the same Layer 1 encryption (keys from pairing)
4. If mDNS fails, falls back to relay connection

### Seamless Switching

The Connection Manager in the client maintains both paths:
- Direct (LAN): lower latency, no relay dependency
- Relay (WAN): works from anywhere

When the user moves between networks, the client automatically switches. The application layer (Layer 3) is identical in both cases — only the transport changes.

## 7. Implementation Phases

### Phase 1: Foundation (Secure MVP)

Deliverables:
- Protocol specification (frozen for v1)
- Relay server in Go (channel matching, forwarding, /status, abuse controls, structured logging)
- E2E encryption (Layer 1: pairing, session establishment, AES-GCM)
- Python SDK (Layer 0-2 implementation)
- OpenClaw relay channel plugin (secure pairing + basic chat)
- Minimal web client (connect, pair, chat)
- `relays.json` with validation CI

What works after Phase 1:
- User can deploy a relay, enable relay plugin, securely pair a web client, chat with agents over E2E encrypted channel

### Phase 2: Completeness

Deliverables:
- JavaScript SDK
- Streaming support in client
- Notification inbox in client
- Session history in client
- mDNS LAN discovery
- Key rotation
- Operator runbook for public relays

### Phase 3: Ecosystem

Deliverables:
- Tauri desktop wrapper
- Mobile-responsive client
- Agent management in client
- File operations
- Public relay monitoring CI
- Documentation site
- Evaluate Noise IK/XX handshake for forward secrecy (ADR)

## 8. Open Questions

1. **Should the relay support WebSocket compression?** Per-message deflate reduces bandwidth but adds CPU overhead. Probably worth it for text-heavy AI responses.

2. **Binary or text WebSocket frames?** Text (JSON) is easier to debug. Binary is more efficient. Recommendation: text for Layer 0, binary for encrypted payloads within DATA frames.

3. **Should the plugin be contributed upstream to OpenClaw?** Ideally yes — as a built-in channel like Feishu. If not accepted, it can be distributed as a standalone npm package that plugs into OpenClaw's plugin system.

4. **Relay federation?** Should relays be able to connect to each other for redundancy? Probably not in v1 — adds complexity. Users can just switch relays if one goes down.

5. **Should the protocol version be negotiated?** Currently both sides declare `version: 1`. If v2 introduces breaking changes, a negotiation mechanism will be needed. Recommendation: defer until v2 is planned.
