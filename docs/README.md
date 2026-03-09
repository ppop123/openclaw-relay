# Documentation Center

This directory is the current technical documentation hub for OpenClaw Relay.

If you are new to the project, start here instead of jumping straight into detailed design documents.

## Start Here

| Document | Purpose |
|----------|---------|
| `README.md` | Project homepage, release scope, quick entry points |
| `docs/quick-start.md` | Fast setup for relay, client, and plugin |
| `docs/architecture-overview.md` | Current implementation-oriented architecture summary |
| `docs/deployment.md` | Relay deployment, CLI flags, operations, troubleshooting |
| `docs/security.md` | Security properties, limits, and storage rules |
| `docs/support-matrix.md` | Supported vs not-yet-implemented components |
| `docs/ai-implementation-guide.md` | AI-first facts, invariants, release gates |

## Canonical Machine-Readable Sources

When Markdown and machine-readable files disagree, the machine-readable files win.

| Fact | Source |
|------|--------|
| Component support scope | `docs/support-matrix.json` |
| Release scope and release gates | `docs/release-manifest.json` |
| Protocol error codes | `protocol/error-codes.json` |
| Protocol examples | `protocol/examples/*.json` |
| Web client component manifest | `docs/web-client/manifest.json` |
| Web client storage contract | `docs/web-client/storage-schema.json` |
| Web client state model | `docs/web-client/state-machine.json` |

## Protocol Documentation

| Document | Scope |
|----------|-------|
| `protocol/layer0-channel.md` | Relay channel frames and presence |
| `protocol/layer1-security.md` | Identity, key exchange, session keys |
| `protocol/layer2-transport.md` | Request/response/streaming transport |
| `protocol/layer3-application.md` | Application methods and payload contracts |

## Component-Focused Docs

| Document | Scope |
|----------|-------|
| `docs/web-client.md` | Browser client documentation hub |
| `docs/web-client/architecture.md` | Browser runtime structure and module boundaries |
| `docs/web-client/identity-and-storage.md` | Browser identity lifecycle and storage rules |
| `docs/web-client/transport.md` | Browser handshake, encryption, request/response, reconnect behavior |
| `docs/web-client/ui-and-state.md` | Browser UI structure, app state, user flows |
| `docs/web-client/testing-and-troubleshooting.md` | Browser test coverage, manual checks, failure patterns |
| `plugin/README.md` | OpenClaw gateway plugin install, runtime, smoke validation |
| `docs/self-host-relay.md` | Self-hosting notes |
| `docs/technical-design.md` | Detailed design background and broader system rationale |

## Planning and History

| Document | Scope |
|----------|-------|
| `docs/releases/` | Historical release notes and README update drafts |
| `docs/plans/` | Design plans and implementation proposals |
| `docs/architecture-audit-review.md` | Architecture review and audit notes |

## Reading Order

Recommended order for most engineers:

Before changing anything that depends on OpenClaw runtime behavior, inspect the local OpenClaw source first. On this machine one validated install root is `/opt/homebrew/lib/node_modules/openclaw/dist`, but on other machines you must verify the real local install path before reading the source. Do not rely on prose docs alone for request shapes, session storage, transcript layout, or gateway/runtime semantics.

1. `README.md`
2. `docs/architecture-overview.md`
3. `docs/security.md`
4. `docs/support-matrix.md`
5. `docs/web-client.md` or `plugin/README.md` depending on what you are changing
6. `protocol/` layer docs for exact wire behavior
