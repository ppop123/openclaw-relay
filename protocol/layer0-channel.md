# Layer 0: Channel Protocol

The channel layer runs directly over WebSocket. It handles connection registration, message routing, presence notification, and heartbeat. This is the only layer the relay server understands.

## Frame Format

All frames are JSON text WebSocket messages:

```json
{
  "type": "<frame_type>",
  ...fields depending on type
}
```

## Frame Types

### REGISTER (Gateway → Relay)

Sent by the gateway immediately after WebSocket connection is established.

```json
{
  "type": "register",
  "channel": "<channel_token_hash>",
  "version": 1
}
```

- `channel`: SHA-256 hash of the channel token (hex, 64 chars). The relay never sees the raw token.
- `version`: Protocol version. Must be `1`.

The relay responds:

```json
{
  "type": "registered",
  "channel": "<channel_token_hash>",
  "clients": 0
}
```

- `clients`: Number of clients currently connected to this channel.

If the channel already has a gateway registered, the relay responds with an error:

```json
{
  "type": "error",
  "code": "channel_occupied",
  "message": "Another gateway is already registered on this channel"
}
```

### JOIN (Client → Relay)

Sent by the client after WebSocket connection is established.

```json
{
  "type": "join",
  "channel": "<channel_token_hash>",
  "version": 1,
  "client_id": "<unique_client_id>"
}
```

- `client_id`: A persistent identifier for this client (UUID). Used by the gateway to distinguish multiple clients.

The relay responds:

```json
{
  "type": "joined",
  "channel": "<channel_token_hash>",
  "gateway_online": true
}
```

- `gateway_online`: Whether the gateway is currently connected.

If `gateway_online` is `false`, the client may stay connected and wait for a later `presence` event when the gateway comes online.

### DATA (Bidirectional)

Carries encrypted application data between client and gateway.

```json
{
  "type": "data",
  "from": "<client_id or 'gateway'>",
  "to": "<client_id or 'gateway'>",
  "payload": "<base64-encoded encrypted bytes>"
}
```

- `from`: Set by the sender. The relay verifies this matches the sender's registered role.
- `to`: The intended recipient. `"gateway"` to reach the gateway, or a specific `client_id`.
- `payload`: Base64-encoded encrypted data. The relay does not interpret this.

Because each client has an independent Layer 1 session key, the gateway MUST encrypt and send application traffic separately per client. `to: "*"` is therefore reserved and MUST NOT be used for Layer 1+ traffic in v1.

### PRESENCE (Relay → Both)

Sent by the relay when the other side connects or disconnects.

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

### PING / PONG (Bidirectional)

Application-level heartbeat (in addition to WebSocket-level ping/pong).

```json
{"type": "ping", "ts": 1709654321000}
```

```json
{"type": "pong", "ts": 1709654321000}
```

Both sides should send a PING every 30 seconds. If no PONG is received within 10 seconds, the connection should be considered dead and reconnected.

### ERROR (Relay → Sender)

```json
{
  "type": "error",
  "code": "<error_code>",
  "message": "<human-readable description>"
}
```

Error codes:

| Code | Description |
|------|-------------|
| `channel_occupied` | Another gateway already registered on this channel |
| `channel_limit_reached` | Maximum number of channels reached on this relay |
| `channel_full` | Maximum number of clients reached on this channel |
| `rate_limited` | Too many messages; slow down |
| `payload_too_large` | Message exceeds maximum size (default: 1 MB) |
| `invalid_frame` | Frame could not be parsed |

## Relay Behavior

1. The relay maintains a mapping: `channel_hash → {gateway_ws, [client_ws]}`.
2. When a DATA frame arrives from a client, the relay forwards it to the gateway (if connected).
3. When a DATA frame arrives from the gateway:
   - If `to` is a specific `client_id`, forward to that client only.
4. The relay MUST NOT modify the `payload` field.
5. The relay MUST NOT persist any DATA frames to disk.
6. The relay SHOULD enforce rate limits per channel (suggested: 100 messages/second).
7. The relay SHOULD enforce a maximum payload size (suggested: 1 MB).

## Abuse Controls

The relay MUST implement the following protections in v1:

- **Per-channel rate limiting**: Default 100 messages/second. Excess messages receive an `error` frame with code `rate_limited`.
- **Maximum payload size**: Default 1 MB. Oversized payloads receive `payload_too_large`.
- **Maximum channels**: Default 500. New REGISTER requests beyond this limit receive `channel_limit_reached`.
- **Maximum clients per channel**: Default 10. Excess JOIN requests receive `channel_full`.
- **Connection throttling**: The relay SHOULD limit the rate of new WebSocket connections per source IP (suggested: 10/second).

## Observability

The relay SHOULD emit structured log lines (JSON) for the following events:

| Event | Fields |
|-------|--------|
| `channel.registered` | channel_hash, timestamp |
| `channel.closed` | channel_hash, duration_seconds, timestamp |
| `client.joined` | channel_hash, client_id, timestamp |
| `client.left` | channel_hash, client_id, reason, timestamp |
| `frame.rate_limited` | channel_hash, sender_role, timestamp |
| `frame.oversized` | channel_hash, sender_role, payload_bytes, timestamp |
| `relay.started` | listen_addr, tls_mode, max_channels, timestamp |

The `/status` endpoint SHOULD additionally report:
- `connections_total`: Total active WebSocket connections
- `frames_forwarded_total`: Counter of DATA frames forwarded since startup
- `frames_rejected_total`: Counter of rejected frames (rate limit, oversized, etc.)

## Reconnection

When either side reconnects:

1. Re-send REGISTER (gateway) or JOIN (client).
2. The relay sends PRESENCE notifications to the other side.
3. Application-level session resumption is handled at Layer 2 (not the relay's concern).

Clients and gateways SHOULD implement exponential backoff when reconnecting: initial delay 1s, max delay 60s, with jitter. The relay does not track or enforce reconnection behavior.

## Relay Status Endpoint

The relay MUST expose an HTTP endpoint for health checks:

```
GET /status

200 OK
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

This endpoint requires no authentication and is used by:
- OpenClaw plugin to discover and select public relays
- Monitoring tools to check relay health
- The `relays.json` list validation
