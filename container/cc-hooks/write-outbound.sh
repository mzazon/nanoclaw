#!/bin/bash
# LOCAL-015: Write a message to outbound.db for host delivery.
# Usage: write-outbound.sh "message text" [kind]
# Called by cc-container hook scripts. Reads session routing from
# inbound.db, computes next odd seq, inserts into outbound.db.
set -euo pipefail

MSG="${1:?Usage: write-outbound.sh \"message\" [kind]}"
KIND="${2:-chat}"
SESSION_DIR="${NANOCLAW_SESSION_DIR:-/workspaces/.nanoclaw}"
OUTDB="${SESSION_DIR}/outbound.db"
INDB="${SESSION_DIR}/inbound.db"

[ -f "$OUTDB" ] || exit 0
[ -f "$INDB" ] || exit 0

# Read routing — channel_type|platform_id
ROUTING=$(sqlite3 "$INDB" "SELECT channel_type || '|' || platform_id FROM session_routing LIMIT 1" 2>/dev/null) || exit 0
CH_TYPE="${ROUTING%%|*}"
PLAT_ID="${ROUTING#*|}"

[ -n "$CH_TYPE" ] || exit 0

# Next odd seq (container uses odd, host uses even)
MAX_OUT=$(sqlite3 "$OUTDB" "SELECT COALESCE(MAX(seq), 0) FROM messages_out" 2>/dev/null) || MAX_OUT=0
MAX_IN=$(sqlite3 "$INDB" "SELECT COALESCE(MAX(seq), 0) FROM messages_in" 2>/dev/null) || MAX_IN=0
MAX=$(( MAX_OUT > MAX_IN ? MAX_OUT : MAX_IN ))
SEQ=$(( MAX % 2 == 0 ? MAX + 1 : MAX + 2 ))

ID="hook-$(date +%s)-$$"
# If input is already JSON with a "text" key, pass through; otherwise wrap it
if echo "$MSG" | jq -e '.text' >/dev/null 2>&1; then
  JSON_CONTENT="$MSG"
else
  JSON_CONTENT=$(jq -n --arg text "$MSG" '{"text": $text}')
fi

sqlite3 "$OUTDB" "
  PRAGMA journal_mode=DELETE;
  INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, platform_id, content)
  VALUES ('${ID}', ${SEQ}, datetime('now'), '${KIND}', '${CH_TYPE}', '${PLAT_ID}', '$(echo "$JSON_CONTENT" | sed "s/'/''/g")');
" 2>/dev/null || true
