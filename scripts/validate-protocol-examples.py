#!/usr/bin/env python3
"""Validate protocol example JSON files against protocol constraints.

Checks:
  - JSON is parseable
  - channel and invite hash fields are 64-char hex strings
  - X25519 public keys are exactly 32 bytes when base64-decoded
  - session nonces are exactly 32 bytes when base64-decoded
  - RFC3339 timestamps are valid where required
  - error and signal_error code fields match the canonical error-codes.json
  - required fields are present per frame type
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from datetime import datetime
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES_DIR = os.path.join(REPO_ROOT, "protocol", "examples")
ERROR_CODES_FILE = os.path.join(REPO_ROOT, "protocol", "error-codes.json")

failures: list[str] = []
valid_codes: set[str] = set()


def fail(file: str, msg: str) -> None:
    failures.append(f"  FAIL  {file}: {msg}")


def check_hex64(file: str, field: str, value: Any) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        fail(file, f"{field} must be 64 lowercase hex chars")


def check_b64_bytes(file: str, field: str, value: Any, expected_len: int) -> None:
    if not isinstance(value, str):
        fail(file, f"{field} must be a base64 string")
        return
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as e:
        fail(file, f"{field} is not valid base64: {e}")
        return
    if len(decoded) != expected_len:
        fail(file, f"{field} must decode to {expected_len} bytes, got {len(decoded)}")


def check_object(file: str, field: str, value: Any) -> None:
    if not isinstance(value, dict):
        fail(file, f"{field} must be a JSON object")


def check_rfc3339(file: str, field: str, value: Any) -> None:
    if not isinstance(value, str):
        fail(file, f"{field} must be a string timestamp")
        return
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        fail(file, f"{field} must be RFC3339, got {value!r}: {e}")


def validate_file(path: str) -> None:
    name = os.path.basename(path)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        fail(name, f"invalid JSON: {e}")
        return

    frame_type = data.get("type")
    if frame_type is None:
        fail(name, "missing 'type' field")
        return

    if "channel" in data:
        check_hex64(name, "channel", data["channel"])
    if "invite_hash" in data:
        check_hex64(name, "invite_hash", data["invite_hash"])

    for key_field in [
        "client_public_key",
        "gateway_public_key",
        "public_key",
        "target",
        "source",
        "ephemeral_key",
    ]:
        if key_field in data and data[key_field] != "":
            check_b64_bytes(name, key_field, data[key_field], 32)

    if "metadata" in data:
        check_object(name, "metadata", data["metadata"])

    if frame_type == "hello":
        if "client_public_key" not in data:
            fail(name, "missing 'client_public_key'")
        if "session_nonce" not in data:
            fail(name, "missing 'session_nonce'")
        else:
            check_b64_bytes(name, "session_nonce", data["session_nonce"], 32)

    if frame_type == "hello_ack":
        if "gateway_public_key" not in data:
            fail(name, "missing 'gateway_public_key'")
        if "session_nonce" not in data:
            fail(name, "missing 'session_nonce'")
        else:
            check_b64_bytes(name, "session_nonce", data["session_nonce"], 32)

    if frame_type == "register":
        if data.get("discoverable"):
            if "public_key" not in data:
                fail(name, "discoverable register must include public_key")
        else:
            if "public_key" in data or "metadata" in data:
                fail(name, "non-discoverable register must not include public_key or metadata")

    if frame_type == "discover_result":
        peers = data.get("peers")
        if not isinstance(peers, list):
            fail(name, "discover_result peers must be a list")
        else:
            for idx, peer in enumerate(peers):
                if not isinstance(peer, dict):
                    fail(name, f"peers[{idx}] must be an object")
                    continue
                if "public_key" not in peer:
                    fail(name, f"peers[{idx}] missing public_key")
                else:
                    check_b64_bytes(name, f"peers[{idx}].public_key", peer["public_key"], 32)
                if "metadata" in peer:
                    check_object(name, f"peers[{idx}].metadata", peer["metadata"])
                if "online_since" not in peer:
                    fail(name, f"peers[{idx}] missing online_since")
                else:
                    check_rfc3339(name, f"peers[{idx}].online_since", peer["online_since"])

    if frame_type == "signal":
        if "ephemeral_key" not in data:
            fail(name, "signal missing 'ephemeral_key'")
        if "payload" not in data:
            fail(name, "signal missing 'payload'")
        if "source" not in data and "target" not in data:
            fail(name, "signal must include either source or target depending on direction")

    if frame_type in {"error", "signal_error"}:
        if "code" not in data:
            fail(name, f"missing 'code' field for type '{frame_type}'")
        elif data["code"] not in valid_codes:
            fail(name, f"error code '{data['code']}' not in error-codes.json")

    if frame_type == "invite_created":
        if "expires_at" not in data:
            fail(name, "invite_created missing 'expires_at'")
        else:
            check_rfc3339(name, "expires_at", data["expires_at"])

    required_fields = {
        "join": ["channel", "version", "client_id"],
        "register": ["channel", "version"],
        "discover": [],
        "discover_result": ["peers"],
        "invite_create": ["invite_hash"],
        "invite_created": ["invite_hash", "expires_at"],
        "hello": ["client_public_key", "session_nonce", "protocol_version"],
        "hello_ack": ["gateway_public_key", "session_nonce", "protocol_version"],
        "request": ["id", "method", "params"],
        "response": ["id"],
        "stream_chunk": ["id", "seq", "data"],
        "error": ["code", "message"],
        "signal_error": ["code"],
    }
    for field in required_fields.get(frame_type, []):
        if field not in data:
            fail(name, f"missing required field '{field}' for type '{frame_type}'")


def main() -> int:
    global valid_codes

    if not os.path.isdir(EXAMPLES_DIR):
        print(f"ERROR: {EXAMPLES_DIR} does not exist")
        return 1

    if not os.path.exists(ERROR_CODES_FILE):
        print(f"ERROR: {ERROR_CODES_FILE} does not exist")
        return 1

    with open(ERROR_CODES_FILE, encoding="utf-8") as f:
        codes_data = json.load(f)
    valid_codes = {entry["code"] for entry in codes_data.get("error_codes", [])}

    files = sorted(f for f in os.listdir(EXAMPLES_DIR) if f.endswith(".json"))
    if not files:
        print(f"ERROR: no .json files in {EXAMPLES_DIR}")
        return 1

    for name in files:
        validate_file(os.path.join(EXAMPLES_DIR, name))

    if failures:
        print(f"Protocol example validation FAILED ({len(failures)} issue(s)):\n")
        for item in failures:
            print(item)
        return 1

    print(f"Protocol example validation passed: {len(files)} files, all checks OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
