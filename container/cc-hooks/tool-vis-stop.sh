#!/bin/bash
# LOCAL-015: Stop hook — clear tool-vis state between turns.
# Without this, the streamingId persists and turn 2's first message
# would edit turn 1's final tool-vis message.
SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"

rm -f "${SESSION_DIR}/.tool-vis-streamid" \
      "${SESSION_DIR}/.tool-vis-lines" \
      "${SESSION_DIR}/.tool-vis-lines.lock" \
      2>/dev/null

exit 0
