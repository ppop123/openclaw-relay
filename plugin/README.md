# OpenClaw Relay Plugin (Preview)

This package contains a preview implementation of the OpenClaw Relay gateway plugin.

## Current status

- Implemented as a TypeScript gateway-side relay adapter
- Covered by local unit/integration tests and CI preview checks
- Not yet officially supported for public release
- Not yet end-to-end verified against a real OpenClaw runtime build

## What is implemented

- Relay channel configuration store interfaces
- Layer 1 crypto and session establishment
- Layer 2 request / response / stream handling
- Pairing state and approved-client persistence
- Preview CLI handlers for `enable`, `pair`, `clients`, `revoke`, `disable`, `rotate-token`

## What is still provisional

- Exact OpenClaw host API and runtime hook names
- Final plugin registration wiring against a real OpenClaw installation
- The default export currently requires explicit factory options until real host integration is verified
- Official support / release guarantees

## Runtime requirements

- Node.js `>=22` (validated in CI)
- WebCrypto with X25519 support
- A real OpenClaw host integration is still required for official support

## Development checks

The repository currently validates the plugin with shared repo toolchains:

```bash
cd client && npm ci && cd .. && client/node_modules/.bin/vitest run plugin/tests
cd deploy/cloudflare-worker && npm ci && cd ../.. && deploy/cloudflare-worker/node_modules/.bin/tsc -p plugin/tsconfig.json --noEmit
```

See `docs/plans/2026-03-08-gateway-plugin-design.md` for the current design source.
