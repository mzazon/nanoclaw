# NanoClaw — Operator Notes

## PUBLIC REPO — NEVER COMMIT SECRETS

This fork (github.com/mzazon/nanoclaw) is **public**. Never commit:
- API keys, tokens, secrets, or credentials (even in docs or comments)
- Session handoff documents (they contain infrastructure details)
- Design specs that reference internal secrets or architecture
- Anything from `groups/*/CLAUDE.local.md` (agent identity, personality, private context)

Session handoffs go to `~/vault/_Agents/claude/sessions/`. Specs/plans go to `~/vault/Projects/NanoClaw/` or stay in conversation context only. The `.gitignore` blocks `docs/sessions/` and `docs/superpowers/` but vigilance is still required.

## Git Branching Strategy

```
upstream (qwibitai/nanoclaw)     origin (mzazon/nanoclaw)
         │                                │
    upstream/main ◄── main ──────────────► origin/main     (clean mirror)
                          \
                           local ────────► origin/local     (all customizations)
```

**Branches:**
- `main` — clean upstream mirror. Tracks `upstream/main`. Never commit customizations here.
- `local` — all our customizations. Merges from `main` to pull in upstream updates.
- Bug fix PRs — branch from `main`, push to `origin`, open PR against `upstream`.

**Pulling upstream updates:**
```bash
git fetch upstream
git checkout main && git merge upstream/main
git checkout local && git merge main
# resolve conflicts (LOCAL-NNN markers help identify our changes)
pnpm run build && pnpm test
```

**The `/update-nanoclaw` skill** works on the current branch. Run it while on `local` — it will merge `upstream/main` into `local`, resolve conflicts, validate the build. It handles the backup/preview/merge/validation steps automatically. Before running it, sync main first:
```bash
git checkout main && git merge upstream/main && git checkout local
# then run /update-nanoclaw
```

**Contributing bug fixes upstream:**
```bash
git checkout main && git checkout -b fix/description
# make the fix (no local customizations)
git push -u origin fix/description
gh pr create --repo qwibitai/nanoclaw
```

## Debugging Agent Behavior

When an agent isn't following instructions or a new feature isn't working:

### 1. Check CLAUDE.local.md is actually loaded

The composed `CLAUDE.md` in `groups/<folder>/` must end with `@./CLAUDE.local.md`. If it doesn't, the agent has never seen its identity or instructions. The compose function is in `src/claude-md-compose.ts`.

```bash
cat groups/<folder>/CLAUDE.md          # verify @./CLAUDE.local.md is listed
docker exec <container> cat /workspace/agent/CLAUDE.local.md   # verify content inside container
```

### 2. Check session continuation

A stale continuation means the agent resumes with compacted context from before your changes. Always clear after editing CLAUDE.local.md, changing providers, or adding MCP tools.

```bash
# Check
sqlite3 data/v2-sessions/<ag-id>/<sess-id>/outbound.db "SELECT * FROM session_state;"

# Clear
sqlite3 data/v2-sessions/<ag-id>/<sess-id>/outbound.db "DELETE FROM session_state WHERE key LIKE 'continuation%';"
docker kill <container-name>
```

### 3. Read the Claude Code JSONL

The definitive record of what the model did and why. Shows every tool call, every decision.

```bash
# Find session files
find data/v2-sessions/<ag-id>/.claude-shared/projects/-workspace-agent/ -name "*.jsonl" | sort

# Parse into readable form (pipe through python)
cat <file>.jsonl | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        t = obj.get('type', '?')
        ts = obj.get('timestamp', '')
        if t == 'assistant':
            for c in obj.get('message', {}).get('content', []):
                if c.get('type') == 'text':
                    print(f'L{i+1} [{ts}] ASSISTANT: {c[\"text\"][:300]}')
                elif c.get('type') == 'tool_use':
                    print(f'L{i+1} [{ts}] TOOL_USE: {c[\"name\"]}({json.dumps(c.get(\"input\",{}))[:200]})')
        elif t == 'user':
            msg = obj.get('message',{}).get('content','')
            if isinstance(msg, str):
                print(f'L{i+1} [{ts}] USER: {msg[:300]}')
    except: pass
"
```

### 4. Check destinations

Destinations are projected from the central DB (`agent_destinations`) into per-session `inbound.db`. If a destination exists centrally but not in the session, the agent can't see it.

```bash
# Central (source of truth)
sqlite3 data/v2.db "SELECT * FROM agent_destinations WHERE agent_group_id = '<id>';"

# Session projection (what the agent sees)
sqlite3 data/v2-sessions/<ag-id>/<sess-id>/inbound.db "SELECT * FROM destinations;"
```

`target_type` must be `'channel'` or `'agent'`. The value `'messaging_group'` silently fails — `writeDestinations()` skips it.

### 5. Check MCP tool availability

MCP tools are deferred in Claude Code. The model must `ToolSearch` for them. If instructions reference an MCP tool, include the full `ToolSearch` call:

```
ToolSearch(query="select:mcp__nanoclaw__<tool_name>", max_results=1)
```

Without this, the model will only find tools it already knows about.

### 6. Check outbound messages

See what an agent actually sent vs what it claims:

```bash
sqlite3 data/v2-sessions/<ag-id>/<sess-id>/outbound.db \
  "SELECT seq, kind, channel_type, substr(content, 1, 300) FROM messages_out ORDER BY seq DESC LIMIT 10;"
```

`kind: chat` = normal message, `kind: system` = system action (schedule_task, create_forum_thread, etc.), `channel_type: agent` = inter-agent message.

### 7. Container inspection

```bash
docker ps --filter "name=<agent>" --format "{{.Names}} {{.Status}}"
docker logs <container-name> 2>&1 | tail -20
docker exec <container> find /app/src/mcp-tools/ -name "*.ts"   # verify tools in image
```

## Key Architectural Facts

- `send_message(to="<channel>")` preserves the session's `thread_id` when the destination matches the session's origin channel. It CANNOT create new threads — use `create_forum_thread` for that.
- The bot's own messages in Discord don't trigger inbound events back to itself.
- System actions (`kind: 'system'`) are handled by `registerDeliveryAction` handlers in `src/modules/`. They run on the host, not in the container.
- `agent_provider` in the `agent_groups` table controls which provider a group uses. NULL defaults to `'claude'`. The provider resolution chain: `sessions.agent_provider` > `agent_groups.agent_provider` > `container.json` `provider` field > `'claude'`.
- The model setting for Claude provider groups is in `data/v2-sessions/<ag-id>/.claude-shared/settings.json` (`"model": "claude-sonnet-4-6"`).
