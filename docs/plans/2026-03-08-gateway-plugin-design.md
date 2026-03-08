# Gateway Plugin Design

## Summary

Implement the OpenClaw Relay gateway plugin in `plugin/` as a TypeScript channel integration that connects a locally running OpenClaw gateway to a public relay server. The plugin owns Layers 0-2 of the relay protocol and maps standard Layer 3 requests into OpenClaw runtime calls.

**Phase 1 scope:**
- Implement all currently standardized Layer 3 **request** methods defined in `protocol/layer3-application.md`
- Implement Layer 0 registration/reconnect and Layer 1 HELLO/HELLO_ACK handshake
- Implement per-client encrypted Layer 2 request/response and streaming
- Implement explicit pairing CLI flow and client revocation

**Deferred unless upstream runtime hooks are verified:**
- Standard Layer 3 `notify` events such as `agent.output`, `agent.status`, and `system.alert`
- Layer 1 key rotation beyond reconnect-based fresh session keys

## Architecture

```text
[Relay Client]  ──WSS──>  [Relay Server]  <──WSS──  [Gateway Plugin]  ──in-process──  [OpenClaw Runtime]
  (anywhere)              (public)                   (plugin/)                          (local process)
```

The plugin should behave like a native OpenClaw channel integration, but the relay protocol remains authoritative for wire behavior. The relay only understands Layer 0. The plugin is responsible for:
- Layer 0: relay connection lifecycle and routing
- Layer 1: client authorization, key agreement, encryption
- Layer 2: request/response multiplexing and streaming
- Layer 3 bridge: mapping protocol methods into OpenClaw runtime calls

## Canonical Sources

This design is subordinate to the protocol and AI-first truth sources already in the repo:

- `docs/ai-implementation-guide.md`
- `docs/release-manifest.json`
- `protocol/layer0-channel.md`
- `protocol/layer1-security.md`
- `protocol/layer2-transport.md`
- `protocol/layer3-application.md`
- `protocol/error-codes.json`
- `protocol/examples/*.json`

If this document conflicts with those sources, this document must be updated before implementation starts.

## Non-Negotiable Protocol Constraints

1. The relay plugin is a **gateway-side** implementation. It is not a generic JS SDK.
2. The channel token is a **gateway-side bearer secret**. Only the gateway stores it durably.
3. Client authorization is based on **static X25519 identity keys**, not on `client_id`.
4. Session keys are derived per connection from long-term identity keys plus fresh nonces.
5. Once a Layer 1 session is established, all Layer 0 `data.payload` traffic must be encrypted.
6. Decryption failures are silently dropped.
7. The plugin must not invent alternate Layer 2 or Layer 3 field names.

## Upstream API Verification Status

This repository does **not** vendor the OpenClaw core source, but the public OpenClaw docs are sufficient to verify part of the plugin surface.

### Verified from public plugin docs

| API / behavior | Use in relay plugin | Verification status |
|---------------|---------------------|---------------------|
| `api.registerChannel({ plugin })` | Register relay as a messaging channel | Verified |
| `api.registerCli(...)` | Register `openclaw relay ...` top-level CLI commands | Verified |
| `api.registerCommand(...)` | Register in-channel slash / auto-reply commands | Verified, but **not** for top-level CLI |
| `openclaw.plugin.json` manifest | Manifest + config schema | Verified |
| Channel config under `channels.<id>` | Relay channel configuration location | Verified |
| `config.listAccountIds` + `config.resolveAccount` | Core channel config adapter surface | Verified |
| `config.inspectAccount` | Read-only status / doctor flows | Verified as recommended |
| Optional channel adapters such as `gateway`, `security`, `status`, `streaming` | Relay-specific channel behavior | Verified as supported extension points |
| Preferred SDK import path | Use `openclaw/plugin-sdk/core` for new external plugins | Verified |

### Documented, but not yet stable enough to treat as a hard contract

These runtime helpers appear in public Plugin SDK refactor documentation, but not in the stable plugin guide. Treat them as **likely target surfaces**, not guaranteed names, until checked against the actual OpenClaw version being integrated.

| Runtime helper | Intended use | Verification status |
|---------------|--------------|---------------------|
| `api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...)` | Stream model output back to relay clients | Proposal / refactor doc only |
| `api.runtime.channel.routing.resolveAgentRoute(...)` | Resolve relay peer -> agent/session binding | Proposal / refactor doc only |
| `api.runtime.channel.pairing.*` helpers | Pairing UX / allowlist helpers | Proposal / refactor doc only |

**Implementation gate:** before writing code that depends on `api.runtime.channel.*`, verify the exact SDK package name, OpenClaw version, and runtime type signatures in the target OpenClaw installation or source tree. If the actual runtime differs, update this design first; do not silently adapt code away from the design.

## Runtime Requirements

- Target language: TypeScript
- Target runtime: the OpenClaw runtime version whose embedded Node/WebCrypto implementation is verified to support X25519, AES-GCM, and HKDF
- Development / CI target: Node 22 LTS until a stricter OpenClaw runtime contract is documented
- SDK import target: prefer `openclaw/plugin-sdk/core` for generic plugin APIs unless the verified OpenClaw build exposes a more specific relay/channel subpath

Do **not** assume `Node >=16` is sufficient without an explicit upstream compatibility check.

## Responsibility Areas

The plugin needs three required responsibility areas, whether implemented as formal adapters or internal services depends on the upstream OpenClaw SDK shape.

### Required Responsibilities

| Responsibility | What it does |
|---------------|--------------|
| `config` | Resolve relay configuration, gateway key material, approved client records |
| `gateway` | Open WebSocket, send `register`, reconnect, process presence/data/error frames |
| `outbound` | Send encrypted Layer 2 responses, stream chunks, and optional notifications |

### Optional / Conditional Responsibilities

| Responsibility | When needed |
|---------------|-------------|
| `pairing` | Approve or revoke client public keys |
| `status` | Report relay connection health |
| `capabilities` | Advertise supported request methods / streaming support |
| `directory` | List paired clients |
| `notifications` | Only if upstream runtime exposes stable event hooks |

### Explicitly Not Needed in v1 Plugin

| Concern | Why |
|--------|-----|
| Group chat model | Relay protocol is gateway-centric, not group-centric |
| OAuth / QR login | Pairing is key-based, not third-party auth-based |
| Thread model | Relay protocol has no thread semantics |
| Broadcast payloads | Each client has its own Layer 1 session |

## Registration Model

**Illustrative pseudocode only — stable registration concepts are verified, but runtime helper names are not.**

```ts
export default {
  id: "relay",
  name: "OpenClaw Relay",
  register(api: unknown) {
    // register relay channel integration via api.registerChannel({ plugin })
    // register top-level CLI via api.registerCli(...)
    // do not use api.registerCommand(...) for `openclaw relay ...`
  },
}
```

This section is intentionally schematic. The important design decision is **native plugin registration plus CLI subcommands**, not the exact current symbol names.

## Configuration Schema

Store relay configuration in `openclaw.json` under `channels.relay`. Upstream channel-plugin guidance recommends `channels.<id>.accounts.<accountId>` for multi-account channels. For relay v1, use a single default account unless verified product requirements demand multiple relay accounts.

```json
{
  "channels": {
    "relay": {
      "accounts": {
        "default": {
          "enabled": true,
          "server": "wss://relay.example.com",
          "channelToken": "kx8f-a3mv-9pqz-...",
          "gatewayKeyPair": {
            "privateKey": "<base64 X25519 private key>",
            "publicKey": "<base64 X25519 public key>"
          },
          "approvedClients": {
            "sha256:8f2a...": {
              "publicKey": "<base64>",
              "label": "My Phone",
              "firstPairedAt": "2026-03-08T10:00:00Z",
              "lastSeenClientId": "client_uuid_1",
              "lastSeenAt": "2026-03-08T10:30:00Z"
            }
          }
        }
      }
    }
  }
}
```

### Configuration Rules

- Persist the **raw** `channelToken`; derive `channel = sha256(channelToken)` at runtime.
- Do **not** persist a separate `channelTokenHash` field; it is derived data and creates dual truth.
- `approvedClients` are keyed by **public key fingerprint**, not by `client_id`.
- `client_id` is transport routing state only and may change independently of a paired identity.
- Implement both `config.resolveAccount(...)` and `config.inspectAccount(...)` so read-only status / doctor flows do not need to materialize runtime secrets.

## Identity Binding Policy

This is the most important implementation rule in the entire design.

### Security Identity vs Transport Identity

- **Security identity** = client X25519 public key fingerprint
- **Transport identity** = Layer 0 `client_id`

The plugin authorizes clients by **public key**, not by `client_id`.

### Active Session State

The plugin maintains:

```ts
type ApprovedClient = {
  fingerprint: string
  publicKey: Uint8Array
  label?: string
  firstPairedAt: string
  lastSeenClientId?: string
  lastSeenAt?: string
}

type ClientSession = {
  clientId: string
  fingerprint: string
  publicKey: Uint8Array
  sessionCipher: SessionCipher
  connectedAt: Date
  lastActivity: Date
}

approvedClientsByFingerprint: Map<string, ApprovedClient>
activeSessionsByClientId: Map<string, ClientSession>
activeClientIdByFingerprint: Map<string, string>
```

### Binding Rules

1. On HELLO from an **approved public key** with a new `client_id`, accept it and update `lastSeenClientId`.
2. If that public key already has an active session under another `client_id`, the new session replaces the old one.
3. On HELLO with the **same `client_id` but a different public key**, reject it unless pairing mode is active.
4. On HELLO from an **unknown public key** outside pairing mode, silently drop it.
5. Revocation removes the approved fingerprint record and terminates all active sessions for that fingerprint.

### Compatibility Note: Web Reference Client

The current web reference client persists its identity keypair in IndexedDB when available. After a normal page reload in the same browser profile it therefore keeps the same public key. A strict gateway plugin should recognize it as the same approved client across reconnects and normal reloads. Only identity reset or IndexedDB-unavailable fallback should cause the browser to present a new public key.

## Connection Lifecycle

### Startup (`gateway.startAccount` conceptual flow)

```text
1. Load relay config (server, raw channel token, gateway keypair, approved clients)
2. Derive channel hash = SHA-256(channelToken)
3. Open WebSocket to relay server
4. Send REGISTER frame: { type: "register", channel: "<hash>", version: 1 }
5. Receive REGISTERED confirmation
6. Enter main frame loop
7. On disconnect: exponential backoff reconnect (1s -> 60s, with jitter)
```

### Inbound Frame Flow

```text
1. Receive Layer 0 frame from relay
2. If type == presence: update runtime connection state
3. If type == error: fail pending operations / reconnect as appropriate
4. If type != data: ignore or handle per Layer 0 spec
5. If type == data:
   a. Read client_id from frame.from
   b. Look up active session by client_id
   c. If no active session exists:
      - parse payload as unencrypted JSON
      - only HELLO is allowed here
      - verify protocol_version and client public key
      - if approved or pairing mode active: derive session key and send HELLO_ACK
      - otherwise silently drop
   d. If active session exists:
      - payload MUST be encrypted
      - decrypt using session cipher
      - parse Layer 2 message and dispatch
```

### Outbound Frame Flow

```text
1. Produce canonical Layer 2 message
2. Encrypt with the target client's session cipher
3. Wrap in Layer 0 DATA frame with to: "<client_id>"
4. Send over WebSocket
```

No gateway-side broadcast path exists for Layer 1+ traffic.

## Pairing Flow

Triggered by `openclaw relay pair`.

```text
1. If gateway identity or channel token do not yet exist, generate them
2. Enter pairing mode with 5-minute timeout
3. Display pairing material:
   - relay URL
   - raw channel token
   - gateway public key
   - optional fingerprint / QR representation
4. Wait for first HELLO from an unknown public key
5. If HELLO arrives during pairing mode:
   a. compute client fingerprint
   b. store approved client record keyed by fingerprint
   c. complete HELLO_ACK
   d. establish session
   e. exit pairing mode
6. On timeout: exit pairing mode without approving anyone
```

Pairing URI format remains:

```text
openclaw-relay://relay.example.com/<channel-token>#<base64-gateway-pubkey>
```

## Layer 1 Implementation Notes

The plugin should reuse the same cryptographic model as the protocol and web client:

- X25519 for ECDH
- HKDF-SHA256 for session key derivation
- AES-256-GCM for message encryption
- Directional 12-byte nonces
- 64-message replay window

### Important Clarifications

- Gateway identity keys are **static across reconnects**.
- Session keys are **fresh per connection** because each side contributes a fresh session nonce.
- The plugin must not generate a new gateway identity keypair per WebSocket connect.
- `hello` and `hello_ack` are the only unencrypted Layer 1 messages.
- After session establishment, plaintext Layer 0 `data.payload` from an already-established client is silently dropped.

## Layer 2 / Layer 3 Mapping

`protocol/layer3-application.md` is the canonical source for all method names, parameter names, response field names, and notification payloads. The plugin must map runtime behavior to that schema, not redefine it here.

### Standard Request Methods in Phase 1

#### `chat.send`

- Resolve target agent according to OpenClaw binding / default-agent rules
- If `params.stream == true`, emit canonical Layer 2 sequence:
  - `stream_start`
  - one or more `stream_chunk`
  - `stream_end`
  - final `response` carrying metadata/result fields required by Layer 3
- If `params.stream == false`, send a single canonical `response`

Do **not** move final metadata into `stream_end`; Layer 2 and Layer 3 already define the correct split.

#### `agents.list`

Map runtime agent inventory into the canonical response shape:
- `name`
- `display_name`
- `status`
- `description`

#### `agents.info`

Map runtime agent detail lookup into the canonical response shape:
- `name`
- `display_name`
- `status`
- `description`
- `tools`
- `recent_sessions`

#### `sessions.list`

Preserve canonical request and response fields, including:
- request: `agent`, `limit`, `offset`
- response: `sessions`, `total`
- per session: `id`, `agent`, `started_at`, `last_message_at`, `message_count`, `preview`

#### `sessions.history`

Preserve canonical request and response fields, including:
- request: `session_id`, `limit`, `before`
- response: `messages`, `has_more`

#### `cron.list`

Use the canonical Layer 3 response shape:
- top-level `tasks`
- each task includes `id`, `name`, `agent`, `schedule`, `enabled`, `last_run`, `last_status`

#### `cron.toggle`

Use canonical request parameters:
- `id`
- `enabled`

Return canonical `response.result`.

#### `system.status`

Return the canonical Layer 3 shape, not an invented plugin-specific one.

### Notification Events

Standard `notify` events (`agent.output`, `agent.status`, `system.alert`) are **not removed from the protocol**, but plugin support depends on whether OpenClaw exposes stable runtime event hooks.

Implementation rule:
- if upstream runtime event hooks are verified, implement them using canonical Layer 3 event payloads
- if not verified, explicitly defer them and do not invent substitute events

## Phase 1 Implementation Decisions

These decisions are now fixed for the initial implementation. If any of them need to change later, update this document before changing code.

### 1. Permission Model

Phase 1 uses a **full-trust paired client** model.

- Any client that completes Layer 1 using an approved public key is treated as an administrative client for this gateway.
- Standard Layer 3 methods in scope (`chat.send`, `agents.list`, `agents.info`, `sessions.list`, `sessions.history`, `cron.list`, `cron.toggle`, `system.status`) are allowed for paired clients.
- `permission_denied` is reserved for:
  - unpaired / unauthorized clients that somehow reach Layer 2
  - methods intentionally disabled by local gateway policy
  - future finer-grained ACLs
- Phase 1 does **not** implement per-method or per-client ACLs.

Rationale: pairing is the security boundary in v1. Adding partial authorization now would add policy complexity without a verified upstream product requirement.

### 2. Request Cancellation Model

Layer 2 `cancel` support is mandatory and must map to runtime execution.

The plugin must maintain:

```ts
pendingRequestsById: Map<string, {
  clientId: string
  abortController: AbortController
  startedAt: number
}>
```

Rules:
- On inbound `request`, create an `AbortController` and store it under the Layer 2 `id`.
- Pass `abortController.signal` through the runtime call path wherever the upstream OpenClaw API allows cancellation.
- On inbound `cancel`, abort the matching controller and stop producing further stream output for that `id`.
- If work has not yet completed, send a final canonical `response` with `error.code = "cancelled"`.
- If the runtime does not support true cancellation for a specific method, the plugin must still mark the request as cancelled locally and suppress any later output for that `id`.
- Session teardown, reconnect, or client disconnect must abort all pending controllers for that client.

### 3. Version and Capability Negotiation

Phase 1 uses a conservative compatibility rule aligned with the current protocol docs.

Rules:
- For Layer 0 frames, accept missing `version`, `0`, or `1` as protocol v1 behavior.
- Reject `version > 1`.
- For Layer 1 `hello` / `hello_ack`, require `protocol_version` to be missing, `0`, or `1`; reject values `> 1`.
- The gateway should always send `version: 1` in Layer 0 and `protocol_version: 1` in Layer 1.
- `capabilities` are **informational**, not an authorization mechanism.
- The plugin may use peer capabilities to decide optional behavior, but must not assume a capability is present unless explicitly advertised.
- A missing `capabilities` field means "minimal v1 peer".

Implementation note:
- Persist negotiated peer capabilities in the in-memory session object only.
- Do not store them durably in config.

### 4. Secret Redaction and Safe Inspection

The plugin must treat the following as secrets:
- `channelToken`
- `gatewayKeyPair.privateKey`

The following are not secrets but still security-relevant:
- `gatewayKeyPair.publicKey`
- approved client public keys / fingerprints
- derived channel hash

Rules:
- `config.inspectAccount(...)` must never return raw `channelToken` or raw private key material.
- Structured logs must never contain raw `channelToken`, raw private key, decrypted payloads, or full unredacted pairing URIs.
- CLI output for `relay pair` may show the raw channel token only at explicit pairing time.
- CLI output for `relay clients` should prefer fingerprint, label, and timestamps over raw public keys.
- Status / doctor output may include relay URL, channel hash, connected state, approved client fingerprints, and last-seen metadata.

Recommended `inspectAccount` shape:

```json
{
  "enabled": true,
  "server": "wss://relay.example.com",
  "channel": "<derived sha256 hex>",
  "gatewayPublicKey": "<base64>",
  "approvedClients": [
    {
      "fingerprint": "sha256:8f2a...",
      "label": "My Phone",
      "lastSeenAt": "2026-03-08T10:30:00Z"
    }
  ]
}
```

### 5. Layer 0 Error Handling Matrix

Layer 0 relay errors are not all equal. The plugin must handle them by code, not by a single generic reconnect policy.

| Error code | Phase 1 behavior |
|-----------|------------------|
| `channel_occupied` | Fatal for this account instance. Mark account unhealthy, log actionable error, stop automatic reconnect until operator action. |
| `channel_limit_reached` | Fatal for this relay target. Stop reconnect loop and surface operator error. |
| `channel_full` | Gateway should not normally receive this after `register`; if observed, log protocol anomaly and reconnect once. |
| `rate_limited` | Non-fatal. Apply backoff / throttling and keep connection alive if still usable. |
| `payload_too_large` | Request-level or frame-level bug. Fail the affected outbound operation, log payload metrics, keep connection alive. |
| `invalid_frame` | Treat as implementation bug or protocol violation. Log high severity and reconnect once; if repeated, mark unhealthy. |
| transport close / network error | Reconnect with exponential backoff and fail pending requests for the affected sessions. |

Implementation requirements:
- Relay `error` frames must be surfaced to request/session state, not only logged.
- Fatal registration errors must not loop forever.
- Non-fatal request-level errors must not tear down a healthy WebSocket unnecessarily.

### 6. Request Admission and Backpressure

A publishable gateway plugin must protect the local OpenClaw runtime from relay clients, even if those clients are legitimately paired.

Phase 1 limits:
- Maximum concurrent in-flight requests per client: **4**
- Maximum concurrent in-flight requests across the plugin: **16**
- Maximum request body size after Layer 1 decryption and JSON parse: bounded by relay payload limit, but the plugin should still reject obviously oversized semantic inputs before dispatching to runtime

Rules:
- If a client exceeds its per-client or global concurrency limit, reject the new request immediately.
- Do **not** use `permission_denied` for overload.
- Do **not** use `timeout` unless the gateway actually spent time processing and then exceeded a runtime deadline.
- Until the protocol defines a dedicated overload code, map admission rejection to `response.error.code = "internal_error"` with a stable message such as `"gateway request limit reached"`.
- Do not enqueue unbounded pending work.
- Streaming responses count against the concurrency limit until the final `response` is sent.

Implementation note:
- Document the chosen concurrency limits in `openclaw.plugin.json` / plugin docs so operators can tune them later.

### 7. Method Availability and Capability Advertisement

A publishable plugin must not claim Layer 3 features it does not actually support.

Rules:
- The plugin's Layer 1 `hello_ack.capabilities` must be derived from the runtime features actually available in the current OpenClaw installation.
- If a standard method is unavailable in the current runtime build:
  - omit the corresponding capability from `hello_ack.capabilities`
  - reject the request with `method_not_found`
- Do not advertise `stream` unless runtime streaming is verified for this account.
- Do not advertise cron- or session-related capabilities if the current runtime cannot serve them.

Phase 1 expectation:
- The design target remains full support for the currently standardized request methods.
- But the implementation must still degrade honestly if the upstream runtime surface is narrower than expected.

### 8. Token Rotation and Disable Semantics

A publishable plugin must define what happens when the channel token is compromised or relay access is intentionally shut down.

Rules:
- `openclaw relay disable` means:
  - disconnect from relay
  - mark the relay account disabled in config
  - keep gateway identity keypair and approved client records by default
  - do **not** silently delete secrets or pairing records
- A separate rotation flow is required for compromised bearer secrets.

Planned CLI surface:
- `openclaw relay rotate-token`

`rotate-token` behavior:
- generate a fresh channel token
- persist it atomically
- invalidate future joins using the old token
- disconnect and reconnect the gateway using the new token
- keep approved client public keys, because client authorization is key-based, not token-based
- require re-sharing pairing material with clients, because clients need the new raw token

### 9. Persistence and Atomic Config Writes

A publishable plugin must survive crashes and interrupted writes without corrupting relay state.

Rules:
- Pairing approval, revocation, disable, and rotate-token operations must use atomic config writes.
- Never partially update `approvedClients` and `gatewayKeyPair` in separate non-atomic writes.
- If the upstream OpenClaw config API offers transactional or atomic persistence, use it.
- If not, wrap mutations in a single save path and verify post-write reload.
- On startup, if relay config is incomplete or structurally invalid, fail closed: do not connect, do not pair, and surface a clear operator error.

### 10. Publishable Release Gate for the Plugin

The plugin must not be considered publishable until it adds its own release gates beyond the current repo-wide ones.

Required plugin release gates:
- package typecheck
- package build
- unit tests for crypto / transport / pairing / handlers
- integration test with the real Go relay
- config redaction test for `inspectAccount`
- cancellation test proving `cancel` suppresses further stream output
- revocation test proving an active session is terminated and future HELLO is rejected
- capability advertisement test proving unsupported runtime features are not claimed

Recommended future gate:
- smoke test against a real OpenClaw installation or fixture runtime, not only a mock runtime

### 11. Compatibility Contract for a Public Release

The first publishable plugin release must declare compatibility explicitly.

At release time, document:
- minimum supported OpenClaw version
- minimum supported Node / runtime version as inherited from OpenClaw
- supported relay protocol version(s)
- whether the plugin requires a runtime with stable streaming hooks
- whether IndexedDB-unavailable browser fallback that re-pairs after reload is an accepted limitation

Do not publish the plugin as "officially supported" until these compatibility claims are written into machine-readable release metadata and human-facing docs.

### 12. Status Adapter and Health Semantics

A publishable plugin needs a clear health contract for operators and for OpenClaw itself.

If the upstream SDK exposes a `status` adapter, use the following semantic model:

- **healthy**: connected to relay, registered successfully, config valid, no unresolved fatal errors
- **degraded**: config valid but currently reconnecting, rate-limited, or missing optional runtime features
- **unhealthy**: config invalid, fatal Layer 0 registration failure, key material missing/corrupt, or repeated protocol errors

Minimum status payload should include:
- relay URL
- derived channel hash
- current connection state (`disconnected`, `connecting`, `registered`, `reconnecting`)
- last successful register timestamp
- number of approved clients
- number of active sessions
- last fatal error code, if any

Rules:
- Status output must remain redacted per the secret-handling rules above.
- `channel_occupied` and invalid local config must move status to **unhealthy**.
- transient network loss and reconnect backoff should move status to **degraded**, not **unhealthy**.
- status state changes should emit structured logs for operator diagnosis.

## Multi-Client Session Management

The gateway may maintain concurrent encrypted sessions with multiple paired clients.

### Session Replacement Rules

- Presence `offline` removes the active session for that `client_id`
- Reconnect with the same approved fingerprint establishes a new session with fresh nonces
- The newest session for a fingerprint wins; older sessions for that fingerprint are terminated
- Session teardown must fail or cancel all pending Layer 2 requests bound to that client

## Module Structure

```text
plugin/
├── package.json
├── tsconfig.json
├── openclaw.plugin.json
├── src/
│   ├── index.ts
│   ├── channel.ts
│   ├── config.ts
│   ├── gateway-adapter.ts
│   ├── outbound.ts
│   ├── pairing.ts
│   ├── status.ts
│   ├── relay-connection.ts
│   ├── crypto.ts
│   ├── transport.ts
│   ├── dispatch.ts          # Layer 2 -> Layer 3 routing and request tracking
│   ├── handlers/
│   │   ├── chat.ts
│   │   ├── agents.ts
│   │   ├── sessions.ts
│   │   ├── cron.ts
│   │   └── system.ts
│   └── commands/
│       ├── enable.ts
│       ├── pair.ts
│       ├── clients.ts
│       └── disable.ts
└── tests/
    ├── crypto.test.ts
    ├── transport.test.ts
    ├── pairing.test.ts
    ├── handlers.test.ts
    └── integration.test.ts
```

## Shared Code with `sdk/js/`

The Layer 0-1 protocol primitives overlap with what a future `sdk/js/` client would need, but initial implementation should optimize for correctness, not abstraction.

Plan:
- implement protocol code first inside `plugin/src/`
- keep interfaces small and testable
- extract common primitives only after both plugin and JS SDK exist

## Testing Strategy

Use `vitest`.

| Test | What it verifies |
|------|-----------------|
| `crypto.test.ts` | X25519 key handling, HKDF derivation, AES-GCM round-trip, direction checks, replay rejection |
| `transport.test.ts` | Request/response correlation, stream lifecycle, cancel, reconnect failure semantics |
| `pairing.test.ts` | Pairing mode timeout, unknown key rejection, approval, revocation, fingerprint-based identity rules |
| `handlers.test.ts` | Canonical Layer 3 request/response mapping against a mocked OpenClaw runtime |
| `integration.test.ts` | Black-box flow: register -> hello -> handshake -> chat.send -> stream -> revoke -> reconnect, using a real `relay/` subprocess when available and a mock runtime |

### Test Requirements

- At least one integration path must use the real Go relay from `relay/`, not only a mock relay.
- Tests must assert canonical protocol fields from `protocol/layer2-transport.md` and `protocol/layer3-application.md`.
- If upstream OpenClaw APIs are still provisional, add contract tests around the adapter boundary before full implementation.

## Security Considerations

1. Gateway private key and raw channel token are stored on the gateway host; both are sensitive.
2. Pairing mode is explicit, time-limited, and accepts exactly one new client per invocation.
3. Revocation is fingerprint-based and terminates live sessions immediately.
4. No plaintext fallback is allowed after session establishment.
5. Decryption failures are silently dropped.
6. The plugin must not weaken the protocol to accommodate the current web reference client's in-memory identity behavior.

## Out of Scope for Initial Implementation

- Multi-relay support
- Relay auto-discovery and relay selection
- Client-to-client messaging
- Media/file transfer beyond what Layer 3 already standardizes today
- Web-based pairing UI
- Silent compatibility hacks for clients that rotate identity keys unexpectedly
