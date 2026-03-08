#!/usr/bin/env python3
"""Validate protocol example JSON files against protocol constraints.

Checks:
  - JSON is parseable
  - channel fields are 64-char hex strings
  - X25519 public keys are exactly 32 bytes when base64-decoded
  - session nonces are exactly 32 bytes when base64-decoded
  - error code fields match the canonical error-codes.json
  - required fields are present per frame type

Exit code 0 = all checks pass, 1 = at least one failure.
"""

import base64
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES_DIR = os.path.join(REPO_ROOT, "protocol", "examples")
ERROR_CODES_FILE = os.path.join(REPO_ROOT, "protocol", "error-codes.json")

failures = []


def fail(file: str, msg: str) -> None:
    failures.append(f"  FAIL  {file}: {msg}")


def check_hex64(file: str, field: str, value: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        fail(file, f"{field} must be 64 lowercase hex chars, got {len(value)} chars")


def check_b64_bytes(file: str, field: str, value: str, expected_len: int) -> None:
    try:
        decoded = base64.b64decode(value)
    except Exception as e:
        fail(file, f"{field} is not valid base64: {e}")
        return
    if len(decoded) != expected_len:
        fail(file, f"{field} must decode to {expected_len} bytes, got {len(decoded)}")


def validate_file(path: str) -> None:
    name = os.path.basename(path)
    try:
        with open(path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        fail(name, f"invalid JSON: {e}")
        return

    frame_type = data.get("type")
    if frame_type is None:
        fail(name, "missing 'type' field")
        return

    # Channel hash validation
    if "channel" in data:
        check_hex64(name, "channel", data["channel"])

    # Layer 1 key/nonce validation
    if frame_type == "hello":
        if "client_public_key" not in data:
            fail(name, "missing 'client_public_key'")
        else:
            check_b64_bytes(name, "client_public_key", data["client_public_key"], 32)
        if "session_nonce" not in data:
            fail(name, "missing 'session_nonce'")
        else:
            check_b64_bytes(name, "session_nonce", data["session_nonce"], 32)

    if frame_type == "hello_ack":
        if "gateway_public_key" not in data:
            fail(name, "missing 'gateway_public_key'")
        else:
            check_b64_bytes(name, "gateway_public_key", data["gateway_public_key"], 32)
        if "session_nonce" not in data:
            fail(name, "missing 'session_nonce'")
        else:
            check_b64_bytes(name, "session_nonce", data["session_nonce"], 32)

    # Error code validation
    if frame_type == "error":
        if "code" not in data:
            fail(name, "missing 'code' field")
        elif os.path.exists(ERROR_CODES_FILE):
            with open(ERROR_CODES_FILE) as f:
                codes_data = json.load(f)
            valid_codes = {ec["code"] for ec in codes_data.get("error_codes", [])}
            if data["code"] not in valid_codes:
                fail(name, f"error code '{data['code']}' not in error-codes.json")

    # Required fields per type
    required_fields = {
        "join": ["channel", "version", "client_id"],
        "register": ["channel", "version"],
        "hello": ["client_public_key", "session_nonce", "protocol_version"],
        "hello_ack": ["gateway_public_key", "session_nonce", "protocol_version"],
        "request": ["id", "method", "params"],
        "response": ["id"],
        "stream_chunk": ["id", "seq", "data"],
        "error": ["code", "message"],
    }
    for field in required_fields.get(frame_type, []):
        if field not in data:
            fail(name, f"missing required field '{field}' for type '{frame_type}'")


def main() -> int:
    if not os.path.isdir(EXAMPLES_DIR):
        print(f"ERROR: {EXAMPLES_DIR} does not exist")
        return 1

    files = sorted(f for f in os.listdir(EXAMPLES_DIR) if f.endswith(".json"))
    if not files:
        print(f"ERROR: no .json files in {EXAMPLES_DIR}")
        return 1

    for name in files:
        validate_file(os.path.join(EXAMPLES_DIR, name))

    if failures:
        print(f"Protocol example validation FAILED ({len(failures)} issue(s)):\n")
        for f in failures:
            print(f)
        return 1

    print(f"Protocol example validation passed: {len(files)} files, all checks OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
