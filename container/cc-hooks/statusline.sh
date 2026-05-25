#!/bin/bash
# LOCAL-015: CC status line hook — reads structured JSON, writes state file,
# alerts at thresholds, outputs TUI one-liner.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
STATUS_FILE="${SESSION_DIR}/.cc-status.json"
LATCH_FILE="${SESSION_DIR}/.statusline-alerted"
HOOKS_DIR="$(dirname "$0")"

INPUT=$(cat)
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "unknown"')
CTX_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0')
CTX_WINDOW=$(echo "$INPUT" | jq -r '.context_window.context_window_size // 0')
CTX_TOKENS=$(echo "$CTX_PCT $CTX_WINDOW" | awk '{printf "%d", $1 * $2 / 100}')
COST_RAW=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0')
COST=$(printf "%.2f" "$COST_RAW")
RATE_PCT=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty')
RATE_RESETS=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty')
RATE_7D_PCT=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // empty')
RATE_7D_RESETS=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.resets_at // empty')
EFFORT=$(echo "$INPUT" | jq -r '.effort.level // "unknown"')

# ---- Write state file ----
mkdir -p "$SESSION_DIR"
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg model "$MODEL" \
  --argjson ctx_pct "${CTX_PCT:-0}" \
  --argjson ctx_tokens "${CTX_TOKENS:-0}" \
  --argjson ctx_window "${CTX_WINDOW:-0}" \
  --argjson cost "${COST:-0}" \
  --arg rate_pct "${RATE_PCT:-}" \
  --arg rate_resets "${RATE_RESETS:-}" \
  --arg rate_7d_pct "${RATE_7D_PCT:-}" \
  --arg rate_7d_resets "${RATE_7D_RESETS:-}" \
  --arg effort "$EFFORT" \
  '{
    timestamp: $ts,
    model: $model,
    context_pct: $ctx_pct,
    context_tokens: $ctx_tokens,
    context_window: $ctx_window,
    cost_usd: $cost,
    rate_limit_pct: (if $rate_pct == "" then null else ($rate_pct | tonumber) end),
    rate_limit_resets_at: (if $rate_resets == "" then null else ($rate_resets | tonumber) end),
    rate_limit_7d_pct: (if $rate_7d_pct == "" then null else ($rate_7d_pct | tonumber) end),
    rate_limit_7d_resets_at: (if $rate_7d_resets == "" then null else ($rate_7d_resets | tonumber) end),
    effort: $effort
  }' > "$STATUS_FILE"

# ---- Threshold alerts ----
alert() {
  local msg="$1"
  if [ -f "$HOOKS_DIR/write-outbound.sh" ]; then
    bash "$HOOKS_DIR/write-outbound.sh" "$msg" || true
  fi
}

if [ -n "$RATE_PCT" ]; then
  RATE_INT=${RATE_PCT%.*}
  LATCH_THRESHOLD=0
  LATCH_RESETS=0
  if [ -f "$LATCH_FILE" ]; then
    LATCH_THRESHOLD=$(head -1 "$LATCH_FILE" 2>/dev/null || echo 0)
    LATCH_RESETS=$(tail -1 "$LATCH_FILE" 2>/dev/null || echo 0)
  fi

  # Reset latch if rate limit window advanced
  if [ -n "$RATE_RESETS" ] && [ "$RATE_RESETS" != "$LATCH_RESETS" ]; then
    LATCH_THRESHOLD=0
  fi

  if [ "$RATE_INT" -ge 95 ] && [ "$LATCH_THRESHOLD" -lt 95 ]; then
    alert "🔴 95% of session limit — session will pause soon"
    echo "95" > "$LATCH_FILE"
    echo "${RATE_RESETS:-0}" >> "$LATCH_FILE"
  elif [ "$RATE_INT" -ge 80 ] && [ "$LATCH_THRESHOLD" -lt 80 ]; then
    alert "⚠️ 80% of session limit used"
    echo "80" > "$LATCH_FILE"
    echo "${RATE_RESETS:-0}" >> "$LATCH_FILE"
  fi
fi

CTX_INT=${CTX_PCT%.*}
if [ "$CTX_INT" -ge 80 ]; then
  CTX_LATCH="${SESSION_DIR}/.statusline-ctx-alerted"
  if [ ! -f "$CTX_LATCH" ]; then
    alert "⚠️ Context window at ${CTX_INT}% — consider compacting"
    touch "$CTX_LATCH"
  fi
fi

# ---- TUI one-liner ----
LIMIT_PART=""
if [ -n "$RATE_PCT" ]; then
  LIMIT_PART=" 5h:${RATE_PCT%.*}%"
fi
if [ -n "$RATE_7D_PCT" ]; then
  LIMIT_PART="${LIMIT_PART} 7d:${RATE_7D_PCT%.*}%"
fi
echo "[${MODEL}] ctx:${CTX_INT}% cost:\$${COST}${LIMIT_PART}"
