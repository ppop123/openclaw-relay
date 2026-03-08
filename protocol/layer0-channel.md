# Layer 0 / 0.5: Channel, Discovery, and Invite Protocol

The relay understands two closely related control surfaces over WebSocket:

- **Layer 0**: channel registration, client join, data forwarding, presence, and heartbeat
- **Layer 0.5**: gateway-only discovery, signaling, and short-lived invite aliases

Layer 0.5 is **agent-first** and **gateway-scoped**. Human-facing clients must not use it to discover or contact other OpenClaw instances.

## Frame Format

All frames are JSON text WebSocket messages:

```json
{
  "type": "<frame_type>",
  "...": "fields depend on type"
}
```

## Connection Roles

The first frame on a connection determines the role:

- `register` → gateway connection
- `join` → client connection

Only **registered gateway connections** may use Layer 0.5 frames:

- `discover`
- `signal`
- `invite_create`

Human-facing clients and any other non-gateway clients MUST receive `error.code = "gateway_only"` if they attempt to use those frame types.

## Frame Types

### REGISTER (Gateway → Relay)

Sent immediately after the gateway WebSocket connection is established.

```json
{
  "type": "register",
  "channel": "<channel_hash>",
  "version": 1,
  "discoverable": true,
  "public_key": "<base64 X25519 public key>",
  "metadata": {"name": "relay-alpha", "caps": ["chat", "tools"]}
}
```

Required fields:

- `channel`: 64-character lowercase hex SHA-256 hash of the channel token
- `version`: protocol version, must be `1`

Optional discovery fields:

- `discoverable`: defaults to `false`
- `public_key`: required when `discoverable = true`; must decode to 32 bytes and is normalized to standard padded base64
- `metadata`: optional opaque JSON object when `discoverable = true`; maximum normalized size `4096` bytes

Rules:

1. A gateway that does not set `discoverable: true` behaves exactly like v1 before Layer 0.5.
2. If `discoverable` is `false`, `public_key` and `metadata` MUST be omitted.
3. Discovery identity is bound to the current gateway connection, not to any client-supplied `source` field.
4. If another gateway later registers the same `public_key`, the latest connection replaces the previous discovery binding. The relay does **not** disconnect the older gateway channel; it only stops routing discovery/signaling to the older binding.

Relay response:

```json
{
  "type": "registered",
  "channel": "<channel_hash>",
  "clients": 0
}
```

Error cases include `channel_occupied`, `channel_limit_reached`, `public_key_required`, `invalid_public_key`, `metadata_too_large`, and `invalid_frame`.

### JOIN (Client → Relay)

Sent immediately after a client WebSocket connection is established.

```json
{
  "type": "join",
  "channel": "<channel_hash_or_invite_hash>",
  "version": 1,
  "client_id": "<client_id>"
}
```

- `channel`: either the normal 64-character channel hash or a short-lived 64-character invite hash alias
- `client_id`: relay-level client identifier scoped to the joined channel

Relay response:

```json
{
  "type": "joined",
  "channel": "<requested_channel_or_invite_hash>",
  "gateway_online": true
}
```

Rules:

1. The relay may resolve an invite hash alias to the owning gateway's real channel internally.
2. The `joined.channel` field echoes the client's requested `channel` value. The relay does **not** reveal the owner's real `channel_hash` when an invite alias is used.
3. If `gateway_online` is `false`, the client may remain connected and wait for later `presence` events.

Possible errors include `client_id_required`, `channel_full`, `channel_limit_reached`, `invite_invalid`, and `invalid_frame`.

### DISCOVER (Gateway → Relay)

`discover` is a **gateway-only** control frame.

```json
{
  "type": "discover"
}
```

Any registered gateway connection may send `discover`. The sender does **not** need to be discoverable itself. `discoverable` controls **visibility**, not query permission.

Relay response:

```json
{
  "type": "discover_result",
  "peers": [
    {
      "public_key": "<base64 X25519 public key>",
      "metadata": {"name": "relay-beta"},
      "online_since": "2026-03-09T10:00:00Z"
    }
  ]
}
```

Rules:

1. Only gateways with `discoverable = true` appear in `peers`.
2. The relay excludes the requester's own discoverable identity from the result set.
3. The relay MUST NOT return `channel_hash` or `channel_token` through discovery.
4. `metadata` is opaque relay-stored JSON. The relay does not interpret it.

### SIGNAL (Gateway → Relay → Gateway)

`signal` is a **gateway-only** contact-initiation frame. Only a **discoverable** gateway may send it.

Gateway-to-relay form:

```json
{
  "type": "signal",
  "target": "<base64 target public key>",
  "ephemeral_key": "<base64 32-byte ephemeral public key>",
  "payload": "<base64 encrypted bytes>"
}
```

Forwarded relay-to-gateway form:

```json
{
  "type": "signal",
  "source": "<base64 sender public key>",
  "ephemeral_key": "<base64 32-byte ephemeral public key>",
  "payload": "<base64 encrypted bytes>"
}
```

Rules:

1. The relay derives `source` from the sender's bound discovery identity. Senders do not choose it.
2. `payload` is opaque to the relay and is expected to be encrypted by the participating gateways.
3. The relay only forwards `signal` to a currently online discoverable target.
4. The relay rate-limits `signal` traffic per discoverable gateway connection.

Failure response:

```json
{
  "type": "signal_error",
  "code": "peer_offline",
  "target": "<base64 target public key>"
}
```

Signal-specific codes:

- `not_discoverable`: sender is not currently bound as a discoverable gateway
- `peer_offline`: target public key is not currently discoverable on this relay
- `rate_limited`: sender exceeded the relay's signal rate limit

Structural problems such as missing fields or malformed keys use normal `error` frames.

### INVITE_CREATE (Gateway → Relay)

`invite_create` creates a short-lived relay-side alias that can later be used in `JOIN.channel`.

```json
{
  "type": "invite_create",
  "invite_hash": "<64-char lowercase hex SHA-256(invite_token)>",
  "max_uses": 1,
  "ttl_seconds": 300
}
```

Rules:

1. Only a **discoverable** gateway may create invites in the MVP.
2. `invite_hash` is the SHA-256 hash of a random raw invite token chosen by the owning gateway.
3. The raw invite token must travel only inside encrypted gateway-to-gateway signaling or another gateway-controlled secure channel.
4. `max_uses` defaults to `1` and MUST remain `1` in the MVP.
5. `ttl_seconds` defaults to `300` if omitted and must be positive.
6. Pending invites are in-memory only and are capped per discoverable gateway.

Relay success response:

```json
{
  "type": "invite_created",
  "invite_hash": "<64-char lowercase hex>",
  "expires_at": "2026-03-09T10:05:00Z"
}
```

Possible errors include `not_discoverable`, `invite_limit_reached`, `invalid_frame`, and `rate_limited` (if future invite creation rate limits are added).

### DATA (Bidirectional)

Carries encrypted application traffic between a joined client and a gateway.

```json
{
  "type": "data",
  "from": "<client_id_or_gateway>",
  "to": "<client_id_or_gateway>",
  "payload": "<base64 encrypted bytes>"
}
```

Rules:

1. The relay verifies the sender role by connection context.
2. The relay does not parse or modify `payload`.
3. After Layer 1 is established, payloads MUST be encrypted. The relay never provides plaintext fallback.
4. Because each client has an independent Layer 1 session key, the gateway must encrypt and send traffic separately per client.

### PRESENCE (Relay → Both)

Presence is sent when the opposite side of a joined channel connects or disconnects.

```json
{
  "type": "presence",
  "role": "gateway",
  "status": "online"
}
```

```json
{
  "type": "presence",
  "role": "client",
  "client_id": "<client_id>",
  "status": "offline"
}
```

Layer 0.5 does **not** add peer-directory presence broadcasts in the MVP.

### PING / PONG (Bidirectional)

Application-level heartbeat.

```json
{"type": "ping", "ts": 1709654321000}
```

```json
{"type": "pong", "ts": 1709654321000}
```

Both sides should send `ping` approximately every 30 seconds. If no `pong` arrives within about 10 seconds, reconnect.

### ERROR / SIGNAL_ERROR

Generic relay error:

```json
{
  "type": "error",
  "code": "<error_code>",
  "message": "<human-readable description>"
}
```

Signal-specific error:

```json
{
  "type": "signal_error",
  "code": "<error_code>",
  "target": "<base64 target public key>"
}
```

Canonical codes live in `protocol/error-codes.json`.

## Relay Behavior

1. The relay maintains `channel_hash -> {gateway, clients}` routing state in memory.
2. The relay additionally maintains:
   - `discoverable_public_key -> gateway connection`
   - `gateway connection -> discoverable identity`
   - `invite_hash -> owner_channel_hash`
3. Discovery and invite state are **memory-only**. If a gateway disconnects, its discoverable identity and outstanding invites are removed.
4. Invite reuse must fail closed with `invite_invalid`; it must never fall through to a fresh empty channel.
5. The relay never reveals a real `channel_hash` through discovery, signaling, or invite creation responses.
6. The relay remains a dumb exchange: no ranking, matching, filtering, queueing, or metadata interpretation.

## Abuse Controls

The relay MUST implement the following protections in v1:

- **Per-channel DATA rate limiting**: default 100 messages/second
- **Per-gateway SIGNAL rate limiting**: default 10 signals/minute for each discoverable gateway connection
- **Maximum payload size**: default 1 MB
- **Maximum channels**: default 500
- **Maximum clients per channel**: default 10
- **Maximum pending invites per discoverable gateway**: default 10
- **Connection throttling**: relay SHOULD limit new WebSocket connections per source IP

## Observability

The relay SHOULD emit structured log lines for:

| Event | Fields |
|-------|--------|
| `channel.registered` | channel_hash, timestamp |
| `channel.closed` | channel_hash, duration_seconds, timestamp |
| `client.joined` | channel_hash, client_id, timestamp |
| `client.left` | channel_hash, client_id, reason, timestamp |
| `frame.rate_limited` | channel_hash, sender_role, timestamp |
| `frame.oversized` | channel_hash, sender_role, payload_bytes, timestamp |
| `relay.started` | listen_addr, tls_mode, max_channels, timestamp |

Discovery and signal forwarding should reuse structured relay logs; the relay does not log decrypted signal payloads because it never sees them.

## Reconnection

When either side reconnects:

1. Re-send `register` (gateway) or `join` (client).
2. Re-register discoverable identity if the gateway wants to remain discoverable.
3. Recreate any invite aliases if they are still desired.
4. Layer 1 session resumption remains outside relay scope.

Clients and gateways should use exponential backoff with jitter when reconnecting.

## Relay Status Endpoint

The relay MUST expose an unauthenticated health endpoint:

```text
GET /status
```

Example response:

```json
{
  "name": "openclaw-relay",
  "version": "1.0.0",
  "protocol_version": 1,
  "channels_active": 47,
  "channels_limit": 500,
  "uptime_seconds": 864000,
  "public": true
}
```

This endpoint is used by:

- OpenClaw gateway/plugin relay selection
- monitoring and health checks
- relay list validation tooling
