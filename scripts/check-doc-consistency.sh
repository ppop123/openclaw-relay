#!/usr/bin/env bash
# Check documentation consistency across the repository.
#
# Detects:
#   - Forbidden phrases that contradict project status
#   - Port default mismatches between code and docs
#   - Worker missing "experimental" marker
#   - False security claims (forward secrecy)
#
# Exit code 0 = all checks pass, 1 = at least one failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILURES=0

fail() {
    echo "  FAIL: $1"
    FAILURES=$((FAILURES + 1))
}

echo "=== Documentation consistency check ==="
echo ""

# 1. Forbidden phrases
echo "Checking forbidden phrases..."
FORBIDDEN_PATTERNS=(
    "Implementation has not started"
    "specification and design package"
    "provides forward secrecy"
    "forward secrecy (ephemeral"
    "can be specified multiple times"
    "cross-implementation test matrix"
)
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    matches=$(grep -r --include="*.md" --include="*.json" -l "$pattern" "$REPO_ROOT/README.md" "$REPO_ROOT/docs/" "$REPO_ROOT/protocol/" "$REPO_ROOT/client/tests/" 2>/dev/null || true)
    if [ -n "$matches" ]; then
        fail "Forbidden phrase '$pattern' found in: $matches"
    fi
done

# 2. Port consistency: extract default from main.go, check docs match
echo "Checking port consistency..."
CODE_PORT=$(grep 'flag.IntVar(&port, "port"' "$REPO_ROOT/relay/main.go" 2>/dev/null | sed 's/.*"port", \([0-9]*\).*/\1/' || echo "UNKNOWN")
if [ "$CODE_PORT" = "UNKNOWN" ]; then
    fail "Could not extract default port from relay/main.go"
else
    # Check for wrong port in docs
    WRONG_PORT=$( [ "$CODE_PORT" = "8443" ] && echo "8080" || echo "8443" )
    wrong_matches=$(grep -rn --include="*.md" "port.*$WRONG_PORT\|$WRONG_PORT.*port\|--port.*$WRONG_PORT\|\`$WRONG_PORT\`" "$REPO_ROOT/docs/" "$REPO_ROOT/README.md" 2>/dev/null || true)
    if [ -n "$wrong_matches" ]; then
        fail "Docs reference port $WRONG_PORT but code default is $CODE_PORT:\n$wrong_matches"
    fi
fi

# 3. Worker must be marked experimental
echo "Checking Worker experimental status..."
for file in "$REPO_ROOT/docs/support-matrix.json" "$REPO_ROOT/docs/release-manifest.json"; do
    if [ -f "$file" ]; then
        if ! grep -q "experimental" "$file"; then
            fail "$file does not mention 'experimental' for Worker"
        fi
    else
        fail "Missing file: $file"
    fi
done

# 4. Forward secrecy claim check (must say false/No/not)
echo "Checking forward secrecy claims..."
if grep -q '"forward_secrecy": true' "$REPO_ROOT/docs/release-manifest.json" 2>/dev/null; then
    fail "release-manifest.json claims forward_secrecy: true"
fi

# 5. --allow-origin must not show full URLs in docs
echo "Checking --allow-origin documentation..."
bad_origin=$(grep -rn --include="*.md" "\-\-allow-origin https\?://" "$REPO_ROOT/docs/" "$REPO_ROOT/README.md" 2>/dev/null || true)
if [ -n "$bad_origin" ]; then
    fail "--allow-origin shown with full URL (should be host pattern only):\n$bad_origin"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
    echo "Documentation consistency check passed: all checks OK."
    exit 0
else
    echo "Documentation consistency check FAILED: $FAILURES issue(s)."
    exit 1
fi
