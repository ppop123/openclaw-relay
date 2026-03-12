# OpenClaw Relay JavaScript SDK

Node-focused JavaScript/TypeScript SDK for the OpenClaw Relay protocol (Layers 0–2).

## Requirements

- Node.js >= 22
- A pairing output containing `relayUrl`, `channelToken`, and `gatewayPublicKey`

## Install (local repo)

```bash
cd sdk/js
npm ci
```

## Basic Usage

```ts
import { RelayClient } from 'openclaw-relay-js';

const client = new RelayClient({
  relayUrl: 'wss://relay.example.com/ws',
  channelToken: 'your-channel-token',
  gatewayPublicKey: 'BASE64_GATEWAY_PUBLIC_KEY'
});

await client.connect();

// Non-streaming
const reply = await client.chat('fei', 'Hello there!', false);
console.log(reply.content);

// Streaming
for await (const chunk of await client.chat('fei', 'Stream it!', true)) {
  process.stdout.write(chunk.delta);
}

const agents = await client.agentsList();
console.log(agents.map(a => a.display_name));

await client.disconnect();
```

## Identity Persistence

If you want a stable client identity across reconnects, pass a stored identity
with `publicKey` and `privateKeyPkcs8` (both base64) to the constructor.

```ts
const client = new RelayClient({
  relayUrl,
  channelToken,
  gatewayPublicKey,
  identity: {
    publicKey: 'base64-public-key',
    privateKeyPkcs8: 'base64-private-key-pkcs8'
  }
});
```

## API Summary

- `connect()` / `disconnect()`
- `chat(agent, message, stream = true)`
- `agentsList()`
- `systemStatus()`
- `on(event, handler)` for NOTIFY events

See `src/` for full implementation details.
