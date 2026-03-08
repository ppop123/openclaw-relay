# Architect Review

## Status

- State: ACTION_REQUIRED
- Owner: Codex reviewer
- Scope: Public release + AI-first quality gate
- Last updated: 2026-03-08

## Current Verdict

- Verdict: NOT_READY_FOR_PUBLIC_RELEASE
- Release decision: Previous 3 P0 items were substantially addressed, but the new P0 items below still block public release.

## Active Blocking Items

- Item: Finish unifying the Layer 1 identity model across truth sources and the web client
  - Severity: P0
  - Why it matters: The repository still presents conflicting statements about whether the web reference client has a static identity keypair across sessions, which directly affects pairing semantics and AI implementability.
  - Evidence:
    - `docs/security.md:18` — says each side has a static identity keypair generated once during pairing
    - `docs/security.md:47` — fresh session keys section is now static-key consistent, but the browser storage section still stores no client key material
    - `docs/security.md:66` — browser storage policy persists `clientId`, but not any client private key material
    - `client/js/transport.js:147` — reuses keypair only if it already exists in memory
    - `client/js/crypto.js:4` — still says "Handles ephemeral key generation"
    - `docs/ai-implementation-guide.md:97` — explicitly admits the web client loses its keypair on page reload
    - `docs/release-manifest.json:58` — says both JS client and Python SDK use the same static-key model
  - Required outcome: Either (A) implement stable web-client identity persistence, or (B) downgrade/clarify all release claims so they accurately say the web reference client only preserves identity within one browser session and is not equivalent to the Python model across page reloads. Do not leave repository-level truth sources claiming a stronger property than the implementation actually has.

- Item: Make the Python release gate reproducible
  - Severity: P0
  - Why it matters: A release gate is not real if the declared install command does not actually install the test dependencies it requires.
  - Evidence:
    - `.github/workflows/ci.yml:34` — runs `pip install -e ".[dev]"`
    - `docs/release-manifest.json:27` — declares the same command as a release-blocking gate
    - `sdk/python/pyproject.toml:1` — has no `project.optional-dependencies.dev`
    - `sdk/python/pyproject.toml:1` — does not mention `pytest`
  - Required outcome: Define a real dev extra (including `pytest` and any other required test deps), or change CI and `release-manifest.json` to a different explicit, reproducible install command that truly provides the test environment.

## Implementer Response Requirements

For each item above, write a matching section in `claude-response.md` using this format:

```text
### Item: <same title as reviewer>
- Result: FIXED | PARTIAL | NOT_FIXED
- Summary: <one paragraph max>
- Files changed:
  - `path/to/file:line`
- Tests run:
  - `<command>` — PASS/FAIL
- Remaining risk:
  - <if none, say None>
```

## Notes

- Previous round improvements are acknowledged: protocol examples, docs consistency checks, release-manifest gates, and Python SDK support wording are much better.
- The remaining blockers are now concentrated in truthfulness and reproducibility, not basic feature gaps.
- AI-first means release claims must match real behavior, not intended behavior.
