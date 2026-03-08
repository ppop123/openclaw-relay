# Deployment and Operations

> **Error codes reference:** See [`protocol/error-codes.json`](../protocol/error-codes.json) for the canonical machine-readable list.

## Prerequisites

- **Go 1.24+**

## Building

```bash
cd relay
go build -o openclaw-relay
```

## Running

Basic usage:

```bash
./openclaw-relay
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8443` | Listen port |
| `--tls` | `off` | TLS mode: `off`, `auto`, or `manual` |
| `--cert` | | Path to TLS certificate file (manual TLS mode) |
| `--key` | | Path to TLS private key file (manual TLS mode) |
| `--domain` | | Domain name for ACME/Let's Encrypt (auto TLS mode) |
| `--max-channels` | `500` | Maximum number of active channels |
| `--max-clients-per-channel` | `10` | Maximum clients per channel |
| `--rate-limit` | `100` | Maximum messages per second per channel |
| `--max-payload` | `1048576` | Maximum frame payload size in bytes (default 1MB) |
| `--public` | `false` | Expose relay as a public instance in /status |
| `--log-format` | `text` | Log format: `text` or `json` |
| `--allow-origin` | | Comma-separated allowed origin host patterns (e.g. `myapp.com,*.example.com`) |

## TLS Modes

### Off (development only)

```bash
./openclaw-relay
```

No encryption on the transport layer. Use only for local development. The relay itself does not handle TLS; place it behind a reverse proxy for production if using this mode.

### Auto (ACME / Let's Encrypt)

```bash
./openclaw-relay --tls auto --domain relay.example.com
```

Automatically obtains and renews TLS certificates via Let's Encrypt. Requires:

- `--domain` must be set to a publicly resolvable domain name
- Port **80** must be reachable for HTTP-01 challenges (the relay listens on `:80` automatically)
- Port **443** is used for the TLS listener

### Manual

```bash
./openclaw-relay --tls manual --cert /path/to/cert.pem --key /path/to/key.pem
```

Uses the provided certificate and key files. Both `--cert` and `--key` are required.

## Origin Validation

By default, the relay accepts only **same-origin** WebSocket connections and connections with **no Origin header** (non-browser clients). Browser clients from other origins receive `403 Forbidden`.

To allow specific cross-origin browser clients, pass a comma-separated list of **host patterns** (not full URLs):

```bash
./openclaw-relay --allow-origin app.example.com,*.example.com
```

## /status Endpoint

`GET /status` returns a JSON object with relay health and metrics:

```json
{
  "name": "openclaw-relay",
  "version": "0.3.0",
  "protocol_version": 1,
  "channels_active": 12,
  "channels_limit": 500,
  "connections_total": 34,
  "frames_forwarded_total": 98210,
  "frames_rejected_total": 7,
  "uptime_seconds": 86400,
  "public": false
}
```

## Capacity Planning

| Resource | Default | Notes |
|----------|---------|-------|
| Memory per channel | ~10 KB | Includes connection state and buffers |
| Max channels | 500 | Adjust with `--max-channels` |
| Max clients per channel | 10 | Adjust with `--max-clients-per-channel` |
| Rate limit | 100 msg/s per channel | Adjust with `--rate-limit` |
| Max payload | 1 MB | Adjust with `--max-payload` |

A relay with default settings and all 500 channels active uses approximately 5 MB of memory for channel state, plus overhead for WebSocket connections.

## Error Codes

The relay returns structured error codes in close frames and error responses:

| Code | Meaning |
|------|---------|
| `invalid_frame` | Frame could not be parsed or is malformed |
| `channel_occupied` | Another gateway is already registered on this channel |
| `channel_full` | Channel has reached `--max-clients-per-channel` |
| `payload_too_large` | Frame payload exceeds `--max-payload` |
| `rate_limited` | Channel exceeded `--rate-limit` messages per second |
| `client_id_required` | Client did not provide a client ID |

## Troubleshooting

**"Connection refused"**
Check that the relay is running, the port is correct, and firewall rules allow inbound connections. If using TLS auto mode, verify that both port 80 and 443 are accessible.

**"403 Forbidden"**
Origin mismatch. The connecting browser's origin is not in the allow list. Add the origin host with `--allow-origin your-app.example.com`.

**"channel_occupied"**
Another gateway has already registered on this channel token. Each channel supports exactly one gateway. Verify that you do not have a stale gateway process running.

**"payload_too_large"**
The frame exceeds the maximum payload size. Either reduce the payload size on the sender side or increase the limit with `--max-payload`.

**"rate_limited"**
The channel is sending more messages per second than the configured limit. Reduce message frequency or increase the limit with `--rate-limit`.

**Handshake timeout**
The gateway is offline or unreachable due to a network issue. Verify the gateway process is running and can reach the relay.

**Duplicate client_id**
When a client reconnects with the same client ID, the old connection is replaced. This is normal behavior and ensures reconnection stability. The old connection will be closed cleanly.

## Graceful Shutdown

Sending `SIGTERM` or `SIGINT` triggers a clean shutdown:

1. The relay stops accepting new connections.
2. Existing connections are notified with a close frame.
3. The relay waits up to **10 seconds** for in-flight frames to complete.
4. All connections are closed and the process exits.

## Logging

Use `--log-format json` for structured logging in production environments. This produces one JSON object per log line, suitable for ingestion by log aggregation systems.

```bash
./openclaw-relay --log-format json
```

Text format (default) is intended for local development and human reading.


## Installing the OpenClaw Gateway Plugin

Install the plugin into your own OpenClaw runtime:

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

Then enable and pair it against your relay:

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay pair --wait 30
openclaw relay status
```

Useful operational commands:

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```
