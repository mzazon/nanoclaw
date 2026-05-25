#!/bin/bash
# LOCAL-015: PostToolBatch hook — flush accumulated tool-vis lines to outbound.db.
# Reads lines from the sidecar file, writes a consolidated _toolVis message
# using the same _streamingId so the host edits a single Slack message per turn.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
VIS_FILE="${SESSION_DIR}/.tool-vis-lines"
SID_FILE="${SESSION_DIR}/.tool-vis-streamid"
HOOKS_DIR="$(dirname "$0")"

[ -f "$VIS_FILE" ] || exit 0
[ -s "$VIS_FILE" ] || exit 0
[ -f "$SID_FILE" ] || exit 0

STREAM_ID=$(cat "$SID_FILE" 2>/dev/null) || true
[ -n "$STREAM_ID" ] || exit 0

# Read ALL accumulated lines (do NOT clear — each flush sends the full history
# so the edited Slack message shows all tools from the turn, not just the latest batch).
LINES=$(flock "${VIS_FILE}.lock" cat "$VIS_FILE")

[ -n "$LINES" ] || exit 0

# Build JSON content matching agent-runner's _toolVis format
ESCAPED_TEXT=$(printf '%s' "$LINES" | jq -Rs '.')
CONTENT="{\"text\":${ESCAPED_TEXT},\"_toolVis\":true,\"_streamingId\":\"${STREAM_ID}\"}"

"$HOOKS_DIR/write-outbound.sh" "$CONTENT" "chat"

exit 0
