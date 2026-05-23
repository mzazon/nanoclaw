#!/bin/bash
# LOCAL-015: CC-container entrypoint.
# Runs Claude Code in a tmux session with the bridge channel plugin
# for message routing. Looks like a devcontainer running CC with a
# channel plugin under development.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
PROJECT_DIR="/workspaces/project"

# ---- Onboarding bypass + telemetry disable ----
CLAUDE_DIR="${HOME}/.claude"
mkdir -p "$CLAUDE_DIR"
if [ ! -f "$CLAUDE_DIR/.claude.json" ]; then
  cat > "$CLAUDE_DIR/.claude.json" <<'EOF'
{"hasTrustDialogAccepted":true,"hasCompletedOnboarding":true,"telemetryDisabled":true,"autoUpdaterDisabled":true,"preferredNotifChannel":"none"}
EOF
fi

# ---- Git safe directories for mounted volumes ----
git config --global --add safe.directory "$PROJECT_DIR"
git config --global --add safe.directory "${PROJECT_DIR}/agent" 2>/dev/null || true

# ---- Build Claude Code command ----
CLAUDE_BIN="$(command -v claude)"
CLAUDE_ARGS="--dangerously-skip-permissions"
CLAUDE_ARGS="$CLAUDE_ARGS --dangerously-load-development-channels server:bridge"

if [ -f "${SESSION_DIR}/.mcp.json" ]; then
  CLAUDE_ARGS="$CLAUDE_ARGS --mcp-config ${SESSION_DIR}/.mcp.json"
fi

CLAUDE_ARGS="$CLAUDE_ARGS --add-dir ${PROJECT_DIR}"

if [ "${NANOCLAW_NO_CONTINUE:-0}" != "1" ]; then
  CLAUDE_ARGS="$CLAUDE_ARGS --continue"
fi

if [ -n "${NANOCLAW_MODEL:-}" ]; then
  CLAUDE_ARGS="$CLAUDE_ARGS --model $NANOCLAW_MODEL"
fi

# ---- PTY output file ----
PTY_OUTPUT="${SESSION_DIR}/.pty-output"
: > "$PTY_OUTPUT"

# ---- Start tmux session ----
tmux new-session -d -s cc -c "$PROJECT_DIR" "$CLAUDE_BIN $CLAUDE_ARGS"
tmux pipe-pane -O -t cc "cat >> ${PTY_OUTPUT}"

# ---- Auto-accept dev-channels prompt (5s) ----
(sleep 5 && tmux send-keys -t cc Enter 2>/dev/null) &

# ---- Signal trap — graceful shutdown ----
cleanup() {
  tmux send-keys -t cc '/exit' Enter 2>/dev/null || true
  local i=0
  while tmux has-session -t cc 2>/dev/null && [ $i -lt 30 ]; do
    sleep 1
    i=$((i + 1))
  done
  tmux kill-session -t cc 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# ---- Keepalive — exit when tmux session ends ----
while tmux has-session -t cc 2>/dev/null; do
  sleep 2
done
