#!/bin/bash
# LOCAL-015: PreCompact hook — notify user that context is compacting.
exec "$(dirname "$0")/write-outbound.sh" \
  "⏳ Compacting context — brief processing delay expected."
