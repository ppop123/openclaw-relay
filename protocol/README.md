# OpenClaw Relay Protocol Specification

Version: 1.0-draft
Status: Draft specification. This document defines the target protocol for OpenClaw Relay v1. It has not yet been validated by a reference implementation.

## Overview

The OpenClaw Relay Protocol defines how a client application communicates with an OpenClaw gateway through a relay server. The protocol is layered:

```
Layer 3: Application Protocol  — What the client and gateway say to each other
Layer 2: Transport Protocol    — Request/response framing, streaming, multiplexing
Layer 1: Security Layer        — End-to-end encryption, key exchange
Layer 0: Channel Layer         — Relay routing, presence, heartbeat
         WebSocket (TLS)       — Network transport
```

The relay server only understands Layer 0. Layers 1-3 are opaque to it.

Each layer is specified in its own document:

- [Layer 0: Channel](layer0-channel.md) — Relay framing and routing
- [Layer 1: Security](layer1-security.md) — End-to-end encryption
- [Layer 2: Transport](layer2-transport.md) — Request/response and streaming
- [Layer 3: Application](layer3-application.md) — OpenClaw API semantics

## Design Principles

1. **Relay is dumb**: The relay only matches connections by channel token and forwards bytes. It never parses, stores, or modifies application data.

2. **E2E encryption is mandatory**: Every message above Layer 0 is encrypted. The relay, even if compromised, cannot read message content.

3. **Protocol is transport-agnostic at the application layer**: Layer 3 messages are JSON. Clients and gateways can extend or customize application messages freely. The protocol does not dictate what actions are available.

4. **Simplicity over features**: Each layer does one thing. No layer depends on layers above it.

## v1 Scope

The following constraints apply to version 1 of the protocol:

- **Single relay node**: No clustering, federation, or relay-to-relay communication.
- **No forward secrecy**: Identity keys are static; session keys are ephemeral per connection but derived from long-term keys.
- **No application-layer broadcast**: Each client has an independent encrypted session. The gateway encrypts and sends messages per-client.
- **Restart-tolerant, not HA**: Relay state is in-memory. A relay restart drops all channels; clients and gateways reconnect and re-establish sessions.

## Roles

There are three roles in the system:

- **Gateway**: An OpenClaw instance. Connects to the relay and registers a channel. Exactly one gateway per channel.
- **Client**: An application that wants to interact with a gateway. Connects to the relay and joins a channel. Multiple clients can share one channel.
- **Relay**: A server that matches gateways and clients on the same channel and forwards messages between them.

## Connection Lifecycle

```
1. Gateway connects to relay via WebSocket
2. Gateway sends REGISTER frame with channel_token
3. Relay acknowledges, gateway is now "online" for this channel
4. Client connects to relay via WebSocket
5. Client sends JOIN frame with channel_token
6. Relay acknowledges, notifies client of gateway presence
7. Client and gateway exchange HELLO (Layer 1 key negotiation)
8. Encrypted communication begins (Layers 2-3)
9. Either side may disconnect; relay notifies the other
```
