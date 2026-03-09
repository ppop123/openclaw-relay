# Support Matrix and Versioning

> **Canonical source:** [`docs/support-matrix.json`](support-matrix.json) is the machine-readable single source of truth. This document mirrors it in human-readable form.

## Component Status

### Officially Supported

| Component | Path | Description |
|-----------|------|-------------|
| Go relay server | `relay/` | Production relay implementation |
| Python SDK | `sdk/python/` | Client SDK (protocol layers 0-2, client-side only) |
| Web reference client | `client/` | Browser-based reference client |
| Protocol specification | `protocol/` | Wire protocol specification (v1) |
| OpenClaw gateway plugin | `plugin/` | TypeScript gateway plugin for installing relay support into your own OpenClaw runtime; includes a local lifecycle smoke script for real-host verification |

These components are actively maintained, tested in CI, and covered by the project's stability guarantees for `v0.5.0`.

### Not Yet Implemented

| Component | Path | Status |
|-----------|------|--------|
| JavaScript SDK | `sdk/js/` | Not yet implemented |

## Protocol Version

The current and only protocol version is **v1**.

- The `version` field in frames is optional. Both `0` and `1` are treated as v1.
- Breaking protocol changes will increment the version number.
- v1 implementations **MUST** reject frames with `version > 1`.

## Test Coverage

| Component | Tests | Framework |
|-----------|-------|-----------|
| Go relay server | `go test` suite | `go test` |
| Python SDK | `pytest` suite | `pytest` |
| Web reference client | `vitest` suite | `vitest` |
| OpenClaw gateway plugin | `vitest` suite + typecheck + local smoke script | `vitest` + `tsc` + `bash` (plugin tests require `go` on `PATH`) |

## CI Pipeline

The CI pipeline runs the following checks:

| Step | Command | Scope | Blocks release |
|------|---------|-------|----------------|
| Go tests | `go test` | Relay server | Yes |
| Python tests | `pytest` | Python SDK | Yes |
| JS tests | `vitest` | Web client | Yes |
| Plugin tests | `vitest run plugin/tests` | OpenClaw gateway plugin | Yes |
| Plugin type check | `tsc -p plugin/tsconfig.json --noEmit` | OpenClaw gateway plugin | Yes |
| Plugin smoke | `bash scripts/smoke-openclaw-plugin.sh` | OpenClaw gateway plugin on a real local OpenClaw runtime | No (manual/local) |
| Docs / contracts | `validate-protocol-examples.py` + `check-doc-consistency.sh` | Protocol + docs | Yes |

All officially supported components must pass their test suites before release.
