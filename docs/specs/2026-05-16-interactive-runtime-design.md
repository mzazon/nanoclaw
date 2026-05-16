# Interactive Runtime — Channel-Plugin Architecture

**Status:** Implemented (v1)
**Date:** 2026-05-16
**Supersedes:** `~/vault/_Inbox/2026-05-15 NanoClaw Interactive Provider Spec.md` (PTY + hooks approach)

## Problem Statement

Effective June 15, 2026, Anthropic moved all programmatic Claude Code usage (`--print`, Agent SDK, GitHub Actions) to a capped credit bucket at API rates. Max 5x: $100/month. A single nightly cron at ~$1.50/run burns $51/month. Interactive (TUI) sessions remain subscription-billed with no cap.

NanoClaw needs a runtime mode that drives Claude Code in interactive mode via its official channel plugin contract, billing against the unlimited subscription instead of the credit bucket.

## Prior Art

See `~/vault/Sources/Research/Claude Code TUI Headless Workarounds 2026.md` for the full landscape. Community converged on PTY spawn + hooks + sentinel files + transcript JSONL tailing. Three main projects: claude-pee (Rust), claude-heartbeat (Node), claude-p (Zig/MIT, 265 stars).

This spec takes a different approach: Claude Code's **channel plugin system** (`claude/channel` MCP capability) replaces all three fragile layers (hook injection, sentinel detection, transcript parsing) with a single officially-supported MCP contract.

## Architecture

### Runtime Mode, Not Provider

Interactive mode is a new **runtime mode** alongside `docker` and `host`, not a provider. The agent-runner (`container/agent-runner/`) is not involved. Claude Code itself is the entire agent runtime — it handles tools, MCP servers, compaction, skills, and plugins natively.

```
container-runner.ts spawnContainer()
  ├── runtime: 'docker'       → buildContainerArgs → docker run ...
  ├── runtime: 'host'         → spawnHostProcess()  (host-runner.ts)
  └── runtime: 'interactive'  → spawnInteractiveSession() (interactive-runner.ts) ← NEW
```

### Component Overview

```
NanoClaw host process
  │
  ├── router.ts writes inbound.db (unchanged)
  ├── delivery.ts polls outbound.db (unchanged)
  │
  └── interactive-runner.ts spawns:
        claude --dangerously-load-development-channels server:nanoclaw-bridge
          │
          └── nanoclaw-bridge (MCP server, stdio)
                ├── polls inbound.db → notifications/claude/channel
                ├── reply tool → writes outbound.db
                ├── send_message tool → writes outbound.db (destination routing)
                └── send_file tool → writes outbound.db (file attachments)
```

Three new components:

1. **`src/interactive-runner.ts`** — Host-side factory. Builds env, resolves `claude` binary, writes `.mcp.json`, spawns the PTY process, manages PID file. Returns `{child, name, pidFile}` to container-runner.
2. **`bridge/server.ts`** — Channel plugin (MCP server). Bridges session DBs to the `claude/channel` contract. Replaces the entire agent-runner for interactive sessions.
3. **`src/interactive-guard.ts`** — Health monitor in `host-sweep.ts`. Detects usage limits, crashes, idle sessions. Triggers restart.

### What Stays the Same

- `delivery.ts` polls `outbound.db` — unchanged
- `router.ts` writes `inbound.db` — unchanged
- Session DBs, entity model, wiring — unchanged
- Host sweep timing, heartbeat path convention — unchanged
- `container-runner.ts` lifecycle management (`activeContainers`, `attachProcessLifecycle`) — reused

### What's Bypassed

- `container/agent-runner/` entirely — poll loop, formatter, provider abstraction
- Claude Code handles tools, MCP servers, compaction, skills, plugins natively

## Channel Plugin (bridge/server.ts)

MCP server using `@modelcontextprotocol/sdk`, spawned by CC as a subprocess via stdio.

### Capabilities

```typescript
capabilities: {
  experimental: { 'claude/channel': {} },
  tools: {},
},
```

Permission relay (`claude/channel/permission`) deferred to future work — could integrate with NanoClaw's approval system.

### Inbound (session DB → Claude)

- Polls `inbound.db` `messages_in` on 1s interval
- Reads pending messages (same query as `container/agent-runner/src/db/messages-in.ts`)
- Emits `notifications/claude/channel` per message:
  ```typescript
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: messageText,
      meta: {
        chat_id: messagingGroupId,
        message_id: messageId,
        user: senderHandle,
        ts: timestamp,
        destination: defaultDestination,
      },
    },
  })
  ```
- Writes `processing_ack` back to inbound.db
- Respects `on_wake` column for fresh-spawn messages
- Touches `.heartbeat` on every poll cycle

### Outbound (Claude → session DB)

Three MCP tools exposed via `ListToolsRequestSchema` / `CallToolRequestSchema`:

| Tool | Purpose | Maps to |
|------|---------|---------|
| `reply` | Send text to the originating chat | Write `messages_out` with destination from inbound meta |
| `send_message` | Send to a named destination | Write `messages_out` with explicit destination |
| `send_file` | Send file attachment | Write `messages_out` with file path |

These replace the equivalent tools in `container/agent-runner/src/mcp-tools/`. The bridge reads the destinations table from inbound.db (host writes it at wake time via `writeDestinations`).

Touches `.heartbeat` on every outbound write.

### Instructions

```typescript
instructions: [
  'Messages arrive as <channel source="nanoclaw-bridge" chat_id="..." message_id="..." user="..." ts="...">.',
  'Reply using the reply tool — your transcript output does not reach the sender.',
  'Use send_message for cross-destination routing (e.g., posting to #ops).',
  'Use send_file to attach files to messages.',
].join('\n')
```

Group-specific instructions (personality, rules) come from CLAUDE.md loaded natively by CC — the bridge does not compose a system prompt.

### What the Plugin Does NOT Do

- No system-prompt composition — CC reads CLAUDE.md natively
- No MCP server management — CC loads from `.mcp.json` / settings
- No compaction — CC handles it
- No tool execution — CC handles it
- No provider abstraction — CC IS the runtime

### SQLite Access

Uses `bun:sqlite` (CC runs via Bun). Opens inbound.db read-only, outbound.db read-write. `journal_mode=DELETE` (cross-mount visibility, matching agent-runner convention).

### Package Structure

```
bridge/
  server.ts          # MCP server entry
  db.ts              # inbound/outbound DB helpers
  tools.ts           # reply, send_message, send_file handlers
  package.json       # deps: @modelcontextprotocol/sdk
```

No `.claude-plugin` manifest — the bridge is a bare MCP server, not a CC plugin. Declared in `.mcp.json` written by `interactive-runner.ts`.

## Interactive Runner (src/interactive-runner.ts)

Host-side factory. Mirrors `host-runner.ts` pattern.

### Spawn Sequence

1. `initGroupFilesystem(agentGroup)`
2. `composeGroupClaudeMd(agentGroup)` — writes CLAUDE.md to session CWD
3. Resolve `claude` binary: `~/.local/bin/claude` → `which claude` → error
4. Write `.mcp.json` to session CWD declaring the bridge server
5. Build env: real `HOME` (always — needs `~/.claude/` credentials), `TZ`, bridge env vars (`NANOCLAW_SESSION_DIR`, `NANOCLAW_AGENT_GROUP_ID`)
6. Spawn with PTY via `node-pty`

### Spawn Command

```
claude --dangerously-load-development-channels server:nanoclaw-bridge
       --continue                    # resume most recent CC session in this CWD
       --model <model>               # from container config
       --permission-mode default     # CC's native permission system
       <...interactive_flags>        # extra flags from container config (optional)
```

### PTY Requirement

`claude` without `-p` is an interactive TUI that needs a terminal. `node-pty` allocates a PTY on the host side (Node process). The PTY output buffer is retained for the lifecycle guard to scan.

Fallback if `node-pty` is problematic: platform-aware `script` command:
- Linux: `script -qfc "claude ..." /dev/null`
- macOS: `script -q /dev/null claude ...`

### Session Continuity

- First spawn: no `--continue`. CC creates a new session.
- Subsequent spawns (crash/restart): `--continue` resumes most recent CC session in the CWD.
- CWD = `data/v2-sessions/<agent-group>/<session>/`. Scopes CC's persistence to NanoClaw's session.
- If CC session data is missing (user pruned `~/.claude/projects/`), `--continue` starts fresh. NanoClaw message flow continues; CC conversation context is lost. Documented behavior.

### .mcp.json Generation

Written to session CWD before spawn:

```json
{
  "mcpServers": {
    "nanoclaw-bridge": {
      "command": "bun",
      "args": ["run", "<project-root>/bridge/server.ts"],
      "env": {
        "NANOCLAW_SESSION_DIR": "<session-dir>",
        "NANOCLAW_AGENT_GROUP_ID": "<group-id>"
      }
    }
  }
}
```

Additional MCP servers from the group's container config are merged in.

### What interactive-runner Does NOT Do

- No OneCLI/proxy setup — CC uses subscription auth
- No container image management — native process
- No agent-runner source overlay — no agent-runner involved

### PID File + Orphan Cleanup

Same pattern as host-runner: `.host-pid` in session dir. `cleanupHostOrphans()` checks `/proc/<pid>/cmdline` for `claude` (host-runner checks for `agent-runner`).

## Lifecycle Guard (src/interactive-guard.ts)

Integrated into `host-sweep.ts` (60s cycle).

### Detection Matrix

| Condition | Detection | Action |
|-----------|-----------|--------|
| Usage limit hit | PTY buffer contains `rate-limit-options` | Write Enter to PTY (accept "wait for reset"). Log. Touch heartbeat. |
| CC crashed/exited | Process `close` event via `attachProcessLifecycle` | Respawn with `--continue`. Write `on_wake` if pending inbound. |
| Idle >30min | No heartbeat touch, no pending inbound | Kill process. Respawn on next inbound (standard behavior). |
| Stuck/hung | Heartbeat stale >5min, process alive, pending inbound exists | Kill + respawn with `--continue`. |
| Dev channel prompt | PTY buffer contains `I am using this for local development` | Write Enter to confirm. |

### PTY Buffer Monitoring

`node-pty` `onData` callback captures TUI output. Last ~4KB buffered in the `activeContainers` entry. Guard reads this buffer during sweep — same approach as the old `claude-code-sweep.sh` with `tmux capture-pane`.

### Heartbeat

Bridge plugin touches `.heartbeat` on every inbound poll and outbound reply. This gives sweep the same liveness signal as docker/host containers.

### Restart Strategy

- `--continue` for crash recovery
- Fresh spawn (no `--continue`) if CC reports invalid session
- Respawn through standard `wakeContainer` → `spawnContainer` → `spawnInteractiveSession` path
- Container-runner's `wakePromises` dedup prevents double-spawn

### Usage Limit Lifecycle

```
CC hits limit
  → TUI shows rate-limit-options prompt
  → guard detects in PTY buffer
  → writes Enter to PTY (accept "wait for reset")
  → CC waits internally for limit reset
  → CC resumes automatically
  → guard keeps touching heartbeat during wait
```

No kill-and-restart needed. CC handles the wait.

## Configuration

### Container Config

```json
{
  "runtime": "interactive",
  "model": "sonnet"
}
```

Most container config fields are irrelevant: no `imageTag`, no `packages`, no `provider`. `cli_scope` is not applicable (no ncl wrapper in interactive mode — ncl access would need a bridge tool).

Optional fields:
- `interactive_flags`: extra CLI flags passed to `claude` (e.g., `--max-turns`, `--effort`)

### Group Setup

```bash
ncl groups config update --id <group-id> --set '{"runtime": "interactive"}'
```

### Migration Path

Agents on `runtime: 'host'` (Agent SDK, credit-billed) switch to `runtime: 'interactive'` (subscription, uncapped) with one config change. Fallback: change back to `host`.

### Constraints

- **Host-only.** `runtime: 'interactive'` is incompatible with `runtime: 'docker'`. Enforced at spawn time.
- **Requires `claude` in PATH** on the NanoClaw host.
- **Requires active Claude subscription** (Pro/Max/Team) logged in via `claude login`.
- **Requires CC v2.1.80+** (channels research preview).
- **`--dangerously-load-development-channels`** required during research preview.
- **No OneCLI credential injection.** Interactive mode uses CC's subscription auth, not the OneCLI proxy. Agents depending on OneCLI-injected third-party credentials (Gmail, GCal, etc.) must stay on `host` or `docker`. See Future Work.

## Error Handling

### Startup Failures

| Failure | Detection | Behavior |
|---------|-----------|----------|
| `claude` not in PATH | Spawn throws | Log, don't retry. Message stays pending. |
| No subscription / not logged in | CC exits immediately | Log. Don't auto-retry. Write error to outbound.db. |
| Bridge MCP server fails to start | CC exits with MCP error | Same as above. |
| PTY allocation fails | `node-pty` throws | Try `script` fallback. If both fail, log + leave pending. |

### Runtime Failures

| Failure | Detection | Behavior |
|---------|-----------|----------|
| CC crashes mid-turn | Process exit, non-zero | Guard respawns with `--continue`. Partial output may be in outbound.db. |
| Bridge crashes but CC alive | Heartbeat stale, process alive | Guard kills + respawns. |
| inbound.db locked | Bridge read fails | Retry next poll (1s). Transient. |
| outbound.db locked | Bridge write fails | Retry next poll. Transient. |
| CC auto-compaction | Normal behavior | No impact. Bridge stays alive. |
| Disk full | Write failures | Process likely dies. Guard respawns — fails again. Same as docker/host. |

### Multi-Message During Active Turn

User sends follow-up while CC is working. Bridge polls inbound.db → picks up new message → delivers as another `notifications/claude/channel`. CC queues it naturally. Better than agent-runner which blocks on the active SDK query.

### Graceful Shutdown

`killContainer` sends SIGTERM. CC handles it gracefully — saves session, closes MCP connections (bridge gets stdin EOF). PID file cleanup on close event.

## Comparison: Agent SDK vs Interactive Runtime

| Dimension | `host` (Agent SDK) | `interactive` (Channel Plugin) |
|-----------|---------------------|-------------------------------|
| Billing | Programmatic credit (capped) | Subscription (uncapped) |
| Tools | SDK manages execution | CC manages execution natively |
| MCP servers | Passed via agent-runner config | `.mcp.json` in CWD (native CC) |
| Compaction | SDK auto-compacts | CC auto-compacts |
| Session resume | SDK continuation token | `claude --continue` |
| Multi-message | SDK push (blocks during turn) | Channel notification (queued) |
| Startup overhead | ~1s | ~2-3s (TUI init) |
| Skills/plugins | Via agent-runner formatter | Native CC (full experience) |
| Stability | SDK API contract | Channel MCP contract (research preview) |
| OneCLI credentials | Proxy injects auth | Not available (v1 limitation) |

## Cost Impact

| Runtime | Sentinel nightly (30 runs/mo) | Heavy daily agent (hundreds of turns) |
|---------|-------------------------------|---------------------------------------|
| `host` (Agent SDK) | ~$51/mo from credit bucket | ~$200+/mo from credit bucket |
| `interactive` | $0 (subscription) | $0 (subscription) |

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Anthropic closes interactive billing loophole | High | Swappable runtime — one config change back to `host`. |
| Channels exit research preview with breaking changes | Medium | Pin CC version per group. Channel contract is MCP-standard. |
| `--dangerously-load-development-channels` removed | Medium | When channels exit preview, the flag is no longer needed. If removed without general availability, the feature is blocked. |
| `node-pty` under Node on host | Low | `script` command fallback. Both are POSIX-standard. |
| CC upgrade changes rate-limit TUI | Low | PTY buffer scanning is heuristic — update string match. |
| ToS concern with automated interactive sessions | Medium | Same risk as all community PTY tools. Provider swap is one line. |
| Experimental `claude/channel` contract changes | Medium | Bridge is thin (~200 lines). Adaptation surface is small. |

## Testing Strategy

### Unit Tests (vitest, host-side)

- `interactive-runner.test.ts` — env construction, binary resolution, `.mcp.json` generation, spawn arg building
- `interactive-guard.test.ts` — PTY buffer scanning, idle detection, restart decision matrix
- `container-runner.test.ts` — `runtime: 'interactive'` dispatch path

### Unit Tests (bun:test, bridge-side)

- `bridge/server.test.ts` — inbound polling → notification emission, reply → messages_out, send_message destination routing, processing_ack writeback. Real SQLite (in-memory) with session DB schema.

### Integration Test (manual)

1. Configure test group with `runtime: 'interactive'`
2. Send message via wired channel → verify round-trip through session DBs
3. Verify rate-limit detection (write string to PTY buffer, check guard)
4. Kill CC → verify guard respawns with `--continue`
5. Verify `send_message` routes to correct destination
6. Verify `ncl groups restart --id <id>` works
7. **Verify billing category** — check Anthropic usage dashboard; confirm turns billed as interactive, not programmatic credit

### Test Count

~15-20 new tests. Existing 410 tests unaffected.

## Future Work

### v2: Container Support

Running interactive mode inside Docker requires solving:
- **Subscription auth mount**: `~/.claude/credentials.json` (or equivalent) mounted into container
- **Channel plugin discovery**: `.mcp.json` + bridge server available inside the container
- **PTY in container**: `docker run -t` allocates a PTY — technically works

### OneCLI Integration

Interactive mode currently bypasses OneCLI. To support agents with third-party API credentials:
- CC would need the OneCLI proxy configured as an HTTPS proxy
- Or: refactor credential injection into a standalone MCP tool server that interactive mode can load

### Permission Relay

The `claude/channel/permission` capability could pipe CC's tool-approval prompts through NanoClaw's existing approval system (`src/modules/approvals/`). Would enable remote approval from Discord/Slack for interactive sessions.

### NCL Access

Currently interactive mode has no ncl access (no agent-runner wrapper). Options:
- Bridge exposes ncl tools alongside reply/send_message
- Or: standalone ncl MCP server loaded via `.mcp.json`

### Agent-to-Agent

A2A routing currently depends on agent-runner MCP tools. For interactive groups to participate in a2a, the bridge needs equivalent routing tools or the a2a tools need extraction into a standalone MCP server.

## Implementation Phases

### Phase 1: Bridge Server (~250 lines)
- `bridge/server.ts` — MCP server with channel capability
- Inbound: poll `messages_in`, emit `notifications/claude/channel`
- Outbound: `reply` tool writes `messages_out`
- `processing_ack` writeback, heartbeat touch
- bun:test suite

### Phase 2: Interactive Runner (~200 lines)
- `src/interactive-runner.ts` — PTY spawn, env, `.mcp.json` generation
- `container-runner.ts` dispatch for `runtime: 'interactive'`
- `node-pty` integration (with `script` fallback)
- vitest suite

### Phase 3: Lifecycle Guard (~100 lines)
- `src/interactive-guard.ts` — sweep integration
- PTY buffer monitoring
- Rate-limit detection + Enter keystroke
- Crash detection + `--continue` respawn
- Idle timeout

### Phase 4: NanoClaw Tools (~100 lines)
- Bridge exposes `send_message`, `send_file` tools
- Destination routing from inbound.db
- Integration with existing delivery path

### Phase 5: Integration Testing
- End-to-end with real CC session
- Billing verification (usage dashboard)
- Multi-message queueing
- Crash recovery
- Rate-limit handling

## Dependencies

| Package | Where | Purpose |
|---------|-------|---------|
| `script` (POSIX) | Host (Node) | PTY allocation via `script -qfc` (Linux) / `script -q` (macOS). No native dep — avoids `node-pty` supply-chain approval gate. |
| `@modelcontextprotocol/sdk` | Bridge (Bun) | MCP server framework |
| `bun:sqlite` | Bridge (Bun) | Session DB access (no new dep) |

## References

- Channels reference: https://code.claude.com/docs/en/channels-reference
- Official plugins: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins
- Community research: `~/vault/Sources/Research/Claude Code TUI Headless Workarounds 2026.md`
- Original PTY spec (superseded): `~/vault/_Inbox/2026-05-15 NanoClaw Interactive Provider Spec.md`
- Old sweep script: `~/.local/bin/claude-code-sweep.sh` (rate-limit detection reference)
