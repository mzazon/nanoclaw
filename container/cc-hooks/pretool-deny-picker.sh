#!/bin/bash
# LOCAL-015: PreToolUse hook — deny AskUserQuestion and ExitPlanMode.
# These render picker UIs in the local terminal that remote users can't see,
# causing the session to hang indefinitely.

TOOL_NAME="$1"

case "$TOOL_NAME" in
  AskUserQuestion|ExitPlanMode)
    cat <<DENY
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "${TOOL_NAME} is blocked: its picker UI renders only in the local terminal, so the remote user cannot see or respond to it and the session will hang.\n\nInstead, send your question (or plan) as a regular message via the reply tool, with options written as numbered lines. Then wait for the user's next message — that reply is the answer."
  }
}
DENY
    ;;
  *)
    echo '{}'
    ;;
esac
