#!/usr/bin/env python3
"""Update or inspect the AI review handoff status.

Usage:
  python3 scripts/review-status.py show
  python3 scripts/review-status.py set-review-ready --note "P0 items updated"
  python3 scripts/review-status.py set-implementation-done --note "Fixes applied"
  python3 scripts/review-status.py set-blocked --note "Need clarification"
  python3 scripts/review-status.py set-closed --note "Approved"
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, UTC
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
STATUS_FILE = REPO_ROOT / "review" / "status.json"
NEXT_ACTION_FILE = REPO_ROOT / "review" / "next-action.txt"

TRANSITIONS = {
    "set-review-ready": {
        "state": "REVIEW_READY",
        "owner": "implementer",
        "action": "Read `review/architect-review.md`, apply the requested changes, write results to `review/claude-response.md`, then update the status to IMPLEMENTATION_DONE.",
    },
    "set-implementation-done": {
        "state": "IMPLEMENTATION_DONE",
        "owner": "reviewer",
        "action": "Read `review/claude-response.md`, re-check the repo, then either update `review/architect-review.md` and set REVIEW_READY again, or close the round.",
    },
    "set-blocked": {
        "state": "BLOCKED",
        "owner": "none",
        "action": "Open the note in `review/status.json` and resolve the blocking issue before continuing.",
    },
    "set-closed": {
        "state": "CLOSED",
        "owner": "none",
        "action": "Review round finished. Start a new round only if new findings appear.",
    },
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_status() -> dict:
    if not STATUS_FILE.exists():
        return {
            "state": "IDLE",
            "owner": "none",
            "updated_by": "unknown",
            "updated_at": utc_now(),
            "note": "",
            "review_file": "review/architect-review.md",
            "response_file": "review/claude-response.md",
        }
    return json.loads(STATUS_FILE.read_text())


def write_status(data: dict, action_text: str) -> None:
    STATUS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    NEXT_ACTION_FILE.write_text(
        f"State: {data['state']}\n"
        f"Next actor: {data['owner']}\n"
        f"Action: {action_text}\n"
        f"Note: {data['note']}\n"
        f"Updated by: {data['updated_by']}\n"
        f"Updated at: {data['updated_at']}\n"
    )


def cmd_show(_: argparse.Namespace) -> int:
    data = load_status()
    print(json.dumps(data, indent=2, ensure_ascii=False))
    if NEXT_ACTION_FILE.exists():
        print("\n---\n")
        print(NEXT_ACTION_FILE.read_text().rstrip())
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    transition = TRANSITIONS[args.command]
    data = load_status()
    data.update(
        {
            "state": transition["state"],
            "owner": transition["owner"],
            "updated_by": args.by,
            "updated_at": utc_now(),
            "note": args.note,
            "review_file": "review/architect-review.md",
            "response_file": "review/claude-response.md",
        }
    )
    write_status(data, transition["action"])
    print(f"Status updated: {data['state']} -> next actor: {data['owner']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    show = sub.add_parser("show")
    show.set_defaults(func=cmd_show)

    for name in TRANSITIONS:
        p = sub.add_parser(name)
        p.add_argument("--note", required=True)
        p.add_argument("--by", default="unknown")
        p.set_defaults(func=cmd_set)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
