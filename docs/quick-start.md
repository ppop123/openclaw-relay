# Quick Start Guide

## Running the Relay Server (implemented)

Build and start a relay:

```bash
cd relay
go build -o openclaw-relay
./openclaw-relay
```

The relay listens on port 8443 by default. See [Deployment Guide](deployment.md) for TLS, origin validation, and production configuration.

Verify it's running:

```bash
curl http://localhost:8443/status
```

## Running Tests (implemented)

```bash
# Go relay server
cd relay && go test -v -count=1

# Python SDK
cd sdk/python && pip install -e ".[dev]" && pytest -q

# Web client
cd client && npm ci && npm test
```

## Self-Hosted Relay with TLS (implemented)

On a machine with a public IP and domain:

```bash
./openclaw-relay --tls auto --domain relay.yourdomain.com
```

This obtains a Let's Encrypt certificate automatically. Port 80 and 443 must be accessible.

## Using the Python SDK (implemented)

```python
from openclaw_relay import RelayClient

async with RelayClient(
    relay="wss://relay.example.com",
    token="your-channel-token",
    gateway_public_key="<base64>",
) as client:
    async for chunk in await client.chat("agent-name", "Hello!"):
        print(chunk.delta, end="")
```

---

## Planned: Gateway Plugin Integration (not yet implemented)

> The commands below require the gateway plugin (`plugin/`), which is **not yet implemented**. They describe the planned user experience.

### Zero-config with a public relay

```bash
# On your OpenClaw machine
openclaw relay enable
# → Discovers a public relay automatically
# → Displays a pairing code / QR

# On your client device
# Open the web client, enter pairing code → connected
```

### Connect to a specific relay

```bash
openclaw relay enable --server wss://relay.yourdomain.com
```

### Managing clients

```bash
openclaw relay pair              # Pair a new client
openclaw relay clients           # List connected clients
openclaw relay revoke <client_id> # Revoke a client
openclaw relay disable           # Disable relay
```

### Switching relays

Your encryption keys are independent of the relay. To switch:

```bash
openclaw relay enable --server wss://new-relay.example.com
```
