# CC Container Headless Patterns — Research Report

**Date:** 2026-05-23
**Context:** NanoClaw runs Claude Code (CC) inside Docker using tmux, polling screen content every 2s, pattern-matching to auto-accept startup prompts (theme picker, trust dialog, dev-channels prompt, onboarding wizard). This approach is fragile: wrong timing causes CC to exit. Goal: instant, reliable startup with no interactive prompts.

---

## Q1: nicobailon/hermit — does it cache ~/.claude/ to eliminate first-run prompts?

`nicobailon/hermit` does not exist. The name conflates two unrelated repos:

- **`gtapps/claude-code-hermit`** — a Claude Code plugin (channels, cron loop, always-on personal assistant) with a `/docker-setup` wizard. It is a CC plugin that runs inside an already-running CC session, not a headless Docker startup solution. No `~/.claude/` caching logic.
- **`openclaw/hermit`** — a separate Discord bot project, unrelated to CC.

Neither repo implements prompt suppression or persistent `~/.claude/` volumes.

**Sources:** https://github.com/gtapps/claude-code-hermit

---

## Q2: Official Anthropic container (ghcr.io/anthropics/claude-code) — auth and onboarding

The official Anthropic approach uses a **named Docker volume** to persist `~/.claude/` across container runs. There is no build-time onboarding suppression baked into the image.

From `.devcontainer/devcontainer.json`:
```json
{
  "mounts": [
    "source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume"
  ],
  "remoteEnv": {
    "DEVCONTAINER": "true",
    "CLAUDE_CONFIG_DIR": "/home/node/.claude",
    "CLAUDE_CODE_OAUTH_TOKEN": "${localEnv:CLAUDE_CODE_OAUTH_TOKEN}",
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
  }
}
```

The pattern: first-run requires an interactive browser OAuth flow; the result is persisted into the named volume. Subsequent container rebuilds reuse the volume and skip auth entirely. This works for local devcontainer usage but not for automated NanoClaw-style spawning where the container must start silently every time.

**Auth token path:** `claude setup-token` generates a long-lived `sk-ant-oat…AA` OAuth token that can be injected via `CLAUDE_CODE_OAUTH_TOKEN` on every startup, bypassing the browser flow entirely.

**Important CLAUDE_CONFIG_DIR bug (GH issue #3833):** When `CLAUDE_CONFIG_DIR` is set, CC places `.claude.json` inside that directory rather than in `$HOME`. Entrypoints must write the config to the right path depending on whether this env var is set.

**Sources:**
- https://github.com/anthropics/claude-code
- https://github.com/anthropics/devcontainer-features/tree/main/src/claude-code
- https://github.com/anthropics/claude-code/issues/3833
- https://code.claude.com/docs/en/headless

---

## Q3: Community patterns for headless CC in Docker

### Pattern A: Comprehensive config pre-seeding at every startup (etokarev/claude-code-docker)

The most widely-referenced community approach. The entrypoint writes a full config blob to **three locations** before launching CC:

```bash
CONFIG='{
  "numStartups": 10,
  "installMethod": "npm",
  "autoUpdates": false,
  "hasCompletedOnboarding": true,
  "hasTrustDialogAccepted": true,
  "hasTrustDialogHooksAccepted": true,
  "hasCompletedProjectOnboarding": true,
  "hasAcknowledgedCostThreshold": true,
  "effortCalloutV2Dismissed": true,
  "theme": "dark",
  "opusProMigrationComplete": true,
  "sonnet1m45MigrationComplete": true,
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasTrustDialogHooksAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}'
echo "$CONFIG" > /home/claude/.claude.json
echo "$CONFIG" > /home/claude/.claude/.config.json
echo "$CONFIG" > /home/claude/.claude/claude.json
```

Key notes:
- All three locations are written — CC appears to check multiple paths depending on version
- Per-project trust (`projects["/workspace"]`) must match the container's mount path exactly (NanoClaw uses `/workspaces/project`)
- These keys are internal (found by reading minified CLI source), not in official docs, and may change with CC version updates
- `hasTrustDialogHooksAccepted` **cannot be set via `claude config set`** — must be written directly (GH issue #5572, closed "not planned")
- No tmux in this setup; runs `exec claude --dangerously-skip-permissions --effort medium` directly

**Sources:**
- https://github.com/etokarev/claude-code-docker
- https://github.com/anthropics/claude-code/issues/5572

### Pattern B: Seed-then-patch via headless invocation (trailofbits/claude-code-devcontainer)

The most sophisticated approach. Instead of hand-crafting the full config blob, runs CC headlessly to produce an authoritative seed:

```python
def setup_onboarding_bypass():
    # Seed ~/.claude.json with a real CC run
    subprocess.run(["claude", "-p", "ok"], timeout=30, ...)
    # Then patch the onboarding flag
    with open(claude_json_path) as f:
        config = json.load(f)
    config["hasCompletedOnboarding"] = True
    with open(claude_json_path, "w") as f:
        json.dump(config, f)

def setup_claude_settings():
    settings = {"permissions": {"defaultMode": "bypassPermissions"}}
    with open(settings_path, "w") as f:
        json.dump(settings, f)
```

This avoids `--dangerously-skip-permissions` at the CLI level — instead, `bypassPermissions` is set in `settings.json` so it's always on without passing the flag.

Also uses a named Docker volume for `~/.claude/` persistence across container rebuilds.

**Sources:** https://github.com/trailofbits/claude-code-devcontainer

### Pattern C: Web-based OAuth UI, no prompt suppression (jiangmuran/claude-in-box)

Avoids prompt suppression entirely. Uses a web UI and SOCKS5 proxy for the OAuth flow — user authenticates once via browser, result persisted in volume. Designed for always-on scenarios (e.g., Raspberry Pi) where the setup cost is paid once. Not applicable to automated NanoClaw-style spawning.

**Sources:** https://github.com/jiangmuran/claude-in-box

---

## Q4: NanoClaw's register-claude-token.sh — could script(1) replace tmux screen-watching?

These solve **different problems**:

- **`register-claude-token.sh`** uses `script(1)` to capture PTY output of the host-side `claude setup-token` command, extracts the `sk-ant-oat…AA` token, and registers it with the OneCLI vault. This is a **one-shot host-side operation** for obtaining the OAuth token. The script problem and PTY capture are the right tools for this use case.

- **CC container startup prompt suppression** is a separate problem: the container needs to start CC without any interactive prompts at all. The answer is config pre-seeding (Pattern A/B above), not PTY capture.

`script(1)` is not a better solution for the container startup problem. The screen-watching loop is the wrong abstraction entirely — it should be eliminated by eliminating the prompts before CC starts.

---

## Q5: CLI flags and env vars for suppressing CC prompts

### Confirmed env vars (v2.1.104 reference, gist mculp/e6a573f2a45ef7dbbf30f6a8574c7351)

- **`CLAUDE_CODE_OAUTH_TOKEN`** — injects OAuth refresh token, bypasses browser auth flow
- **`ANTHROPIC_API_KEY`** — API key auth (uses pay-per-token billing, not subscription)
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`** — bundles four disable flags:
  - `DISABLE_AUTOUPDATER=1`
  - `DISABLE_BUG_COMMAND=1`
  - `DISABLE_ERROR_REPORTING=1`
  - `DISABLE_TELEMETRY=1`
- **`CLAUDE_CONFIG_DIR`** — relocates the CC config directory (but see bug #3833 above)

**Confirmed absent:** There is no `CLAUDE_CODE_SKIP_ONBOARDING`, `--no-interactive`, or any other flag that suppresses startup prompts. Prompt suppression is achieved exclusively through pre-seeded config files.

### settings.json keys for headless operation (gist mculp/c082bd1e5a439410158974de90c89db7)

- **`skipDangerousModePermissionPrompt: true`** — suppresses the danger-mode confirmation dialog (equivalent to the auto-accept the current screen-watcher does for "I accept"/"Bypass Permissions")
- **`permissions.defaultMode: "bypassPermissions"`** — equivalent to `--dangerously-skip-permissions` CLI flag
- **`skipAutoPermissionPrompt: true`** — suppresses auto-mode opt-in prompt

NanoClaw already writes `skipDangerousModePermissionPrompt: true` and `trustedFolders` in `settings.json`. The `trustedFolders` key suppresses the folder trust prompt at the settings level, but `hasTrustDialogAccepted`/`hasTrustDialogHooksAccepted` in `.claude.json` appear to be the definitive trust record CC checks. Both may be needed.

### The dev-channels prompt: irreducible

The prompt triggered by `--dangerously-load-development-channels server:bridge` appears when CC starts with that flag and the bridge server isn't yet connected. No config key suppresses this prompt. Searching for `trustedDevelopmentChannels`, `devChannelsAccepted`, `loadedDevelopmentChannels`, and similar patterns in all referenced community configs produced no results — **no such key exists in the public ecosystem**.

Options:
1. Keep the current tmux screen-watch for this one prompt only (but fix the config pre-seeding so it's the only remaining prompt)
2. File an upstream feature request for a `trustedDevelopmentChannels` settings.json key
3. Change the MCP bridge startup ordering so the MCP server is ready before CC starts (eliminating the "not yet connected" condition that triggers the prompt)

---

## NanoClaw Delta: What to Fix

The current `container/cc-entrypoint.sh` writes an incomplete config with several missing keys, writes to only one location, and includes a fragile 30-iteration screen-polling loop that should mostly become unnecessary.

### 1. Missing ~/.claude.json keys

Current NanoClaw config (as of LOCAL-015):
```json
{
  "hasCompletedOnboarding": true,
  "numStartups": 3,
  "installMethod": "native",
  "lastOnboardingVersion": "2.1.128",
  "lastReleaseNotesSeen": "2.1.128",
  "migrationVersion": 13,
  "opusProMigrationComplete": true,
  "sonnet1m45MigrationComplete": true,
  "officialMarketplaceAutoInstallAttempted": true,
  "officialMarketplaceAutoInstalled": true,
  "projects": {
    "/workspaces/project": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  },
  "cachedGrowthBookFeatures": { ... }
}
```

Missing keys that suppress additional prompts:

| Key | Suppresses |
|-----|-----------|
| `hasTrustDialogAccepted: true` | (top-level, not just per-project) |
| `hasTrustDialogHooksAccepted: true` | Hooks trust dialog |
| `hasAcknowledgedCostThreshold: true` | Cost threshold warning |
| `effortCalloutV2Dismissed: true` | Effort picker callout |
| `theme: "dark"` | Theme picker on first run |
| `projects["/workspaces/project"].hasTrustDialogHooksAccepted: true` | Per-project hooks trust |

Note: NanoClaw already has `hasTrustDialogAccepted` and `hasCompletedProjectOnboarding` in the per-project block — the top-level `hasTrustDialogAccepted` and `hasTrustDialogHooksAccepted` are missing.

### 2. Missing write locations

Community standard: write the same config to three locations. NanoClaw writes only to `~/.claude.json`. Should also write to:
- `~/.claude/.config.json`
- `~/.claude/claude.json`

### 3. CLAUDE_CONFIG_DIR interaction

If NanoClaw ever sets `CLAUDE_CONFIG_DIR`, the `~/.claude.json` write location changes to that directory (bug #3833). Current NanoClaw does not set `CLAUDE_CONFIG_DIR`, so this is not currently a problem — but worth documenting for future.

### 4. The screen-watching loop

With the above config keys in place, the remaining prompts that the loop handles should reduce to just the dev-channels prompt (and possibly nothing — needs verification). The loop can be kept as a last-resort fallback but should no longer be the primary mechanism.

### 5. Verify trustedFolders vs hasTrustDialogAccepted

NanoClaw uses `trustedFolders` in `settings.json` and `hasTrustDialogAccepted` in the per-project config block. It's unconfirmed whether these are additive or redundant. Community practice (etokarev) uses both `hasTrustDialogAccepted` as a top-level key in `.claude.json` and `trustedFolders` in `settings.json`. Using both is the safe approach.

---

## Recommended Changes to cc-entrypoint.sh

```bash
# Add missing keys to .claude.json — write to all three locations
CONFIG_JSON=$(cat <<'CLAUDEJSON'
{
  "hasCompletedOnboarding": true,
  "hasTrustDialogAccepted": true,
  "hasTrustDialogHooksAccepted": true,
  "hasAcknowledgedCostThreshold": true,
  "effortCalloutV2Dismissed": true,
  "theme": "dark",
  "numStartups": 10,
  "installMethod": "native",
  "lastOnboardingVersion": "2.1.128",
  "lastReleaseNotesSeen": "2.1.128",
  "migrationVersion": 13,
  "opusProMigrationComplete": true,
  "sonnet1m45MigrationComplete": true,
  "officialMarketplaceAutoInstallAttempted": true,
  "officialMarketplaceAutoInstalled": true,
  "projects": {
    "/workspaces/project": {
      "hasTrustDialogAccepted": true,
      "hasTrustDialogHooksAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  },
  "cachedGrowthBookFeatures": { ... }
}
CLAUDEJSON
)
echo "$CONFIG_JSON" > "${HOME}/.claude.json"
mkdir -p "${HOME}/.claude"
echo "$CONFIG_JSON" > "${HOME}/.claude/.config.json"
echo "$CONFIG_JSON" > "${HOME}/.claude/claude.json"
```

The screen-watching fallback loop should be retained but can be reduced to ~5 iterations (10s) rather than 30 (60s), since the config pre-seeding should handle everything except the dev-channels prompt.

---

## Source Index

| ID | URL | What It Covers |
|----|-----|---------------|
| S-1 | https://dev.to/coderluii/how-i-run-claude-code-in-docker-with-a-web-ui-and-headless-browser-5dko | HolyClaude: CC + web UI + headless browser in Docker |
| S-2 | https://github.com/CoderLuii/HolyClaude | HolyClaude repo |
| S-3 | https://code.claude.com/docs/en/devcontainer | Official Anthropic devcontainer docs |
| S-4 | https://github.com/anthropics/devcontainer-features/tree/main/src/claude-code | Official devcontainer feature (install.sh) |
| S-5 | https://github.com/jiangmuran/claude-in-box | Web-based OAuth UI pattern |
| S-6 | https://github.com/gtapps/claude-code-hermit | claude-code-hermit plugin (not headless startup) |
| S-7 | https://github.com/etokarev/claude-code-docker | Community reference: 3-location config pre-seeding |
| S-8 | https://github.com/anthropics/claude-code/issues/5572 | hasTrustDialogHooksAccepted cannot be set via config CLI |
| S-9 | https://gist.github.com/mculp/e6a573f2a45ef7dbbf30f6a8574c7351 | Complete CC env var reference (v2.1.104) |
| S-10 | https://github.com/anthropics/claude-code | Official Anthropic repo + devcontainer.json |
| S-11 | https://github.com/anthropics/devcontainer-features/tree/main/src/claude-code | Official devcontainer feature detail |
| S-12 | https://github.com/trailofbits/claude-code-devcontainer | Seed-then-patch approach, settings.json bypassPermissions |
| S-13 | https://github.com/anthropics/claude-code/issues/3833 | CLAUDE_CONFIG_DIR bug: .claude.json location changes |
| S-14 | https://gist.github.com/jedisct1/9627644cda1c3929affe9b1ce8eaf714 | Community env var reference |
| S-15 | https://gist.github.com/mculp/c082bd1e5a439410158974de90c89db7 | Complete settings.json reference (v2.1.105) |
| S-16 | https://code.claude.com/docs/en/headless | Official headless mode docs (-p flag, stream-json) |
