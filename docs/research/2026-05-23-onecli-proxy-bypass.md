# OneCLI HTTPS Proxy and Claude Code OAuth: Bypass Research

**Date:** 2026-05-23
**Context:** nanoclaw cc-container path uses `CLAUDE_CODE_OAUTH_TOKEN` for CC auth. OneCLI's HTTPS proxy MITMs all traffic from authenticated agents. The question is how to use OneCLI for non-Anthropic credentials (Gmail, Calendar) while keeping CC's OAuth path intact.

---

## Summary of Findings

The answer to all five research questions is grounded in primary source (OneCLI server source code + Rust gateway source + CC GitHub issues). The short version:

1. **OneCLI has no server-side per-host bypass.** The gateway MITMs all CONNECT requests from authenticated agents unconditionally, regardless of whether credentials exist for that host. `NO_PROXY` (client-side) is the only reliable mechanism.
2. **`ANTHROPIC_AUTH_TOKEN` is a valid CC env var** (verified from CC CHANGELOG) — it's an Anthropic SDK env var that takes precedence over `ANTHROPIC_API_KEY`. At the proxy level it behaves identically to `ANTHROPIC_API_KEY`: raw bearer injection, no OAuth exchange, no GET-vs-CONNECT pitfall. OneCLI's container-config endpoint injects whichever `placeholder` value matches the registered secret's `authMode` (`CLAUDE_CODE_OAUTH_TOKEN` for OAuth, `ANTHROPIC_API_KEY` for API key). The proxy then intercepts `api.anthropic.com` and swaps the placeholder with the real credential.
3. **OneCLI is designed to handle CC OAuth via proxy injection.** This is the intended path when Anthropic credentials are registered in OneCLI. For nanoclaw's cc-container, which uses a direct OAuth token from `.env` and skips OneCLI entirely, there is no proxy conflict today — and there would be one if OneCLI were added without `NO_PROXY`.
4. **No new OneCLI version has resolved this.** The limitation (force-MITM for authenticated agents) is by design, documented in the gateway source as enabling actionable error guidance.
5. **The current `NO_PROXY` format in cc-container-runner.ts is correct and should work** in CC 2.1.117+ (where NO_PROXY was fixed). However, there is an open regression (CC issue #50252) affecting CC 2.1.113+ on linux-x64 using the Bun native runtime that can cause CONNECT proxy hangs. CC 2.1.128 (current pinned version) is affected.

---

## Question 1: Can OneCLI's proxy be configured to bypass specific hosts server-side?

**No.** The gateway source (`apps/gateway/src/gateway.rs`, lines 574–576) forces MITM for all authenticated agents:

```rust
// Force MITM for all authenticated agent requests so the gateway can
// intercept auth errors (401/403/400) and provide actionable guidance
// (credential_not_found, app_not_connected, access_restricted).
if !intercept && agent_token.is_some() {
    intercept = true;
}
```

The `intercept` flag is initially set from `connect.rs` as `has_rules || access_restricted` (true only when credentials or policy rules match the target host). After that, this block overrides it to `true` for any request from an authenticated agent, including `api.anthropic.com` when no Anthropic credentials are registered.

**There is no `--bypass` flag, no `NO_PROXY` config on the server side, no per-host exclusion list in the gateway.** The proxy's outbound leg does have a `GATEWAY_SKIP_VERIFY_HOSTS` env var that skips TLS certificate validation for matched hosts (not proxy bypass), and open issue #182 requests outbound `NO_PROXY` support (forward proxy chaining for enterprise environments) — but neither addresses the inbound intercept decision.

**Client-side `NO_PROXY` is the only bypass mechanism.** When `api.anthropic.com` is in `NO_PROXY`, CC's HTTP client skips the proxy and connects directly, avoiding the MITM entirely.

---

## Question 2: Does `ANTHROPIC_AUTH_TOKEN` behave differently from `CLAUDE_CODE_OAUTH_TOKEN`?

CC recognizes three Anthropic auth environment variables:

- `CLAUDE_CODE_OAUTH_TOKEN` — long-lived OAuth token (from `claude setup-token`); CC uses it to acquire short-lived API bearer tokens via an OAuth token exchange against `api.anthropic.com/api/oauth/...`
- `ANTHROPIC_API_KEY` — API key; used directly as a bearer token
- `ANTHROPIC_AUTH_TOKEN` — Anthropic SDK env var; functionally equivalent to `ANTHROPIC_API_KEY` at the transport level (raw bearer token, no OAuth exchange). Verified present in CC CHANGELOG — it is recognized and takes precedence over `ANTHROPIC_API_KEY` when both are set.

`ANTHROPIC_AUTH_TOKEN` behaves like API key mode through the proxy: the proxy injects it as a raw bearer on each intercepted request. No token exchange occurs, which means the GET-vs-CONNECT pitfall documented in CC issue #33642 (OAuth token refresh endpoint using plain HTTP GET in older CC versions) does not apply to it. For proxy purposes, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are interchangeable.

OneCLI's container-config server (`packages/api/src/routes/container-config.ts`) injects `placeholder` for whichever mode the registered Anthropic secret uses:

```typescript
const authEnv: Record<string, string> =
  meta?.authMode === "oauth"
    ? { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" }
    : { ANTHROPIC_API_KEY: "placeholder" };
```

The live instance's response (fetched 2026-05-23) confirms `CLAUDE_CODE_OAUTH_TOKEN: "placeholder"` is returned. OneCLI's gateway then intercepts `api.anthropic.com` CONNECT requests, sees the placeholder token, looks up the real credential from its vault, and injects it. This is OneCLI's intended CC OAuth path.

For CC's OAuth mode, the proxy intercept path has an additional known failure mode: the OAuth token refresh endpoint (`/api/oauth/profile`) uses a plain HTTP GET in older CC versions rather than a CONNECT tunnel. This was documented in CC issue #33642 (closed, classified as stale; not confirmed fixed). In newer CC versions (2.1.74+ as analyzed in #33642), the global axios instance is configured with a proxy interceptor that should handle both inference and OAuth calls through CONNECT — but has had recurring regressions.

For `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` mode, the proxy simply injects the key as an `Authorization` header on each intercepted request. No token exchange, no GET-vs-CONNECT distinction. This is why the agent-runner path works reliably: it uses API key auth, which the proxy handles straightforwardly.

**The proxy behaves identically at the transport level for both auth modes — MITM via CONNECT.** The semantic difference is which env var name the placeholder occupies and how CC uses it downstream. `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` are simpler proxy targets than `CLAUDE_CODE_OAUTH_TOKEN` because they involve no token exchange.

---

## Question 3: Can OneCLI proxy only specific hosts (Gmail, Calendar) while leaving Anthropic untouched?

**Yes — via client-side `NO_PROXY`, not server-side config.** The proxy intercepts all CONNECT from authenticated agents, but the client can bypass the proxy entirely for specific hosts.

With `NO_PROXY=api.anthropic.com`, CC connects directly to `api.anthropic.com:443` without going through the OneCLI proxy. CC still uses the proxy for Gmail, Calendar, and any other host not in `NO_PROXY`. This requires:

1. The container has `HTTPS_PROXY` and `HTTP_PROXY` set (from `applyContainerConfig`)
2. The container has `NO_PROXY=...,api.anthropic.com` set
3. CC's HTTP client respects `NO_PROXY` (version-dependent, see Question 5)
4. The real `CLAUDE_CODE_OAUTH_TOKEN` is in the env (not `placeholder`), since OneCLI won't intercept and swap it

This is the design choice the current cc-container path is already positioned for: it sets `NO_PROXY=...,api.anthropic.com` in `buildCcContainerEnv`. What it doesn't yet do is call `applyContainerConfig` to get the `HTTPS_PROXY` for non-Anthropic hosts.

---

## Question 4: Have newer OneCLI versions fixed the proxy/OAuth conflict?

**No fix is needed on OneCLI's side — the behavior is by design.** The force-MITM-for-authenticated-agents rule exists to provide actionable error messages when credentials are missing. There is no open issue requesting a per-host bypass for authenticated agents, and no changelog entry changing this behavior.

The only relevant OneCLI change would be if OneCLI added a server-side per-host passthrough config. Open issue #182 requests outbound NO_PROXY for the gateway itself (corporate forward proxy chaining), not inbound bypass for agents. There is no issue requesting per-host passthrough for authenticated agents.

The current OneCLI version is 1.4.1 (CLI) / SDK 0.5.0 (installed in nanoclaw) / SDK 2.0.0 (latest on npm). The SDK v2.0.0 published 4 days before this research has no `applyContainerConfig` behavior changes that affect bypass.

---

## Question 5: Will `NO_PROXY=...,api.anthropic.com` actually work?

**It should — with caveats.**

### The NO_PROXY fix history in Claude Code

CC issue #39862 ("NO_PROXY completely ignored — Claude Code v2.1.83") was confirmed fixed as of CC **v2.1.117**. The container pins CC at `2.1.128`, which is after the fix.

The format CC documents: comma-separated or space-separated hostnames. Both formats are mentioned in CC docs. Using commas is the safest format for maximum tool compatibility (`NO_PROXY=host.docker.internal,localhost,127.0.0.1,api.anthropic.com`). Setting both `NO_PROXY` and `no_proxy` (as cc-container-runner.ts already does) covers tools that only check one case.

`NODE_USE_ENV_PROXY=1` (injected by OneCLI's container-config) is required for Node.js 18+'s built-in `fetch` (undici) to respect `HTTP_PROXY`/`HTTPS_PROXY`. This matters for **Node-based subprocesses** in the container — MCP servers, bash-launched tools, and similar. It does **not** apply to CC's own HTTP calls: CC 2.1.113+ uses a Bun native binary (not Node/undici), so `NODE_USE_ENV_PROXY=1` is irrelevant to CC itself. The cc-container path does not set this env var since it doesn't call `applyContainerConfig`. If it did, `NODE_USE_ENV_PROXY=1` would be needed for any Node-based MCP servers that make proxy-mediated HTTP calls.

### Live Bun native proxy regression (CC issue #50252)

**This is the highest-risk caveat.** CC switched from bundled JS to a Bun native binary at v2.1.113. The issue reports intermittent CONNECT proxy hangs in the Bun native runtime on linux-x64 (confirmed race condition under strace). CC 2.1.128 (pinned in nanoclaw) is affected — issue #50252 remains **open** as of 2026-05-23.

Key details:
- Affects linux-x64 only (arm64 is unaffected)
- `curl` and Python urllib through the same proxy work correctly at <400ms
- Bun native fetch hangs ~75% of the time, timing out at 30–45s
- Workaround from issue: downgrade to CC 2.1.112 (last bundled-JS build)
- Does not affect the agent-runner container, which uses its own Bun installation for non-CC code

**This issue is distinct from NO_PROXY behavior.** The bug causes CONNECT proxy hangs even when the proxy is working correctly — it's a Bun fetch socket race. It would affect any CC that goes through an HTTPS proxy, including if OneCLI were enabled for the cc-container path.

---

## Current State of cc-container Path

The cc-container path (`container-runner.ts` lines 222-298) currently:

- Does **not** call `onecli.ensureAgent()` or `applyContainerConfig()`
- Does **not** set `HTTPS_PROXY` or `HTTP_PROXY`
- **Does** set `NO_PROXY=host.docker.internal,localhost,127.0.0.1,api.anthropic.com` and `no_proxy` (same)
- **Does** set `CLAUDE_CODE_OAUTH_TOKEN` from the host env (`CC_CONTAINER_OAUTH_TOKEN` from `.env`)

The `NO_PROXY` setting in cc-container is currently a no-op because there is no proxy set. It is pre-positioned for when/if OneCLI is added to the cc-container path.

The agent-runner path (`buildContainerArgs`) sets `NO_PROXY=host.docker.internal,localhost,127.0.0.1` (without `api.anthropic.com`) before calling `applyContainerConfig`. It doesn't need `api.anthropic.com` in NO_PROXY because agent-runner authenticates via API key — the proxy intercepts `api.anthropic.com`, sees the placeholder API key, and injects the real one from the vault. This works reliably.

---

## Recommended Path: Adding OneCLI to cc-container

If nanoclaw needs to add Gmail/Calendar/other OneCLI-managed credentials to the cc-container path, the correct approach is:

1. Call `onecli.ensureAgent()` and `applyContainerConfig()` in the cc-container spawn path (as in `buildContainerArgs` for agent-runner)
2. Ensure `NO_PROXY` includes `api.anthropic.com` (already done in `buildCcContainerEnv`) — set this **after** `applyContainerConfig` for Docker last-wins semantics. In practice, `applyContainerConfig` does not emit any `NO_PROXY` entry (verified in SDK source), so ordering has no practical effect today — but "after" is the correct posture for Docker `-e` semantics if that ever changes
3. Keep `CLAUDE_CODE_OAUTH_TOKEN` injected directly from host env (not as `placeholder`) — OneCLI will not see this env var's value since `api.anthropic.com` is bypassed
4. Do **not** register an Anthropic secret in OneCLI for the cc-container agent — this would cause OneCLI to inject `CLAUDE_CODE_OAUTH_TOKEN: "placeholder"`, which would fail (no proxy interception for that host)
5. Consider the Bun proxy regression (CC #50252) before enabling: if the container is on linux-x64 (which it is), CONNECT proxy hangs are possible at CC 2.1.128

**Alternative path (avoids the Bun proxy issue):** Use OneCLI only for credentials that don't go through CC's own HTTP client. Custom MCP servers in the container (the proxy-native pattern) make raw HTTP calls to Gmail/Calendar APIs through the proxy — those are Node/Bun calls from MCP server processes, not CC itself. CC's own OAuth call to `api.anthropic.com` bypasses the proxy via `NO_PROXY`. This is cleaner and already how the agent-runner uses OneCLI.

---

## Issue Landscape

| Issue | Repo | State | Relevance |
|-------|------|-------|-----------|
| #182: NO_PROXY for outbound gateway leg | onecli/onecli | Open | Not relevant to client-side bypass |
| #307: oauth2.googleapis.com misrouted to vertex-ai | onecli/onecli | Open | Affects Google OAuth refresh via proxy; relevant if Google MCP servers go through proxy |
| #39862: NO_PROXY ignored in CC | anthropics/claude-code | Closed, fixed in 2.1.117 | Fixed, CC 2.1.128 includes fix |
| #33642: OAuth GET vs CONNECT tunnel | anthropics/claude-code | Closed (stale) | Not confirmed fixed; mitigated by NO_PROXY bypass for `api.anthropic.com` |
| #50252: Bun fetch race condition through CONNECT proxy | anthropics/claude-code | **Open** | Active regression for CC 2.1.113+ linux-x64; affects cc-container if OneCLI is added |

---

## Sources

- **OneCLI SDK source (v0.5.0):** `/home/mzazon/repos/nanoclaw/node_modules/.pnpm/@onecli-sh+sdk@0.5.0/node_modules/@onecli-sh/sdk/lib/index.js` — `applyContainerConfig` implementation
- **OneCLI container-config API (live):** `http://172.17.0.1:10254/api/container-config` — confirmed response: HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS, NODE_USE_ENV_PROXY=1, `CLAUDE_CODE_OAUTH_TOKEN: "placeholder"` (2026-05-23)
- **OneCLI gateway.rs:** https://github.com/onecli/onecli/blob/main/apps/gateway/src/gateway.rs — force-MITM rule for authenticated agents (lines 574–576)
- **OneCLI connect.rs:** https://github.com/onecli/onecli/blob/main/apps/gateway/src/connect.rs — `intercept: has_rules || access_restricted` baseline
- **OneCLI container-config.ts:** https://github.com/onecli/onecli/blob/main/packages/api/src/routes/container-config.ts — `CLAUDE_CODE_OAUTH_TOKEN: "placeholder"` for OAuth mode; `ANTHROPIC_API_KEY: "placeholder"` for API key mode
- **CC issue #39862:** https://github.com/anthropics/claude-code/issues/39862 — NO_PROXY ignored, fixed in 2.1.117
- **CC issue #33642:** https://github.com/anthropics/claude-code/issues/33642 — OAuth GET vs CONNECT tunnel regression (closed stale)
- **CC issue #50252:** https://github.com/anthropics/claude-code/issues/50252 — Bun fetch race condition on linux-x64 CONNECT proxy (open, 2.1.113+)
- **OneCLI issue #182:** https://github.com/onecli/onecli/issues/182 — outbound NO_PROXY support (open, unimplemented)
- **OneCLI issue #307:** https://github.com/onecli/onecli/issues/307 — oauth2.googleapis.com misrouted to vertex-ai (open, filed 2026-05-23)
