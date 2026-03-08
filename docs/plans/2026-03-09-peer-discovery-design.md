# Peer Discovery and Agent-to-Agent Signaling

Status: draft MVP design  
Audience: relay implementers, OpenClaw gateway/plugin implementers, and AI agents extending the system

## Summary

OpenClaw Relay currently allows a human operator or a known client to talk to a single OpenClaw instance through a relay channel. What it does **not** provide is a way for OpenClaw instances to discover each other and initiate contact autonomously.

This design adds a narrow **Layer 0.5 discovery and signaling surface** that lets OpenClaw gateways:

- opt into being discoverable
- discover other online discoverable gateways on the same relay
- send encrypted peer-to-peer signaling messages
- establish a normal OpenClaw relay channel using a short-lived invite capability

The relay remains intentionally dumb. It stores only in-memory routing state, never interprets discovery metadata, never performs matching, and never handles long-lived channel bearer secrets.

## Product Boundary

This feature is **agent-first** and **gateway-scoped**.

### Allowed

- An OpenClaw gateway may advertise itself to other OpenClaw gateways if the operator explicitly enables discovery.
- An OpenClaw gateway may discover other discoverable OpenClaw gateways.
- An OpenClaw gateway may initiate encrypted signaling to another discoverable OpenClaw gateway.
- After acceptance, one OpenClaw gateway may join another gateway's relay channel using a short-lived invite capability.

### Not Allowed

- Human-facing clients must not use this feature to discover other OpenClaw instances.
- Browser clients, mobile clients, desktop clients, and any other user-operated clients must not expose peer browsing, peer search, or peer signaling UX.
- The relay must not become a general-purpose peer directory for humans.
- Long-lived `channel_token` values must never be shared through discovery or signaling.

This product boundary is intentional: humans may use a client to interact with **their own** OpenClaw instance, but not to discover or contact other OpenClaw instances through this mechanism.

## Problem

Every OpenClaw instance connected to a relay is currently isolated. It serves its human operator and any clients that already know its channel token, but it has no awareness that other OpenClaw instances may exist on the same relay.

That means agents cannot:

- see what other agents are online
- advertise their capabilities to peers
- initiate contact without human coordination
- establish agent-to-agent communication using the existing relay path

## Goal

Let OpenClaw instances discover each other and establish direct E2E-encrypted channels autonomously, with zero human coordination beyond initial deployment and explicit operator opt-in.

## Non-Goals

This design does **not** attempt to build:

- a human social graph
- a chat product for people to browse other OpenClaw instances
- relay-side ranking, recommendation, or matching
- a trust or reputation system
- store-and-forward signaling
- cross-relay federation
- group discovery or topic subscriptions
- a replacement for the existing channel and handshake stack

## Design Principles

1. **Relay adds visibility, not logic.** The relay reveals who is online and routes signals. It does not match, recommend, filter, approve, or interpret metadata.
2. **Opt-in only.** A gateway that does not set `discoverable: true` is invisible, exactly as today.
3. **No new persistence.** Discovery and invite state live only in memory. If a gateway goes offline, it disappears.
4. **Signal confidentiality.** The relay must not be able to read signal payloads.
5. **Existing channel model stays intact.** Discovery and signaling only lead to a normal relay channel; they do not replace Layers 0–3.
6. **No long-lived secret sharing.** Peer establishment uses short-lived invite capabilities, not the gateway's long-lived `channel_token`.
7. **Agent-first, human-clear.** Machine-oriented control surfaces are acceptable, but human-facing consent and risk boundaries must remain explicit.

## Non-Negotiable Security and Product Invariants

1. The relay MUST NEVER disclose `channel_hash` or `channel_token` via discovery APIs.
2. The relay MUST NEVER store discovery state or invite state on disk.
3. `DISCOVER` MUST be gateway-only in v1.
4. Human-facing clients MUST NOT expose discovery or peer-contact capabilities.
5. The relay MUST derive `SIGNAL.source` from connection state, not from any client-supplied field.
6. Peer establishment MUST use short-lived invite capabilities, not long-lived channel bearer tokens.
7. A non-discoverable gateway is invisible and non-routable through discovery/signaling.
8. Discovery metadata is opaque relay-stored data. The relay MUST NOT interpret it.
9. `discoverable: true` MUST be an explicit operator-level opt-in in OpenClaw configuration. Agents MUST NOT silently enable it.
10. The resulting peer conversation MUST still use the existing channel join + `HELLO` / `HELLO_ACK` + Layer 1/2/3 flow.

## MVP Scope

The MVP ships four behaviors:

1. extended `REGISTER`
2. `DISCOVER`
3. `SIGNAL`
4. short-lived relay-side invite aliases used to join a normal channel

Explicitly deferred:

- `PRESENCE`
- `METADATA_UPDATE`
- relay-side filtering
- relay-side matching or recommendation
- trust/reputation systems
- topic/group discovery
- cross-relay federation
- human-facing peer browsing in the browser client
- any browser UI for peer discovery

## Architecture Placement

This feature introduces a narrow **Layer 0.5**:

- **Layer 0:** unchanged channel and relay frames
- **Layer 0.5:** discovery, signaling, and invite aliasing
- **Layer 1:** unchanged E2E channel security handshake
- **Layer 2:** unchanged request/response/streaming transport
- **Layer 3:** unchanged application methods once a channel is established

The key design rule is that discovery/signaling only help two gateways find each other and bootstrap a normal channel. The actual conversation still happens through the current protocol stack.

## Relay Data Model

The relay keeps three in-memory structures.

### 1. `discoveryMap`

Keyed by `public_key`.

Suggested record shape:

```json
{
  "public_key": "<base64>",
  "channel_hash": "<gateway long-lived channel hash>",
  "metadata": { "name": "wukong", "capabilities": ["code"] },
  "registered_at": "2026-03-09T14:30:00Z"
}
```

Runtime association to the active WebSocket connection remains relay-internal and is not exposed.

### 2. `inviteMap`

Keyed by `invite_hash`.

Suggested record shape:

```json
{
  "invite_hash": "<64-char lowercase hex SHA-256(invite_token)>",
  "owner_public_key": "<base64>",
  "owner_channel_hash": "<gateway long-lived channel hash>",
  "expires_at": "2026-03-09T15:05:00Z",
  "remaining_uses": 1
}
```

### 3. `signalRateLimiter`

Keyed by sender `public_key`, token-bucket or equivalent.

## Protocol Surface

## 1. `REGISTER` Extension

Current frame:

```json
{
  "type": "register",
  "channel_hash": "abc123..."
}
```

Extended frame:

```json
{
  "type": "register",
  "channel_hash": "abc123...",
  "discoverable": true,
  "public_key": "<base64 X25519 public key>",
  "metadata": {
    "name": "wukong",
    "version": "0.3.1",
    "capabilities": ["code", "search", "image"],
    "description": "A general-purpose assistant"
  }
}
```

### Validation Rules

- `discoverable` is optional and defaults to `false`
- if `discoverable = true`, `public_key` is required
- if `discoverable = true`, `public_key` must be a valid base64 X25519 public key
- `metadata` is optional
- `metadata` is opaque relay data with a hard size limit of 4 KB serialized
- if validation fails, relay rejects the registration with a structured error and does not enter discovery state

### Connection-Binding Rules

- A discoverable gateway is identified by the `public_key` it registered on its own connection.
- The relay binds that `public_key` to the currently active registered connection.
- Re-registering the same `public_key` from a newer connection replaces the live discovery entry.
- The older connection may remain open for ordinary channel behavior, but it no longer owns discovery identity for that `public_key`.
- A connection that is not currently registered as discoverable may not send `SIGNAL`.

## 2. `DISCOVER`

`DISCOVER` is gateway-only in v1.

Browser clients, web UI, Python user-facing client tooling, and any other human-facing client must not expose this capability.

### Request

```json
{
  "type": "discover"
}
```

### Response

```json
{
  "type": "discover_result",
  "peers": [
    {
      "public_key": "<base64>",
      "metadata": {
        "name": "wukong",
        "capabilities": ["code", "search"]
      },
      "online_since": "2026-03-09T14:30:00Z"
    },
    {
      "public_key": "<base64>",
      "metadata": {
        "name": "bajie",
        "capabilities": ["research"]
      },
      "online_since": "2026-03-09T15:12:00Z"
    }
  ]
}
```

### Relay Rules

- requester must be a registered gateway connection
- requester does not need to be discoverable; discoverable controls visibility, not lookup permission
- response returns all discoverable gateways except the requester itself if the requester is discoverable
- no pagination in the MVP
- no filtering in the MVP
- no ranking in the MVP
- relay MUST NOT include `channel_hash`
- relay MUST NOT include `channel_token`

## 3. `SIGNAL`

`SIGNAL` is an encrypted gateway-to-gateway contact-initiation frame.

### Send Frame

```json
{
  "type": "signal",
  "target": "<target public_key base64>",
  "ephemeral_key": "<sender ephemeral X25519 public key base64>",
  "payload": "<base64 encrypted payload>"
}
```

### Forwarded Frame

```json
{
  "type": "signal",
  "source": "<sender public_key base64, relay-derived>",
  "ephemeral_key": "<base64>",
  "payload": "<base64 encrypted payload>"
}
```

### Relay Rules

1. Verify sender is currently a discoverable registered gateway.
2. Derive `source` from the sender's bound discovery identity.
3. Look up `target` in `discoveryMap`.
4. If the target is online and discoverable, forward the frame.
5. If the target is missing or offline, return `signal_error`.
6. Enforce per-source rate limiting.
7. Never inspect or transform `payload` beyond forwarding.

### Errors

```json
{ "type": "signal_error", "code": "peer_offline", "target": "<base64>" }
```

```json
{ "type": "signal_error", "code": "not_discoverable" }
```

```json
{ "type": "signal_error", "code": "rate_limited" }
```

### Signal Encryption

Each signal uses one-shot ephemeral encryption:

- sender generates a fresh ephemeral X25519 keypair per signal
- shared secret: `ECDH(ephemeral_private, target_public_key)`
- salt: `SHA256(ephemeral_pub || target_pub)`
- KDF: `HKDF-SHA256(ikm=shared, salt=salt, info="openclaw-relay-signal-v1", len=32)`
- cipher: `AES-256-GCM`
- payload format: `iv (12 bytes) || ciphertext || tag (16 bytes)`, base64-encoded

Recipient decrypts with:

- `ECDH(own_private, ephemeral_key)`
- the same salt and HKDF parameters

This gives per-signal secrecy even though the main channel protocol still uses static identity keys.

## 4. Invite Alias Flow

Peer establishment must not transmit long-lived channel tokens. Instead, the accepting gateway creates a short-lived invite capability.

### Gateway-to-Relay Invite Creation

```json
{
  "type": "invite_create",
  "invite_hash": "<64-char lowercase hex SHA-256(invite_token)>",
  "max_uses": 1,
  "ttl_seconds": 300
}
```

### Relay Response

```json
{
  "type": "invite_created",
  "invite_hash": "<64-char lowercase hex>",
  "expires_at": "2026-03-09T15:05:00Z"
}
```

### Relay Rules

1. Only the owning gateway may create invite aliases for its own channel.
2. Relay stores `invite_hash -> owner_channel_hash` in memory.
3. `max_uses` defaults to `1` in the MVP and should remain `1` for the normative flow.
4. Invite expires automatically at `expires_at` regardless of use count.
5. After one successful join, the invite becomes invalid immediately. Implementations may keep an in-memory tombstone until TTL expiry so reuse still returns `invite_invalid` instead of falling through to a fresh empty channel.
6. Relay caps pending invites per gateway, for example `10`.

### Join Behavior

The accepting gateway:

1. generates a random `invite_token`
2. computes `invite_hash = SHA-256(invite_token)`
3. sends `invite_create` to the relay
4. sends the raw `invite_token` to the initiating peer inside encrypted `SIGNAL` payload

The initiating peer then:

1. computes `SHA-256(invite_token)` locally
2. uses that hash as `channel_hash` in a normal `JOIN`
3. completes the existing `HELLO` / `HELLO_ACK` flow
4. communicates over the normal encrypted Layer 1/2/3 channel

At no point does the long-lived `channel_token` leave the accepting gateway.

## Normative Peer Establishment Flow

```text
OpenClaw A                    Relay                    OpenClaw B
    |                           |                           |
    |--- REGISTER(discoverable) --------------------------->|
    |<-------------------- register_ok ---------------------|
    |                           |                           |
    |<-------------------- REGISTER(discoverable) --------- |
    |                           |                           |
    |--- DISCOVER ----------->  |                           |
    |<-- discover_result -----  |                           |
    |   (sees B public_key)     |                           |
    |                           |                           |
    |--- SIGNAL(to B) --------> | --- SIGNAL(from A) -----> |
    |   encrypted contact       |                           |
    |                           |                           |
    |                           |   B decides whether to    |
    |                           |   accept                  |
    |                           |                           |
    |                           | <------ INVITE_CREATE ----|
    |                           | ------ invite_created --->|
    |                           |                           |
    |<-- SIGNAL(from B) ------- | <---- SIGNAL(to A) ------ |
    |   encrypted invite_token  |                           |
    |                           |                           |
    |--- JOIN(invite_hash) ---> | --- route to B channel -->|
    |<== HELLO / HELLO_ACK ====>|<=========================>|
    |                           |                           |
    |    normal E2E channel established                     |
```

This is the normative flow for the MVP.

## What OpenClaw Decides

The relay provides routing primitives only. OpenClaw decides:

1. **Whether to enable discovery**
2. **What metadata to advertise**
3. **Which discovered peers are interesting**
4. **Whether to accept or ignore incoming signals**
5. **When to create an invite**
6. **What policy to apply before allowing a peer channel**
7. **What Layer 3 methods to use after the channel exists**

## What the Relay Explicitly Does Not Do

- no matching
- no semantic interpretation of metadata
- no approval workflow
- no store-and-forward signaling
- no token brokering for long-lived channel secrets
- no trust scoring
- no group discovery
- no cross-relay routing
- no human-facing directory behavior

## Security Analysis

| Concern | Mitigation |
|---------|------------|
| Metadata leaks sensitive information | Discovery is opt-in, metadata is operator-controlled, and the relay treats it as opaque data. |
| Human clients browse other OpenClaw instances | Disallowed by product boundary; `DISCOVER` is gateway-only in v1. |
| Relay leaks routing secrets | Relay never returns `channel_hash` and never handles long-lived `channel_token` in discovery/signaling. |
| SIGNAL spam | Per-source rate limiting and `signal_error: rate_limited`. |
| Signal payload interception | Payload is encrypted with one-shot ephemeral ECDH + AES-GCM. |
| Fake sender identity in `SIGNAL` | Relay derives `source` from bound connection state. |
| Duplicate `public_key` confusion | Discovery entry is rebound explicitly to the latest registered connection. |
| Invite replay | Invite is single-use and TTL-bounded. |
| Offline accumulation | No persistence, no queue, no store-and-forward. |
| Silent opt-in by an agent | Forbidden by invariant; discovery requires explicit operator configuration. |

## Compatibility and Migration

### Backward Compatibility

- Existing gateways that never send discovery fields behave exactly as before.
- Existing browser clients behave exactly as before.
- Existing relay channel semantics remain unchanged.
- Existing `JOIN`, `HELLO`, `HELLO_ACK`, Layer 2, and Layer 3 behavior remain unchanged.

### Forward Compatibility

Potential future extensions can be added later without changing the MVP model:

- `PRESENCE`
- metadata updates
- filtered discovery
- trust overlays
- cross-relay federation

## Implementation Plan

### Relay

1. Extend `REGISTER` parsing and validation.
2. Add `discoveryMap`.
3. Add `DISCOVER` handler.
4. Add `SIGNAL` handler and rate limiter.
5. Add `inviteMap` and `invite_create` handler.
6. Teach `JOIN` path to resolve `invite_hash` aliases to the owning channel.
7. Add expiry cleanup for invites.

### OpenClaw Gateway / Plugin

1. Add operator-level `discoverable` config.
2. Add a stable discovery public key source.
3. Add metadata generation policy.
4. Add a host-only internal bridge for local OpenClaw agents; do not expose discovery through human-facing relay RPC methods.
5. Add `DISCOVER` call path.
6. Add `SIGNAL` send/receive logic.
7. Add invite creation and acceptance policy, including invite-scoped in-memory peer admission on the target gateway.
8. Add peer-initiated channel bootstrap logic, including a host-only outbound invite dialer that performs `JOIN(invite_hash)` and `HELLO` / `HELLO_ACK`.

### Human-Facing Clients

No discovery UI.

The browser client and other human-facing clients continue to talk only to their own OpenClaw instance.

## Test Plan

### Relay Unit Tests

- `REGISTER` with and without discovery fields
- `REGISTER` reject invalid `public_key`
- `REGISTER` reject oversized metadata
- duplicate `public_key` rebinding behavior
- `DISCOVER` allowed for gateways, rejected for non-gateway clients
- `DISCOVER` excludes self and non-discoverable gateways
- `DISCOVER` never returns `channel_hash`
- `SIGNAL` forward happy path
- `SIGNAL` rejects non-discoverable sender
- `SIGNAL` returns `peer_offline`
- `SIGNAL` rate limiting
- `invite_create` happy path
- invite TTL expiry
- invite single-use enforcement
- `JOIN(invite_hash)` routing to owning channel

### Integration Tests

- gateway A discovers gateway B
- A signals B
- B accepts and creates invite
- A joins via invite alias
- A and B complete `HELLO` / `HELLO_ACK`
- A and B exchange Layer 3 traffic over the resulting channel
- human-facing client path does not expose discovery

### Documentation / Contract Work

If this design advances beyond planning, the following documents should eventually be updated:

- `protocol/layer0-channel.md`
- `protocol/error-codes.json`
- `protocol/examples/*.json`
- `docs/ai-implementation-guide.md`
- `docs/security.md`
- `docs/architecture-overview.md`
- plugin design and implementation docs

## Rollout Recommendation

Ship this in two phases.

### Phase 1

- extended `REGISTER`
- `DISCOVER`
- `SIGNAL`
- invite alias support
- gateway/plugin-only implementation
- no browser UX changes

### Phase 2

Only after Phase 1 proves stable:

- optional `PRESENCE`
- richer metadata policy
- better operator controls
- possible internal trust heuristics on the OpenClaw side

## Bottom Line

This is a good feature if it stays narrow.

The correct first version is:

- gateway-only discovery
- encrypted gateway-to-gateway signaling
- short-lived invite capabilities instead of long-lived token sharing
- explicit connection-bound routing identity
- no human peer browsing
- no relay-side intelligence beyond routing and limits

That version is small, testable, secure enough for the current architecture, and consistent with the project's agent-first direction.
