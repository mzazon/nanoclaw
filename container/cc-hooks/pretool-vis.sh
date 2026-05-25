#!/bin/bash
# LOCAL-015: PreToolUse hook — accumulate tool-call visibility lines.
# Appends a one-line description of the tool being called to a sidecar file.
# PostToolBatch reads this file and writes a consolidated message to outbound.db.
set -euo pipefail

SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
VIS_FILE="${SESSION_DIR}/.tool-vis-lines"
SID_FILE="${SESSION_DIR}/.tool-vis-streamid"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ -n "$TOOL_NAME" ] || exit 0

TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

# Generate streamingId once per turn (Stop hook clears it)
if [ ! -f "$SID_FILE" ]; then
  echo "tvs-$(date +%s)-$$" > "$SID_FILE"
fi

# Format tool description
case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$TOOL_INPUT" | jq -r '.command // ""' | tr '\n' ' ' | sed 's/  */ /g')
    # Extract first meaningful command
    FIRST=$(echo "$CMD" | sed 's/&&.*//' | sed 's/|.*//' | head -c 60)
    LINE="⚡ bash     ${FIRST}"
    ;;
  Read)
    FP=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    SHORT=$(echo "$FP" | sed 's|.*/||')
    LINE="📄 read     ${SHORT}"
    ;;
  Edit)
    FP=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    SHORT=$(echo "$FP" | sed 's|.*/||')
    LINE="✏️ edit     ${SHORT}"
    ;;
  Write)
    FP=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    SHORT=$(echo "$FP" | sed 's|.*/||')
    LINE="📝 write    ${SHORT}"
    ;;
  Glob)
    PAT=$(echo "$TOOL_INPUT" | jq -r '.pattern // ""')
    LINE="🔍 glob     ${PAT}"
    ;;
  Grep)
    PAT=$(echo "$TOOL_INPUT" | jq -r '.pattern // ""')
    LINE="🔍 grep     ${PAT}"
    ;;
  WebFetch)
    URL=$(echo "$TOOL_INPUT" | jq -r '.url // ""' | sed 's|^https\?://||' | head -c 40)
    LINE="🌐 fetch    ${URL}"
    ;;
  WebSearch)
    Q=$(echo "$TOOL_INPUT" | jq -r '.query // ""' | head -c 40)
    LINE="🔎 search   ${Q}"
    ;;
  Agent)
    DESC=$(echo "$TOOL_INPUT" | jq -r '.description // "subagent"' | head -c 40)
    LINE="🤖 agent    ${DESC}"
    ;;
  mcp__*)
    # MCP tools: strip prefix for display
    SHORT_NAME=$(echo "$TOOL_NAME" | sed 's/^mcp__[^_]*__//')
    LINE="🔧 mcp      ${SHORT_NAME}"
    ;;
  *)
    LINE="🔧 tool     ${TOOL_NAME}"
    ;;
esac

# Atomic append with flock to handle concurrent parallel tool calls
(flock 9; echo "$LINE" >> "$VIS_FILE") 9>"${VIS_FILE}.lock"

exit 0
