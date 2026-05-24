#!/bin/bash
# LOCAL-015: CC-container entrypoint.
# Runs Claude Code in a tmux session with the bridge channel plugin
# for message routing. Looks like a devcontainer running CC with a
# channel plugin under development.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
PROJECT_DIR="/workspaces/project"

# ---- Resolve Claude binary + version ----
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ] || ! "$CLAUDE_BIN" --version &>/dev/null; then
  echo "[cc-entrypoint] Claude binary missing or broken — reinstalling..." >&2
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -3 >&2
  CLAUDE_BIN="$(command -v claude)"
fi
CC_VERSION="$("$CLAUDE_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '2.1.128')"
CC_VERSION="${CC_VERSION:-2.1.128}"

# ---- Onboarding bypass ----
# Pre-populate .claude.json to skip ALL interactive prompts: theme picker,
# trust dialog, hooks trust, onboarding, cost threshold, effort callout.
# Written to three locations — CC checks different paths across versions.
# GrowthBook flags cached so CC doesn't need network to evaluate them.
# Dev-channels prompt has no config bypass — fallback loop handles it.
# lastOnboardingVersion is set dynamically to prevent CC version bumps
# from re-triggering onboarding prompts (hermit pattern).
CLAUDE_DIR="${HOME}/.claude"
mkdir -p "$CLAUDE_DIR"
CC_CONFIG='{
  "hasCompletedOnboarding": true,
  "numStartups": 10,
  "installMethod": "native",
  "lastOnboardingVersion": "'"$CC_VERSION"'",
  "lastReleaseNotesSeen": "'"$CC_VERSION"'",
  "migrationVersion": 13,
  "opusProMigrationComplete": true,
  "sonnet1m45MigrationComplete": true,
  "officialMarketplaceAutoInstallAttempted": true,
  "officialMarketplaceAutoInstalled": true,
  "hasTrustDialogAccepted": true,
  "hasTrustDialogHooksAccepted": true,
  "hasAcknowledgedCostThreshold": true,
  "effortCalloutV2Dismissed": true,
  "theme": "dark",
  "projects": {
    "/workspaces/project": {
      "hasTrustDialogAccepted": true,
      "hasTrustDialogHooksAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  },
  "cachedGrowthBookFeatures": {
    "tengu_harbor": true,
    "tengu_ccr_bridge": true,
    "tengu_gouda_loop": true,
    "tengu_worktree_mode": true,
    "tengu_kairos_cron": true,
    "tengu_cobalt_raccoon": true,
    "tengu_disable_bypass_permissions_mode": false,
    "tengu_bridge_repl_v2": true,
    "tengu_streaming_tool_execution2": true,
    "tengu_kairos_loop_dynamic": true,
    "tengu_kairos_push_notifications": true,
    "tengu_mcp_elicitation": true,
    "tengu_cobalt_compass": true,
    "tengu_harbor_permissions": true,
    "tengu_permission_friction": true,
    "tengu_mcp_singleton_unwrap": true,
    "tengu_penguins_enabled": true,
    "tengu_keybinding_customization_release": true,
    "tengu_copper_bridge": true,
    "tengu_sedge_lantern": true
  }
}'
# Write or merge config. If file exists (from named volume), merge baked
# fields over it to preserve plugins/auth/theme. Otherwise create fresh.
write_or_merge_config() {
  local target="$1"
  if [ -f "$target" ] && command -v jq &>/dev/null; then
    jq -s '.[0] * .[1]' "$target" <(echo "$CC_CONFIG") > "${target}.tmp"
    mv "${target}.tmp" "$target"
  else
    echo "$CC_CONFIG" > "$target"
  fi
}
write_or_merge_config "${HOME}/.claude.json"
write_or_merge_config "${CLAUDE_DIR}/.config.json"
write_or_merge_config "${CLAUDE_DIR}/claude.json"

# ---- Git safe directories for mounted volumes ----
git config --global --add safe.directory "$PROJECT_DIR"
git config --global --add safe.directory "${PROJECT_DIR}/agent" 2>/dev/null || true

# ---- Build Claude Code command ----
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

# ---- Hook scripts ----
HOOKS_DIR="${CLAUDE_DIR}/hooks"
mkdir -p "$HOOKS_DIR"
for hook in /app/cc-hooks/*.sh; do
  [ -f "$hook" ] || continue
  cp "$hook" "$HOOKS_DIR/"
  chmod +x "$HOOKS_DIR/$(basename "$hook")"
done
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
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/pre-compact-notify.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/stop-observability.sh"
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

# ---- Auto-accept startup prompts (fallback) ----
# With baked .claude.json, most prompts are skipped. This catches
# any that slip through on CC version upgrades or flag changes.
(
  sleep 1
  for i in $(seq 1 15); do
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
        break ;;
    esac
    sleep 1
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
