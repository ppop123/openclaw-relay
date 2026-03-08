# Self-Hosting a Relay

> **Note**: This document describes the planned deployment experience. The relay binary and Docker image are not yet available.

## Requirements

- A machine with a public IP (VPS, cloud instance, home server with port forwarding)
- Port 443 (or any port) accessible from the internet
- Optional: a domain name (required for auto TLS)

## Quick Start

### Option 1: Binary

Download the latest release for your platform:

```bash
# Linux amd64
curl -L https://github.com/openclaw/relay/releases/latest/download/openclaw-relay-linux-amd64 -o openclaw-relay
chmod +x openclaw-relay

# macOS arm64
curl -L https://github.com/openclaw/relay/releases/latest/download/openclaw-relay-darwin-arm64 -o openclaw-relay
chmod +x openclaw-relay
```

Run with auto TLS (requires a domain pointed to this machine):

```bash
./openclaw-relay --port 443 --tls auto --domain relay.yourdomain.com
```

Run without TLS (behind a reverse proxy like nginx/Caddy):

```bash
./openclaw-relay --port 8443 --tls off
```

### Option 2: Docker

```bash
docker run -d \
  --name openclaw-relay \
  -p 443:443 \
  ghcr.io/openclaw/relay \
  --tls auto --domain relay.yourdomain.com
```

### Option 3: Docker Compose

```yaml
services:
  relay:
    image: ghcr.io/openclaw/relay
    ports:
      - "443:443"
    command: --tls auto --domain relay.yourdomain.com --public
    restart: unless-stopped
```

## Behind a Reverse Proxy

If you already run nginx or Caddy, let them handle TLS:

**Caddy:**

```
relay.yourdomain.com {
    reverse_proxy localhost:8443
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name relay.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

Then run the relay without TLS:

```bash
./openclaw-relay --port 8443 --tls off
```

## Making It Public

To share your relay with the community:

1. Add the `--public` flag when starting the relay
2. Verify the `/status` endpoint is accessible:
   ```bash
   curl https://relay.yourdomain.com/status
   ```
3. Fork the openclaw-relay repository
4. Add your relay to `relays.json`:
   ```json
   {
     "url": "wss://relay.yourdomain.com",
     "region": "cn-east",
     "operator": "your-github-username",
     "operator_url": "https://github.com/your-username",
     "capacity": 500,
     "since": "2026-03-07"
   }
   ```
5. Submit a pull request

## Monitoring

The relay logs to stdout. Key log lines:

```
INFO  relay started on :443
INFO  channel opened: a8f3c2... (gateway connected)
INFO  channel joined: a8f3c2... (client abc123)
WARN  rate limited: a8f3c2... (exceeded 100 msg/s)
INFO  channel closed: a8f3c2... (gateway disconnected)
```

For JSON structured logging (recommended for production), start with:

```bash
./openclaw-relay --port 8443 --tls off --log-format json
```

Key metrics to monitor via the `/status` endpoint:

| Metric | Warning threshold |
|--------|------------------|
| `channels_active` / `channels_limit` | > 80% |
| `connections_total` | Sudden drops indicate network issues |
| `frames_rejected_total` | Sustained increase indicates abuse |

Monitor the `/status` endpoint for health:

```bash
watch -n 30 'curl -s https://relay.yourdomain.com/status | jq .'
```

## Operational Notes

- **Restart behavior**: The relay holds no persistent state. On restart, all channels are dropped. Connected gateways and clients will automatically reconnect with exponential backoff.
- **Graceful shutdown**: Send SIGTERM. The relay will close all WebSocket connections with a 1001 (Going Away) close code. Clients should treat this as a transient disconnection.
- **Abuse handling**: The relay enforces per-channel rate limits and payload size caps. Abusive connections are terminated with an error frame. No IP banning in v1 — use firewall rules if needed.
- **Single-node only (v1)**: Do not run multiple relay instances behind a load balancer. WebSocket connections are stateful and channel state is not shared between instances.

## Resource Usage

The relay is extremely lightweight:

- **Memory**: ~50 MB base + ~10 KB per active channel
- **CPU**: Negligible (just forwarding bytes)
- **Bandwidth**: Proportional to user traffic (relay adds no overhead)
- **Disk**: Zero (no persistence)

A $5/month VPS can handle hundreds of concurrent channels.
