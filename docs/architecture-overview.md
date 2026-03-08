# Architecture Overview

This document describes the **current implemented architecture** of OpenClaw Relay.

It is intentionally shorter and more implementation-oriented than `docs/technical-design.md`.

## Scope

Officially supported components:

- `relay/` — Go relay server
- `sdk/python/` — Python client SDK
- `client/` — browser reference client
- `plugin/` — OpenClaw gateway plugin
- `protocol/` — protocol specification and examples

Not yet implemented:

- `sdk/js/`

## System Topology

```text
[Web / Python Client]  ── WSS ──>  [Relay]  <── WSS ──  [OpenClaw Gateway Plugin]
        │                               │                         │
        │                               │                         │
        └──── Layer 1/2/3 protocol ─────┴──────── routed to OpenClaw runtime
```

Design rule:

- the **relay** is a blind forwarder
- the **gateway plugin** owns pairing, identity approval, and runtime dispatch
- the **client** owns gateway key verification and end-to-end session setup

## Responsibilities by Component

| Component | Primary Responsibilities |
|----------|---------------------------|
| `relay/` | Channel registration, client join, presence, forwarding, Layer 0.5 discovery/signaling/invite alias routing, rate limiting, payload limits, origin validation |
| `sdk/python/` | Client-side protocol implementation (Layers 0–2), encryption, request/response handling |
| `client/` | Browser reference client, Layer 1/2 transport, UI, settings, message rendering |
| `plugin/` | Gateway-side relay adapter, pairing, approved-client persistence, operator-controlled discovery opt-in, internal peer signaling/invite control plane, OpenClaw runtime mapping |
| `protocol/` | Shared contract for frames, security model, transport lifecycle, application payloads |

## Protocol Layer Mapping

| Layer | Purpose | Main Sources |
|------|---------|--------------|
| Layer 0 / 0.5 | Channel routing plus gateway-only discovery/signaling/invite frames | `protocol/layer0-channel.md` |
| Layer 1 | Identity, handshake, session key derivation | `protocol/layer1-security.md` |
| Layer 2 | Request/response/streaming transport | `protocol/layer2-transport.md` |
| Layer 3 | Application methods | `protocol/layer3-application.md` |

## Main Runtime Flows

### 1. Gateway Registration

1. Gateway plugin derives `channel_hash = SHA-256(channelToken)`
2. Gateway opens a WebSocket to the relay
3. Gateway sends `register`
4. Relay marks the channel as occupied by one gateway connection

### 2. Client Connect + Pairing / Handshake

1. Client derives the same `channel_hash`
2. Client opens a WebSocket to the relay and sends `join`
3. Relay returns `joined` and indicates whether a gateway is online
4. Client sends Layer 1 `hello` inside an unencrypted `data` frame
5. Gateway decides whether the client is already approved or pairing is active
6. Gateway responds with `hello_ack`
7. Both sides derive a per-connection AES-GCM session key via HKDF
8. All later Layer 2 payloads are encrypted

### 3. Gateway-Only Peer Discovery Bootstrap

1. A gateway may register as discoverable with a discovery public key and opaque metadata
2. Any registered gateway may call `discover` to list currently discoverable peers on the same relay
3. A discoverable gateway may send encrypted `signal` frames to another discoverable gateway
4. The accepting gateway may create a short-lived invite alias
5. The initiating side joins via `JOIN.channel = invite_hash` and then proceeds through the normal `HELLO` / `HELLO_ACK` flow

Human-facing clients do not participate in this flow and must not expose it in UI.

### 4. Request / Response

1. Client encrypts a Layer 2 `request`
2. Gateway decrypts it and routes it to the OpenClaw runtime
3. Gateway sends encrypted `response`, or `stream_*` + final `response`
4. Client resolves the pending request or streaming state

## Storage Boundaries

| Component | What It Stores | What It Must Not Store |
|----------|-----------------|------------------------|
| `relay/` | In-memory channel/session state only | Application plaintext, long-term message history |
| `client/` | Safe UI settings, gateway public key, client id | `channelToken` |
| `plugin/` | Relay account config, gateway identity keys, approved clients | Application message history outside OpenClaw runtime |
| `sdk/python/` | Nothing by default; caller may persist identity keys | Relay-side state |

## Security Boundary Summary

- Relay cannot read application plaintext
- v1 uses **static X25519 identity keypairs** and **fresh per-connection nonces**
- v1 does **not** provide forward secrecy
- Browser client persists its identity keypair in IndexedDB when available, with page-memory fallback when persistence is unavailable
- Plugin approved-client persistence is the source of truth for gateway-side client trust
- The browser client currently uses a **user-supplied pinned gateway public key**, not an automatic TOFU accept-and-store flow

See `docs/security.md` for the full security notes.

## Test and Release Gates

The release gate currently covers:

- Go relay tests
- Python SDK tests
- Web client tests
- Plugin tests
- Plugin type check
- Protocol example validation
- Documentation consistency check

A local/manual lifecycle smoke also exists for the plugin:

- `bash scripts/smoke-openclaw-plugin.sh`

## Current Implementation Limits

- Single relay node only
- No JavaScript SDK yet
- Browser client identity persistence currently depends on IndexedDB availability in the browser environment
- Human-facing clients intentionally do not expose peer discovery or peer-contact UX
- Relay and plugin now implement the gateway-only Layer 0.5 control plane, including a host-only agent bridge, invite-scoped peer acceptance, outbound invite dialing, and a local `RelayPeerAgentService` for agent-side orchestration
- Plugin runtime integration depends on the current OpenClaw plugin APIs
- Hosted CI does not run the real OpenClaw lifecycle smoke

## Recommended Next Reads

- `docs/security.md`
- `docs/support-matrix.md`
- `docs/web-client.md`
- `docs/web-client/transport.md`
- `docs/web-client/identity-and-storage.md`
- `plugin/README.md`
- `protocol/`
