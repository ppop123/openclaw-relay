# Release Gates

This checklist is the current release gate for public release review.

## Required Gates

- [ ] `cd relay && go test -v -count=1`
- [ ] `cd sdk/python && pytest -q`
- [ ] `cd client && npm test`
- [ ] `cd deploy/cloudflare-worker && npx tsc --noEmit` (informational unless explicitly promoted)
- [ ] `python3 scripts/validate-protocol-examples.py`
- [ ] `bash scripts/check-doc-consistency.sh`

## AI-first Rules

- [ ] JSON truth sources match Markdown summaries
- [ ] Protocol examples are valid fixtures, not placeholder text
- [ ] Release claims match actual implementation scope
- [ ] Security claims match the implemented key model
- [ ] Supported components are described honestly

## Current Policy

- Worker is experimental and excluded from official public release scope.
- Release is blocked if any required gate above fails.
