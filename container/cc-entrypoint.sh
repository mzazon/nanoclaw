#!/bin/bash
# LOCAL-015: CC-container entrypoint.
# Runs Claude Code in a tmux session with the bridge channel plugin
# for message routing. Looks like a devcontainer running CC with a
# channel plugin under development.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
PROJECT_DIR="/workspaces/project"

# ---- Onboarding bypass ----
CLAUDE_DIR="${HOME}/.claude"
mkdir -p "$CLAUDE_DIR"
cat > "${HOME}/.claude.json" <<'EOF'
{"hasCompletedOnboarding":true,"numStartups":2,"installMethod":"native","lastOnboardingVersion":"2.1.128"}
EOF

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

# --continue only if a prior CC session exists in the container's .claude dir.
# Without a prior session, --continue causes CC to print "No conversation found" and exit.
if [ "${NANOCLAW_NO_CONTINUE:-0}" != "1" ]; then
  if find "${CLAUDE_DIR}/projects" -name "*.jsonl" -print -quit 2>/dev/null | grep -q .; then
    CLAUDE_ARGS="$CLAUDE_ARGS --continue"
  fi
fi

if [ -n "${NANOCLAW_MODEL:-}" ]; then
  CLAUDE_ARGS="$CLAUDE_ARGS --model $NANOCLAW_MODEL"
fi

# ---- Picker denial hook ----
HOOKS_DIR="${CLAUDE_DIR}/hooks"
mkdir -p "$HOOKS_DIR"
if [ -f /app/cc-hooks/pretool-deny-picker.sh ]; then
  cp /app/cc-hooks/pretool-deny-picker.sh "$HOOKS_DIR/"
  chmod +x "$HOOKS_DIR/pretool-deny-picker.sh"
fi
cat > "$CLAUDE_DIR/settings.json" <<SETTINGS
{
  "trustedFolders": ["${PROJECT_DIR}", "/home/node"],
  "skipDangerousModePermissionPrompt": true,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion|ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/pretool-deny-picker.sh \$TOOL_NAME"
          }
        ]
      }
    ]
  }
}
SETTINGS

# ---- PTY output file ----
PTY_OUTPUT="${SESSION_DIR}/.pty-output"
: > "$PTY_OUTPUT"

# ---- Start tmux session ----
tmux new-session -d -s cc -c "$PROJECT_DIR" "$CLAUDE_BIN $CLAUDE_ARGS"
tmux pipe-pane -O -t cc "cat >> ${PTY_OUTPUT}"

# ---- Auto-accept startup prompts ----
# Watch PTY output and respond to specific prompts.
(
  for i in $(seq 1 30); do
    sleep 2
    SCREEN=$(tmux capture-pane -p -t cc 2>/dev/null || true)
    case "$SCREEN" in
      *"text style"*|*"theme"*)
        tmux send-keys -t cc Enter 2>/dev/null ;;
      *"trust this folder"*)
        tmux send-keys -t cc Enter 2>/dev/null ;;
      *"I accept"*|*"Bypass Permissions"*)
        tmux send-keys -t cc Up Enter 2>/dev/null ;;
      *"local development"*|*"development channels"*)
        tmux send-keys -t cc Up Enter 2>/dev/null ;;
      *"❯"*|*">"*)
        # Agent prompt ready — stop accepting
        break ;;
    esac
  done
) &

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
