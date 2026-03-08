# Quick Start Guide

> **Note**: This document describes the intended user experience of the planned implementation. The commands and flows below are not yet runnable.

## Scenario 1: Use a Public Relay (Easiest)

No server needed. Someone in the community is already running a relay for you.

### Step 1: Enable Relay on OpenClaw

```bash
openclaw relay enable
```

Output:

```
Discovering public relays...
  ✓ relay.alice.dev (cn-east, 23ms)
  ✓ relay.bob.cc (cn-south, 48ms)

Connected to: relay.alice.dev

Pair your client:
  Token:  kx8f-a3mv-9pqz
  Or scan:
  ████████████████
  ████████████████  (QR code)
  ████████████████
```

### Step 2: Open the Client

Open the web client in your browser. Enter the pairing info:
- Relay: `wss://relay.alice.dev` (auto-filled if using QR)
- Token: `kx8f-a3mv-9pqz`

Click **Connect**. Done.

### Step 3: Start Working

You can now interact with your OpenClaw agents from the client. The connection is end-to-end encrypted — the relay operator cannot read your messages.

---

## Scenario 2: Self-Hosted Relay

You want full control. Deploy your own relay.

### Step 1: Deploy Relay

On any machine with a public IP:

```bash
./openclaw-relay --port 443 --tls auto --domain relay.yourdomain.com
```

### Step 2: Connect OpenClaw

```bash
openclaw relay enable --server wss://relay.yourdomain.com
```

### Step 3: Pair Client

Same as Scenario 1 — enter the token in the web client.

---

## Scenario 3: LAN Only (No Relay Needed)

If you're always on the same network as your OpenClaw machine, you don't need a relay at all.

Open the client and point it directly at your gateway:

```
http://192.168.1.100:18789/console/
```

The gateway serves the client UI and API directly.

---

## Managing Clients

```bash
# See connected clients
openclaw relay clients

# Pair a new client
openclaw relay pair

# Revoke a client
openclaw relay revoke <client_id>

# Disable relay entirely
openclaw relay disable
```

## Switching Relays

Your encryption keys are independent of the relay. To switch:

```bash
openclaw relay enable --server wss://new-relay.example.com
```

The client will automatically reconnect to the new relay on next startup (or you can update the relay URL in the client settings).
