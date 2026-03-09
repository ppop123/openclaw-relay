# Quick Start Guide

## Most people only need this

If your goal is simply **"I want to use my own OpenClaw from outside my home or office"**, the shortest path is:

1. Start a relay server
2. Install the relay plugin into your own OpenClaw
3. Open the browser client and connect

What this gives you:

- remote access to **your own** OpenClaw
- no public IP requirement
- no port forwarding
- end-to-end encrypted application traffic

What this does **not** mean:

- it is **not** a public directory of other people's OpenClaw instances
- human-facing clients do **not** browse or contact other OpenClaw instances
- clustering / federation / HA are not part of v1

## Step 1: Start a relay server

```bash
cd relay
go build -o openclaw-relay
./openclaw-relay
```

The relay listens on port `8443` by default.

Check that it is up:

```bash
curl http://localhost:8443/status
```

For TLS, origin validation, Cloudflare Tunnel, and production notes, see [Deployment Guide](deployment.md).

## Step 2: Install the plugin into your own OpenClaw

Install the plugin:

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

Enable relay access for your local OpenClaw gateway:

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay status
```

When you are ready to connect from the browser, start pairing in one terminal:

```bash
openclaw relay pair
```

`openclaw relay pair` prints the pairing details and keeps the pairing window open (default 5 minutes). While the command is waiting, open the browser client and enter the printed relay URL, channel token, and gateway public key.

Useful day-2 commands:

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

## Step 3: Connect from the browser

Use the browser client in `client/` and enter:

- relay URL
- channel token
- gateway public key

Then connect.

The browser client docs live here:

- [`docs/web-client.md`](web-client.md)
- [`docs/web-client/testing-and-troubleshooting.md`](web-client/testing-and-troubleshooting.md)

## Advanced: agent-only peer capability

There is also an **agent-only** capability that lets one OpenClaw agent talk to another OpenClaw agent.

Important boundary:

- gateways / agents may use it
- human-facing clients may **not** use it to find or contact other OpenClaw instances

If you want that flow, start here:

- [`plugin/README.md`](../plugin/README.md)

## Development checks

```bash
# Go relay server
cd relay && go test -v -count=1

# Python SDK
cd sdk/python && pip install -e ".[dev]" && pytest -q

# Web client
cd client && npm ci && npm test

# OpenClaw gateway plugin
cd plugin && npm ci && npm test
cd plugin && npm run typecheck
```

## Local smoke validation

For a real local OpenClaw runtime smoke test:

```bash
bash scripts/smoke-openclaw-plugin.sh
```

This script installs `plugin/` into an isolated OpenClaw state directory, starts a local relay, performs pairing with a fresh client identity, starts a real OpenClaw gateway, verifies `system.status` over the relay, then exercises `revoke`, re-pair, `rotate-token`, and `disable` behavior.
