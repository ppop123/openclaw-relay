#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_ROOT="${SMOKE_ROOT:-$ROOT/.tmp/smoke-openclaw-plugin}"
mkdir -p "$SMOKE_ROOT"

CONFIG_PATH="$SMOKE_ROOT/openclaw.json"
STATE_DIR="$SMOKE_ROOT/openclaw-state"
IDENTITY_FILE="$SMOKE_ROOT/client-identity.json"
PAIR_LOG="$SMOKE_ROOT/pair.log"
PAIR_CLIENT_JSON="$SMOKE_ROOT/pair-client.json"
REQUEST_JSON="$SMOKE_ROOT/request.json"
ENABLE_JSON="$SMOKE_ROOT/enable.json"
CLIENTS_JSON="$SMOKE_ROOT/clients.json"
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

echo "[smoke] opening pairing window"
openclaw relay pair --wait 30 > "$PAIR_LOG" 2>&1 &
pair_pid=$!
wait_file_contains "$PAIR_LOG" '"pairing"'

echo "[smoke] pairing a fresh client"
node "$ROOT/scripts/e2e-relay-client.mjs" pair --config "$CONFIG_PATH" --identity-file "$IDENTITY_FILE" --client-id smoke-client > "$PAIR_CLIENT_JSON"
wait "$pair_pid"
pair_pid=""
grep -q '"paired": true' "$PAIR_LOG"
openclaw relay clients > "$CLIENTS_JSON"

echo "[smoke] starting real OpenClaw gateway on :$GATEWAY_PORT"
openclaw gateway run --allow-unconfigured --port "$GATEWAY_PORT" --auth none --verbose > "$GATEWAY_LOG" 2>&1 &
gateway_pid=$!
sleep 5

echo "[smoke] requesting system.status through relay"
request_ok=0
for _ in $(seq 1 10); do
  if node "$ROOT/scripts/e2e-relay-client.mjs" request --config "$CONFIG_PATH" --identity-file "$IDENTITY_FILE" --client-id smoke-client > "$REQUEST_JSON"; then
    request_ok=1
    break
  fi
  sleep 1
 done
if [[ "$request_ok" != "1" ]]; then
  echo "relay request smoke failed; inspect $REQUEST_JSON and $GATEWAY_LOG" >&2
  exit 1
fi

echo "[smoke] success"
echo "  relay log:    $RELAY_LOG"
echo "  gateway log:  $GATEWAY_LOG"
echo "  enable:       $ENABLE_JSON"
echo "  pair result:  $PAIR_LOG"
echo "  request:      $REQUEST_JSON"
