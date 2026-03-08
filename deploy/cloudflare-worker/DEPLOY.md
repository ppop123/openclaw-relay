# Deploy OpenClaw Relay to Cloudflare Workers

> **EXPERIMENTAL**: This Worker implementation is **not part of the official release**. It uses URL-based routing (`?role=gateway&id=...`) that is **incompatible with the standard protocol**. Standard SDK clients and the reference web client cannot connect to it. There are no automated tests, and CORS is set to `Access-Control-Allow-Origin: *`. Use for evaluation only.

## Prerequisites

- Cloudflare account with a domain configured
- Node.js installed (already done)

## Step 1: Login to Cloudflare

```bash
npx wrangler login
```

Browser will open for OAuth authorization. Click "Allow".

## Step 2: Configure your domain (optional)

Edit `wrangler.toml`, uncomment and update the routes section:

```toml
[[routes]]
pattern = "relay.yourdomain.com"
custom_domain = true
```

If you skip this, the relay will be available at `openclaw-relay.<your-account>.workers.dev`.

## Step 3: Deploy

```bash
cd ~/openclaw-relay/deploy/cloudflare-worker
npm run deploy
```

## Step 4: Verify

```bash
curl https://openclaw-relay.<your-account>.workers.dev/status
# or if custom domain:
curl https://relay.yourdomain.com/status
```

## WebSocket URL Format

Cloudflare Workers version uses URL-based routing:

```
wss://relay.yourdomain.com/ws/<channel_hash>?role=gateway
wss://relay.yourdomain.com/ws/<channel_hash>?role=client&id=<client_id>
```

The first frame (REGISTER/JOIN) is still sent for protocol compliance.

## Costs

On the Cloudflare **Free** plan:
- Workers: 100,000 requests/day
- Durable Objects: included (with usage limits)
- WebSocket messages count toward request limits
- Zero storage used (all state is in-memory)

This is more than enough for personal use.
