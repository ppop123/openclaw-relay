# Relay on Cloudflare Durable Objects

Status: design draft
Depends on: current Go relay implementation (`relay/`)

## Summary

Port the OpenClaw Relay from a standalone Go server to a Cloudflare Workers + Durable Objects deployment. The relay logic maps to a single Durable Object class that manages all WebSocket connections, channels, discovery, signaling, and invites in memory.

## Why Durable Objects

| Relay requirement | Durable Objects fit |
|---|---|
| Long-lived WebSocket connections | Hibernatable WebSockets (idle connections don't consume CPU billing) |
| Pure in-memory state (channels, discovery, invites) | Single-threaded instance with JS heap — no mutexes needed |
| Single-node, no clustering | One DO instance per relay — matches current architecture |
| No persistence required | Can skip DO Storage API entirely |
| Read/write timeouts | WebSocket `close()` + `setTimeout` or DO alarm API |
| Graceful shutdown | DO runtime handles lifecycle automatically |

Cost: Workers Paid plan, $5/month base. Includes 10M Worker requests, 1M DO requests, 1GB-hr DO duration. Well within budget for a relay with moderate traffic.

## Architecture

```
Internet
   │
   ▼
Cloudflare Worker (edge, stateless)
   │  routes /ws → DO.fetch()
   │  routes /status → DO.fetch()
   │
   ▼
Durable Object "RelayRoom" (single instance)
   │  manages all WebSocket connections
   │  channels, discovery, invites, rate limiting
   │  pure in-memory state
   │
   ├── Gateway A (WebSocket)
   ├── Gateway B (WebSocket)
   ├── Client 1 (WebSocket)
   ├── Client 2 (WebSocket)
   └── ...
```

### Why One DO Instance

Discovery and signaling are global operations — gateway A discovers gateway B across different channels. A multi-DO design (one per channel) would require cross-DO communication for discovery, adding complexity with no benefit at the current scale.

The single-instance model matches the Go relay's known limitation ("Single relay node only — no clustering, federation, or HA"). If horizontal scaling is needed in the future, the DO can be sharded by relay namespace, with each shard being its own DO instance.

## Source of Truth: Go Relay

The TypeScript DO relay MUST reproduce the exact behavior of the Go relay. The Go codebase (`relay/`) is the spec. Below is the mapping.

### Frame Types — Complete List

Preserved 1:1 from Go. No frame type is added, removed, or renamed.

**Inbound gateway frames:** `register`, `data` (with `to`), `discover`, `signal`, `invite_create`, `ping`

**Inbound client frames:** `join`, `data` (no `to`), `ping`

**Outbound frames:** `registered`, `joined`, `data` (with `from`/`to`), `presence`, `discover_result`, `signal` (forwarded), `invite_created`, `error`, `signal_error`, `pong`

**Error codes:** `invalid_frame`, `channel_occupied`, `channel_limit_reached`, `channel_full`, `client_id_required`, `payload_too_large`, `rate_limited`, `gateway_only`, `public_key_required`, `invalid_public_key`, `metadata_too_large`, `not_discoverable`, `peer_offline`, `invite_invalid`, `invite_limit_reached`

### Data Structures

```
RelayRoom (Durable Object)
  ├── config: RelayConfig
  ├── channels: Map<channelHash, Channel>
  ├── discoveryByKey: Map<publicKey, DiscoveryEntry>
  ├── discoveryByWs: Map<WebSocket, DiscoveryEntry>
  ├── invites: Map<inviteHash, InviteEntry>
  ├── signalLimiters: Map<WebSocket, TokenBucket>
  ├── wsRoles: Map<WebSocket, "gateway" | "client">
  ├── framesForwarded: number
  └── framesRejected: number

Channel
  ├── hash: string
  ├── gateway: WebSocket | null
  ├── clients: Map<clientId, ClientConn>
  ├── limiter: TokenBucket
  └── createdAt: number

ClientConn
  ├── id: string
  └── ws: WebSocket

DiscoveryEntry
  ├── publicKey: string (base64, normalized)
  ├── channelHash: string
  ├── metadata: object | null
  ├── registeredAt: string (ISO)
  └── ws: WebSocket

InviteEntry
  ├── inviteHash: string (64-hex)
  ├── ownerPublicKey: string
  ├── ownerChannelHash: string
  ├── expiresAt: number (epoch ms)
  └── remainingUses: number
```

### Concurrency: Go vs DO

| Go | Durable Objects |
|---|---|
| One goroutine per connection, shared state via RWMutex | Single-threaded event loop, no mutexes needed |
| `Relay.mu` → `channel.mu` lock ordering | Not needed — all code runs on one thread |
| Token bucket refill via background goroutine + ticker | Timestamp-based refill on each `allow()` call |
| `sync/atomic` for counters | Plain `number` increment |
| 60s read timeout via `context.WithTimeout` | DO alarm or `setTimeout` + WebSocket close |
| 10s write timeout via `context.WithTimeout` | WebSocket send is non-blocking in DO; no write timeout needed |

### Hibernatable WebSockets

Durable Objects support [Hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/api/websockets/). Key behaviors:

- `webSocketMessage(ws, message)` — called when a message arrives. The DO "wakes up" from hibernation if needed.
- `webSocketClose(ws, code, reason)` — called on close.
- `webSocketError(ws, error)` — called on error.
- During hibernation, the DO's memory is evicted but WebSocket connections stay open at the Cloudflare edge. When a message arrives, the DO is re-instantiated.

**Critical implication:** After hibernation wake-up, all in-memory state (channels, discovery, invites) is lost. This means:

1. **Option A: Accept state loss on hibernation.** If all connections go idle for long enough, the DO hibernates and all state is lost. Connections stay open but the relay forgets all channel/discovery registrations. Clients would need to re-register/re-join. This is acceptable if we treat hibernation like a server restart.

2. **Option B: Use DO Storage to persist critical state.** Store channel registrations and discovery entries in DO Storage so they survive hibernation. This adds complexity but preserves state.

3. **Option C: Prevent hibernation.** Use `ctx.setHibernatableWebSocketEventTimeout(ms)` or periodic alarms to keep the DO alive. Since the relay is always active (multiple connections), hibernation is unlikely in practice.

**Recommended approach: Option A + Option C hybrid.** In practice, a relay with active connections will rarely hibernate. If it does, treat it as a restart — gateways and clients will reconnect and re-register (they already handle this for server restarts). Use DO alarms as a keepalive if needed.

### Configuration

Go relay uses CLI flags. The DO relay uses environment variables (wrangler.toml `[vars]`):

| Go flag | DO env var | Default |
|---|---|---|
| `--port` | N/A (Cloudflare handles routing) | — |
| `--tls` | N/A (Cloudflare handles TLS) | — |
| `--max-channels` | `MAX_CHANNELS` | 500 |
| `--max-clients-per-channel` | `MAX_CLIENTS_PER_CHANNEL` | 10 |
| `--rate-limit` | `RATE_LIMIT` | 100 |
| `--max-payload` | `MAX_PAYLOAD` | 1048576 |
| `--public` | `PUBLIC` | false |
| `--allow-origin` | `ALLOW_ORIGIN` | "" |
| `--log-format` | N/A (Workers use `console.log`, structured by default) | — |

### HTTP Endpoints

| Endpoint | Go | DO |
|---|---|---|
| `GET /ws` | WebSocket upgrade | Worker routes to DO, DO handles upgrade |
| `GET /status` | JSON health/metrics | Worker routes to DO, DO returns JSON |

### Origin Checking

Go uses `nhooyr.io/websocket` `OriginPatterns`. In Workers, origin checking must be done manually in the Worker's `fetch` handler before upgrading to WebSocket. Use the same `path.Match`-style glob matching against the `Origin` header's host.

## Module Structure

```
relay-do/
├── wrangler.toml           # Cloudflare config
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # Worker entry: routes /ws and /status to DO
│   ├── relay-room.ts       # Durable Object class: all relay logic
│   ├── channel.ts          # Channel data structure
│   ├── discovery.ts        # Discovery map + signal rate limiting
│   ├── invite.ts           # Invite alias management
│   ├── rate-limiter.ts     # Timestamp-based token bucket
│   ├── frames.ts           # Frame type definitions and validation
│   └── origin.ts           # Origin pattern matching
├── tests/
│   ├── relay-room.test.ts  # Integration tests using miniflare
│   ├── channel.test.ts
│   ├── discovery.test.ts
│   ├── invite.test.ts
│   └── frames.test.ts
└── README.md
```

Estimated total: ~800-1000 lines TypeScript (non-test). The DO version should be smaller than the Go version because:
- No mutex/locking code
- No goroutine management
- No HTTP server boilerplate
- No TLS handling
- No graceful shutdown logic

## Behavioral Parity Checklist

Every item below must pass identical behavior to the Go relay:

- [ ] `register` creates channel, returns `registered` with client count
- [ ] `register` rejects occupied channel with `channel_occupied`
- [ ] `register` enforces max channels with `channel_limit_reached`
- [ ] `join` creates/joins channel, returns `joined` with `gateway_online`
- [ ] `join` resolves invite hash to owner channel
- [ ] `join` enforces max clients with `channel_full`
- [ ] `join` replaces duplicate `client_id` (close old connection)
- [ ] `join` requires `client_id` with `client_id_required`
- [ ] `data` client→gateway: adds `from` (client_id), `to` ("gateway")
- [ ] `data` gateway→client: validates `to` exists, forwards with `from` ("gateway")
- [ ] `data` enforces payload size limit
- [ ] `data` enforces per-channel rate limit
- [ ] `presence` online/offline for gateway and client connections
- [ ] `discover` returns all discoverable peers except self
- [ ] `discover` never returns `channel_hash`
- [ ] `discover` rejected for non-gateway connections
- [ ] `signal` forwarded with relay-derived `source`
- [ ] `signal` rejected for non-discoverable senders
- [ ] `signal` returns `peer_offline` for missing targets
- [ ] `signal` rate limited (10/min per sender)
- [ ] `invite_create` creates alias, returns `invite_created`
- [ ] Invite single-use enforcement
- [ ] Invite TTL expiry
- [ ] Invite limit per gateway (10)
- [ ] Invite cleanup on gateway disconnect
- [ ] `ping`/`pong` echo
- [ ] `gateway_only` error for client sending discover/signal/invite_create
- [ ] Protocol version check (version 0 or 1 only)
- [ ] Channel hash validation (64-char lowercase hex)
- [ ] Base64 public key normalization (decode + re-encode to canonical)
- [ ] Metadata validation (JSON object, max 4KB)
- [ ] 60-second idle timeout (close connection if no frames received)
- [ ] Channel cleanup when empty (no gateway + no clients)
- [ ] `/status` JSON endpoint with connection/channel/frame counters
- [ ] Origin checking with glob patterns

## Deployment

```bash
# Install
npm create cloudflare@latest relay-do
cd relay-do

# Development
npx wrangler dev

# Deploy
npx wrangler deploy

# Custom domain (optional)
# Configure in Cloudflare Dashboard: Workers > relay-do > Custom Domains
```

### wrangler.toml skeleton

```toml
name = "openclaw-relay"
main = "src/index.ts"
compatibility_date = "2026-03-09"

[durable_objects]
bindings = [
  { name = "RELAY_ROOM", class_name = "RelayRoom" }
]

[[migrations]]
tag = "v1"
new_classes = ["RelayRoom"]

[vars]
MAX_CHANNELS = 500
MAX_CLIENTS_PER_CHANNEL = 10
RATE_LIMIT = 100
MAX_PAYLOAD = 1048576
PUBLIC = false
ALLOW_ORIGIN = ""
```

## Testing Strategy

1. **Unit tests**: Each module (channel, discovery, invite, rate-limiter, frames) tested in isolation with vitest.
2. **Integration tests**: Full relay behavior using [miniflare](https://miniflare.dev/) which simulates the Workers + DO runtime locally. Connect multiple WebSocket clients, verify frame routing, discovery, signaling, invites.
3. **Conformance tests**: Run the same test scenarios as `relay/handler_test.go` (13 test functions, 726 lines) against the DO relay to verify behavioral parity.
4. **Live smoke test**: Deploy to Cloudflare, run the existing `scripts/web-client-browser-e2e.mjs` and `scripts/web-client-live-e2e.mjs` against the DO relay URL.

## Migration Path

1. Build and test the DO relay independently in `relay-do/`.
2. Deploy to Cloudflare as a separate Worker.
3. Run both Go and DO relays in parallel, verify identical behavior with the same test suite.
4. Point clients/gateways to the DO relay URL.
5. Retire the Go relay process (keep the code as reference).

The Go relay code in `relay/` remains the canonical behavioral spec. The DO relay is a port, not a replacement of the spec.

## What Changes for Existing Components

| Component | Change |
|---|---|
| Go relay (`relay/`) | No change. Remains as reference implementation. |
| Python SDK (`sdk/python/`) | No change. Connects to relay by URL — transparent. |
| Web client (`client/`) | No change. Connects to relay by URL — transparent. |
| Gateway plugin (`plugin/`) | No change. Connects to relay by URL — transparent. |
| Protocol spec (`protocol/`) | No change. |

The only new artifact is the `relay-do/` directory.

## Risks

| Risk | Mitigation |
|---|---|
| DO single-instance bottleneck | Current Go relay is also single-instance. Monitor connection count and frame throughput. |
| Hibernation state loss | Rare with active connections. Treat like server restart — clients reconnect. |
| WebSocket message size limits | Workers have 1MB WebSocket message limit. Current `max-payload` default is 1MB. Aligned. |
| DO memory limit | 128MB per DO instance. Each connection state is ~1KB. Supports ~100K connections before concern. |
| DO CPU time limits | 30 seconds wall-clock per request (message). Relay frame handling is <1ms. No concern. |
| Cold start latency | First connection to a new DO has ~50ms overhead. Negligible for WebSocket (one-time). |
