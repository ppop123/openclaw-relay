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

# OpenClaw gateway plugin
cd client && npm ci && cd .. && client/node_modules/.bin/vitest run plugin/tests
cd deploy/cloudflare-worker && npm ci && cd ../.. && deploy/cloudflare-worker/node_modules/.bin/tsc -p plugin/tsconfig.json --noEmit
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

## Installing the OpenClaw Gateway Plugin (implemented)

Install the plugin into your own OpenClaw runtime:

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

Enable relay access for your local OpenClaw gateway:

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay pair --wait 30
openclaw relay status
```

Manage approved clients:

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```
