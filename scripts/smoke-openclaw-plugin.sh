#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_BASE="${SMOKE_BASE:-$ROOT/.tmp/smoke-openclaw-plugin}"
if [[ -n "${SMOKE_ROOT:-}" ]]; then
  mkdir -p "$SMOKE_ROOT"
else
  RUN_ID="${SMOKE_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
  SMOKE_ROOT="$SMOKE_BASE/$RUN_ID"
  mkdir -p "$SMOKE_ROOT"
fi

CONFIG_PATH="$SMOKE_ROOT/openclaw.json"
STATE_DIR="$SMOKE_ROOT/openclaw-state"
IDENTITY_FILE="$SMOKE_ROOT/client-identity.json"
PAIR_LOG="$SMOKE_ROOT/pair.log"
PAIR_CLIENT_JSON="$SMOKE_ROOT/pair-client.json"
REQUEST_JSON="$SMOKE_ROOT/request.json"
REPAIR_REQUEST_JSON="$SMOKE_ROOT/request-after-repair.json"
ROTATED_REQUEST_JSON="$SMOKE_ROOT/request-after-rotate.json"
ENABLE_JSON="$SMOKE_ROOT/enable.json"
CLIENTS_JSON="$SMOKE_ROOT/clients.json"
CLIENTS_AFTER_REVOKE_JSON="$SMOKE_ROOT/clients-after-revoke.json"
REVOKE_JSON="$SMOKE_ROOT/revoke.json"
ROTATE_JSON="$SMOKE_ROOT/rotate-token.json"
DISABLE_JSON="$SMOKE_ROOT/disable.json"
OLD_CONFIG_PATH="$SMOKE_ROOT/openclaw-before-rotate.json"
RELAY_LOG="$SMOKE_ROOT/relay.log"
GATEWAY_LOG="$SMOKE_ROOT/gateway.log"

mkdir -p "$STATE_DIR"
: > "$PAIR_LOG"
: > "$RELAY_LOG"
: > "$GATEWAY_LOG"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd openclaw
require_cmd node
require_cmd go
require_cmd python3
require_cmd curl

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
}

json_read() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json, sys
obj = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print(eval(sys.argv[2], {'obj': obj}))
PY
}

request_should_succeed() {
  local config="$1"
  local output="$2"
  local label="$3"
  local timeout_ms="${4:-5000}"
  for _ in $(seq 1 12); do
    if node "$ROOT/scripts/e2e-relay-client.mjs" request --config "$config" --identity-file "$IDENTITY_FILE" --client-id smoke-client --timeout-ms "$timeout_ms" > "$output"; then
      return 0
    fi
    sleep 1
  done
  echo "request did not succeed for $label" >&2
  return 1
}

request_should_fail() {
  local config="$1"
  local label="$2"
  local timeout_ms="${3:-3000}"
  for _ in $(seq 1 12); do
    if ! node "$ROOT/scripts/e2e-relay-client.mjs" request --config "$config" --identity-file "$IDENTITY_FILE" --client-id smoke-client --timeout-ms "$timeout_ms" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "request unexpectedly kept succeeding for $label" >&2
  return 1
}

pair_once() {
  local pair_log="$1"
  local pair_client_json="$2"
  : > "$pair_log"
  openclaw relay pair --wait 30 > "$pair_log" 2>&1 &
  pair_pid=$!
  wait_file_contains "$pair_log" '"pairing"'
  node "$ROOT/scripts/e2e-relay-client.mjs" pair --config "$CONFIG_PATH" --identity-file "$IDENTITY_FILE" --client-id smoke-client > "$pair_client_json"
  wait "$pair_pid"
  pair_pid=""
  grep -q '"paired": true' "$pair_log"
}

RELAY_PORT="${RELAY_PORT:-$(free_port)}"
GATEWAY_PORT="${GATEWAY_PORT:-$(free_port)}"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"

relay_pid=""
gateway_pid=""
pair_pid=""
cleanup() {
  for pid in "$pair_pid" "$gateway_pid" "$relay_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill -INT "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT

wait_http() {
  local url="$1"
  local attempts="${2:-50}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "timed out waiting for $url" >&2
  return 1
}

wait_file_contains() {
  local file="$1"
  local pattern="$2"
  local attempts="${3:-50}"
  for _ in $(seq 1 "$attempts"); do
    if grep -q "$pattern" "$file" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "timed out waiting for $pattern in $file" >&2
  return 1
}

start_gateway() {
  : > "$GATEWAY_LOG"
  openclaw gateway run --allow-unconfigured --port "$GATEWAY_PORT" --auth none --verbose > "$GATEWAY_LOG" 2>&1 &
  gateway_pid=$!
  sleep 5
}

stop_gateway() {
  if openclaw gateway stop >/dev/null 2>&1; then
    sleep 2
  fi
  local pids
  pids="$(lsof -tiTCP:$GATEWAY_PORT -sTCP:LISTEN || true)"
  if [[ -n "$pids" ]]; then
    kill -INT $pids >/dev/null 2>&1 || true
    sleep 2
  fi
  for _ in $(seq 1 25); do
    if ! lsof -tiTCP:$GATEWAY_PORT -sTCP:LISTEN >/dev/null 2>&1; then
      gateway_pid=""
      sleep 1
      return 0
    fi
    sleep 0.2
  done
  echo "timed out stopping gateway on :$GATEWAY_PORT" >&2
  return 1
}

echo "[smoke] installing plugin"
openclaw plugins install --link "$ROOT/plugin" >/dev/null

echo "[smoke] enabling relay account"
openclaw relay enable --server "ws://127.0.0.1:${RELAY_PORT}/ws" > "$ENABLE_JSON"

echo "[smoke] starting relay on :$RELAY_PORT"
(
  cd "$ROOT/relay"
  go run . -port "$RELAY_PORT" -tls off
) > "$RELAY_LOG" 2>&1 &
relay_pid=$!
wait_http "http://127.0.0.1:${RELAY_PORT}/status"

echo "[smoke] pairing a fresh client"
pair_once "$PAIR_LOG" "$PAIR_CLIENT_JSON"
openclaw relay clients > "$CLIENTS_JSON"
FINGERPRINT="$(json_read "$IDENTITY_FILE" "obj['fingerprint']")"

echo "[smoke] starting real OpenClaw gateway on :$GATEWAY_PORT"
start_gateway

echo "[smoke] verifying request succeeds after initial pair"
request_should_succeed "$CONFIG_PATH" "$REQUEST_JSON" 'initial-pair'

echo "[smoke] revoking approved client"
openclaw relay revoke --fingerprint "$FINGERPRINT" > "$REVOKE_JSON"
openclaw relay clients > "$CLIENTS_AFTER_REVOKE_JSON"
request_should_fail "$CONFIG_PATH" 'revoked-client'

echo "[smoke] stopping gateway before re-pair"
stop_gateway

echo "[smoke] re-pairing same client after revoke"
pair_once "$SMOKE_ROOT/repair.log" "$SMOKE_ROOT/repair-client.json"

echo "[smoke] restarting gateway after re-pair"
start_gateway
request_should_succeed "$CONFIG_PATH" "$REPAIR_REQUEST_JSON" 'repaired-client'

echo "[smoke] rotating channel token"
cp "$CONFIG_PATH" "$OLD_CONFIG_PATH"
OLD_TOKEN="$(json_read "$OLD_CONFIG_PATH" "obj['channels']['relay']['accounts']['default']['channelToken']")"
openclaw relay rotate-token > "$ROTATE_JSON"
NEW_TOKEN="$(json_read "$CONFIG_PATH" "obj['channels']['relay']['accounts']['default']['channelToken']")"
if [[ "$OLD_TOKEN" == "$NEW_TOKEN" ]]; then
  echo "rotate-token did not change channel token" >&2
  exit 1
fi
request_should_fail "$OLD_CONFIG_PATH" 'old-rotated-token'
request_should_succeed "$CONFIG_PATH" "$ROTATED_REQUEST_JSON" 'new-rotated-token'

echo "[smoke] disabling relay account"
openclaw relay disable > "$DISABLE_JSON"
request_should_fail "$CONFIG_PATH" 'disabled-account'

echo "[smoke] success"
echo "  smoke root:           $SMOKE_ROOT"
echo "  relay log:            $RELAY_LOG"
echo "  gateway log:          $GATEWAY_LOG"
echo "  enable:               $ENABLE_JSON"
echo "  pair result:          $PAIR_LOG"
echo "  request:              $REQUEST_JSON"
echo "  revoke:               $REVOKE_JSON"
echo "  rotate-token:         $ROTATE_JSON"
echo "  disable:              $DISABLE_JSON"
echo "  request after repair: $REPAIR_REQUEST_JSON"
echo "  request after rotate: $ROTATED_REQUEST_JSON"
