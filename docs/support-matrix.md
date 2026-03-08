# Support Matrix and Versioning

> **Canonical source:** [`docs/support-matrix.json`](support-matrix.json) is the machine-readable single source of truth. This document mirrors it in human-readable form.

## Component Status

### Officially Supported

| Component | Path | Description |
|-----------|------|-------------|
| Go relay server | `relay/` | Production relay implementation |
| Python SDK | `sdk/python/` | Client SDK (protocol layers 0-2) |
| Web reference client | `client/` | Browser-based reference client |

These components are actively maintained, tested in CI, and covered by the project's stability guarantees.

### Experimental (Not Officially Supported)

| Component | Path | Limitations |
|-----------|------|-------------|
| Cloudflare Worker | `deploy/cloudflare-worker/` | Uses incompatible URL-based routing (not frame-based). No automated tests. CORS is wide open. **Standard clients CANNOT connect to it.** |

The Worker is a proof-of-concept for edge deployment. It is not security-reviewed and should not be used for production workloads.

### Not Yet Implemented

| Component | Path | Status |
|-----------|------|--------|
| JavaScript SDK | `sdk/js/` | Not yet implemented |
| OpenClaw gateway plugin | `plugin/` | Not yet implemented |

These directories may contain placeholder files but have no functional implementation.

## Protocol Version

The current and only protocol version is **v1**.

- The `version` field in frames is optional. Both `0` and `1` are treated as v1.
- Breaking protocol changes will increment the version number.
- v1 implementations **MUST** reject frames with `version > 1`.

There are no plans for a v2 at this time.

## Test Coverage

| Component | Tests | Framework |
|-----------|-------|-----------|
| Go relay server | 10 tests | `go test` |
| Python SDK | 28 tests | `pytest` |
| Web reference client | Unit tests (markdown, crypto, transport) | `vitest` |

## CI Pipeline

The CI pipeline runs the following checks:

| Step | Command | Scope |
|------|---------|-------|
| Go tests | `go test` | Relay server |
| Python tests | `pytest` | Python SDK |
| JS tests | `vitest` | Web client |
| Type checking | `tsc --noEmit` | Cloudflare Worker only (type checking, no runtime tests) |

All officially supported components must pass their test suites before merge. The Worker type check is informational and does not block merges.
