# AI Review Mailbox

This directory is the shared mailbox for multi-AI collaboration inside the same repository.

## Purpose

Use files here instead of copying long messages between chat windows.

## Core Files

- `architect-review.md` — authoritative reviewer feedback and blocking items
- `claude-response.md` — implementer response, change summary, test results, and unresolved issues
- `release-gates.md` — release gate checklist and status
- `status.json` — single machine-readable handoff state
- `next-action.txt` — human-readable summary of what happens next
- `PROTOCOL.md` — state machine and handoff rules

## Recommended Workflow

1. Both AIs first read `review/status.json` or run:
   - `python3 scripts/review-status.py show`
2. If state is `REVIEW_READY`, the implementer reads `architect-review.md`, makes changes, writes `claude-response.md`, then runs:
   - `python3 scripts/review-status.py set-implementation-done --by claude --note "Implemented requested fixes"`
3. If state is `IMPLEMENTATION_DONE`, the reviewer reads `claude-response.md`, re-checks the repo, updates `architect-review.md` if needed, then runs either:
   - `python3 scripts/review-status.py set-review-ready --by codex --note "New blocking items added"`
   - or `python3 scripts/review-status.py set-closed --by codex --note "Release approved"`
4. If either side is blocked, run:
   - `python3 scripts/review-status.py set-blocked --by <name> --note "Reason"`

## Rules

- Do not delete history sections unless they are clearly obsolete.
- Always include file paths and exact commands.
- Keep claims auditable: every conclusion should point to code, docs, or test output.
- If code and documentation disagree, say so explicitly.
- If a release gate is not met, mark it `BLOCKED`, not `DONE`.
- Update `status.json` whenever responsibility changes.

## Minimal Prompt for the Other AI

Use this exact instruction in the other window:

```text
先执行 `python3 scripts/review-status.py show`。如果状态是 `REVIEW_READY`，请读取 `review/architect-review.md`，按要求整改，并把结果写入 `review/claude-response.md`。完成后执行 `python3 scripts/review-status.py set-implementation-done --by claude --note "已完成整改并写入回执"`。
```

## Important Limitation

This protocol removes manual copy/paste, but it does not let one AI forcibly wake another chat window.
Each side must still be told at least once to follow the protocol. After that, the repository acts as the mailbox.
