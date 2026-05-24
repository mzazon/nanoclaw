#!/bin/bash
# LOCAL-015: Stop hook — context size warnings + cost tracking.
# CC passes JSON on stdin with context_usage, model, stop_hook_active.

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
HOOKS_DIR="$(dirname "$0")"

# Read stdin once (Stop hook passes JSON)
INPUT=$(cat)

# Prevent infinite loops — exit if a Stop hook is already running
ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null) || ACTIVE=false
[ "$ACTIVE" = "true" ] && exit 0

# ---- Cost tracking ----
COST_LOG="${SESSION_DIR}/.cost-log.jsonl"
MODEL=$(echo "$INPUT" | jq -r '.model // "unknown"' 2>/dev/null) || MODEL="unknown"
INPUT_TOKENS=$(echo "$INPUT" | jq -r '.context_usage.input_tokens // 0' 2>/dev/null) || INPUT_TOKENS=0
OUTPUT_TOKENS=$(echo "$INPUT" | jq -r '.context_usage.output_tokens // 0' 2>/dev/null) || OUTPUT_TOKENS=0
CACHE_CREATE=$(echo "$INPUT" | jq -r '.context_usage.cache_creation_input_tokens // 0' 2>/dev/null) || CACHE_CREATE=0
CACHE_READ=$(echo "$INPUT" | jq -r '.context_usage.cache_read_input_tokens // 0' 2>/dev/null) || CACHE_READ=0

echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"model\":\"${MODEL}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS},\"cache_creation_input_tokens\":${CACHE_CREATE},\"cache_read_input_tokens\":${CACHE_READ}}" >> "$COST_LOG" 2>/dev/null || true

# ---- Context size warning ----
MAX_CONTEXT="${NANOCLAW_MAX_CONTEXT:-200000}"
[ "$MAX_CONTEXT" -gt 0 ] 2>/dev/null || exit 0
[ "$INPUT_TOKENS" -gt 0 ] 2>/dev/null || exit 0

PCT=$(( INPUT_TOKENS * 100 / MAX_CONTEXT ))

# Threshold derivation from compact percentage
COMPACT_PCT="${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-80}"
THRESH_LOW=$(( COMPACT_PCT * 40 / 100 ))
THRESH_MID=$(( COMPACT_PCT * 60 / 100 ))
THRESH_HIGH=$(( COMPACT_PCT * 80 / 100 ))

warn_once() {
  local level="$1" msg="$2"
  local marker="/tmp/cc-context-warn-${level}"
  [ -f "$marker" ] && return
  touch "$marker"
  "${HOOKS_DIR}/write-outbound.sh" "$msg" 2>/dev/null || true
}

if [ "$PCT" -ge "$THRESH_HIGH" ]; then
  warn_once "high" "Context at ${PCT}% — auto-compact imminent."
elif [ "$PCT" -ge "$THRESH_MID" ]; then
  warn_once "mid" "Context at ${PCT}% — getting full."
elif [ "$PCT" -ge "$THRESH_LOW" ]; then
  warn_once "low" "Context at ${PCT}% — running normally."
fi

exit 0
