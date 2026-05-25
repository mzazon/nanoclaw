#!/bin/bash
# LOCAL-015: UserPromptSubmit hook — inject context stats into every turn.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
STATUS_FILE="${SESSION_DIR}/.cc-status.json"

[ -f "$STATUS_FILE" ] || exit 0

MTIME=$(stat -c %Y "$STATUS_FILE" 2>/dev/null) || exit 0
NOW=$(date +%s)
(( NOW - MTIME > 300 )) && exit 0

CTX_PCT=$(jq -r '.context_pct // 0' "$STATUS_FILE")
CTX_TOKENS=$(jq -r '.context_tokens // 0' "$STATUS_FILE")
CTX_WINDOW=$(jq -r '.context_window // 0' "$STATUS_FILE")
COST=$(jq -r '.cost_usd // 0' "$STATUS_FILE")
RATE_5H=$(jq -r '.rate_limit_pct // empty' "$STATUS_FILE")
RATE_5H_RESETS=$(jq -r '.rate_limit_resets_at // empty' "$STATUS_FILE")
RATE_7D=$(jq -r '.rate_limit_7d_pct // empty' "$STATUS_FILE")
RATE_7D_RESETS=$(jq -r '.rate_limit_7d_resets_at // empty' "$STATUS_FILE")

format_tokens() {
  local t=$1
  if (( t >= 1000000 )); then
    local whole=$(( t / 1000000 ))
    local frac=$(( (t % 1000000) / 100000 ))
    printf "%d.%dM" "$whole" "$frac"
  elif (( t >= 1000 )); then
    printf "%dk" "$(( t / 1000 ))"
  else
    printf "%d" "$t"
  fi
}

format_resets() {
  local epoch=$1 fmt=$2
  date -d "@$epoch" +"$fmt" 2>/dev/null || echo "?"
}

CTX_T=$(format_tokens "$CTX_TOKENS")
CTX_W=$(format_tokens "$CTX_WINDOW")
CTX_INT=${CTX_PCT%.*}

LINE="ctx:${CTX_INT}% ${CTX_T}/${CTX_W} | \$${COST}"

if [ -n "$RATE_5H" ]; then
  PART=" | 5h:${RATE_5H%.*}%"
  [ -n "$RATE_5H_RESETS" ] && PART="${PART} resets:$(format_resets "$RATE_5H_RESETS" "%H:%M")"
  LINE="${LINE}${PART}"
fi

if [ -n "$RATE_7D" ]; then
  PART=" | 7d:${RATE_7D%.*}%"
  [ -n "$RATE_7D_RESETS" ] && PART="${PART} resets:$(format_resets "$RATE_7D_RESETS" "%m/%d")"
  LINE="${LINE}${PART}"
fi

echo "[${LINE}]"
