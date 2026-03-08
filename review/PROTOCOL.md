# Review Signaling Protocol

This protocol lets two AI assistants coordinate through repository files without copying long chat messages.

## Single Source of Coordination

- Coordination file: `review/status.json`
- Human-readable summary: `review/next-action.txt`

## State Machine

Allowed `state` values:

- `IDLE` — no pending handoff
- `REVIEW_READY` — reviewer finished writing `architect-review.md`; implementer should read and act
- `IMPLEMENTATION_DONE` — implementer finished writing `claude-response.md`; reviewer should re-check and judge
- `BLOCKED` — current actor is blocked and needs repo/user clarification
- `CLOSED` — review round finished

## Ownership Rules

- Reviewer writes `architect-review.md`, then sets state to `REVIEW_READY`
- Implementer reads `architect-review.md`, performs changes, writes `claude-response.md`, then sets state to `IMPLEMENTATION_DONE`
- Reviewer reads `claude-response.md`, re-checks the repo, then either:
  - updates `architect-review.md` and sets `REVIEW_READY` again, or
  - sets `CLOSED`

## Required Fields in `status.json`

- `state`
- `owner` — who should act next (`reviewer`, `implementer`, `none`)
- `updated_by`
- `updated_at`
- `note`
- `review_file`
- `response_file`

## Minimal Commands

Reviewer side:

```bash
python3 scripts/review-status.py show
python3 scripts/review-status.py set-review-ready --note "P0 items updated"
```

Implementer side:

```bash
python3 scripts/review-status.py show
python3 scripts/review-status.py set-implementation-done --note "All requested fixes applied"
```

Either side can mark blocked:

```bash
python3 scripts/review-status.py set-blocked --note "Need clarification on identity model"
```

Reviewer can close the round:

```bash
python3 scripts/review-status.py set-closed --note "Public release approved"
```

## Important Limitation

This protocol removes manual copy/paste, but it does not let one AI forcibly wake another chat window.
Each side must still be instructed once to check `review/status.json` and follow the protocol.
After that, the repo becomes the mailbox.
