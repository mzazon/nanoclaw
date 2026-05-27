/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
  NANOCLAW_OTEL_CONTAINER_ENDPOINT,
  NANOCLAW_OTEL_DISABLE,
  NANOCLAW_DEBUG,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { syncSkillSymlinks } from './skill-symlinks.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { spawnHostProcess, cleanupHostOrphans } from './host-runner.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { getTracer } from './tracing.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  openOutboundDbRw,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';
import type { RespawnFlags } from './interactive-runner.js';

export { cleanupHostOrphans };

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

interface ActiveEntry {
  process: ChildProcess;
  containerName: string;
  isHostProcess: boolean;
  pidFile?: string;
  ptyBuffer?: { data: string };
  spawnedAt?: number;
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, ActiveEntry>();

/** Pending respawn flags set by killContainer, consumed by spawnContainer on next wake. */
const pendingRespawnFlags = new Map<string, RespawnFlags>();

/** Snapshot of active container entries for the dashboard pusher. */
export function getActiveContainerEntries(): Array<{ sessionId: string; containerName: string }> {
  return Array.from(activeContainers.entries()).map(([sessionId, entry]) => ({
    sessionId,
    containerName: entry.containerName,
  }));
}

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

export function getContainerName(sessionId: string): string | null {
  const entry = activeContainers.get(sessionId);
  return entry?.containerName ?? null;
}

export function getInteractiveEntry(
  sessionId: string,
): { ptyBuffer: { data: string }; process: ChildProcess; spawnedAt?: number } | null {
  const entry = activeContainers.get(sessionId);
  if (!entry?.ptyBuffer) return null;
  return { ptyBuffer: entry.ptyBuffer, process: entry.process, spawnedAt: entry.spawnedAt };
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const tracer = getTracer('container');
  return tracer.startActiveSpan(
    'nanoclaw.container_spawn',
    {
      attributes: { 'session.id': session.id, 'agent.group': session.agent_group_id },
    },
    async (spawnSpan) => {
      try {
        await spawnContainerInner(session, spawnSpan);
      } catch (err) {
        spawnSpan.recordException(err as Error);
        spawnSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        spawnSpan.end();
      }
    },
  );
}

async function spawnContainerInner(session: Session, spawnSpan: import('@opentelemetry/api').Span): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // LOCAL-013: fresh_context='always' — clear continuation before cold wake so the
  // agent starts a blank conversation. Must run before spawn — the sweep
  // path covers timer-woken sessions but direct wakes (a2a, router) bypass it.
  const configRow = getContainerConfig(session.agent_group_id);
  if (configRow?.fresh_context === 'always') {
    try {
      const outDb = openOutboundDbRw(session.agent_group_id, session.id);
      try {
        const result = outDb.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'").run();
        if (result.changes > 0) {
          log.info('Cleared continuation for fresh start', { sessionId: session.id, reason: 'fresh-context-always' });
        }
      } finally {
        outDb.close();
      }
    } catch {
      // outbound.db may not exist yet on first spawn
    }
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);
  spawnSpan.setAttribute('container.runtime', containerConfig.runtime ?? 'docker');

  // LOCAL-010: dispatch to host-agent spawn
  if (containerConfig.runtime === 'host') {
    const result = await spawnHostProcess(session, agentGroup, containerConfig);
    activeContainers.set(session.id, {
      process: result.child,
      containerName: result.name,
      isHostProcess: true,
      pidFile: result.pidFile,
    });
    markContainerRunning(session.id);
    attachProcessLifecycle(result.child, session.id, agentGroup.folder, result.pidFile);
    return;
  }

  // Interactive runtime: CC in TUI mode with channel plugin bridge
  if (containerConfig.runtime === 'interactive') {
    const { spawnInteractiveSession } = await import('./interactive-runner.js');
    const flags = pendingRespawnFlags.get(session.id);
    const result = await spawnInteractiveSession(session, agentGroup, containerConfig, flags);
    pendingRespawnFlags.delete(session.id); // only clear on success
    activeContainers.set(session.id, {
      process: result.child,
      containerName: result.name,
      isHostProcess: true,
      pidFile: result.pidFile,
      ptyBuffer: result.ptyBuffer,
      spawnedAt: Date.now(),
    });
    markContainerRunning(session.id);
    attachProcessLifecycle(result.child, session.id, agentGroup.folder, result.pidFile);
    return;
  }

  // CC-container runtime: CC in TUI mode inside Docker with tmux + bridge
  if (containerConfig.runtime === 'cc-container') {
    const { buildCcContainerMcpJson, buildCcContainerMounts, buildCcContainerEnv, startCcPtyPolling } =
      await import('./cc-container-runner.js');

    const { contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

    const sessDir = sessionDir(agentGroup.id, session.id);
    const mcpJsonPath = path.join(sessDir, '.mcp.json');
    const additionalMcpServers = containerConfig.mcpServers ?? {};
    fs.writeFileSync(mcpJsonPath, buildCcContainerMcpJson('/app/bridge/server.ts', additionalMcpServers));

    const mounts = buildCcContainerMounts(agentGroup, session, containerConfig, contribution);
    const containerName = `cc-${agentGroup.folder}-${Date.now()}`;
    const agentIdentifier = agentGroup.id;

    const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

    const envPairs = buildCcContainerEnv(agentGroup, containerConfig, contribution, session.id);
    for (const pair of envPairs) {
      args.push(...pair);
    }

    const flags = pendingRespawnFlags.get(session.id);
    pendingRespawnFlags.delete(session.id);
    if (flags?.noContinue) {
      args.push('-e', 'NANOCLAW_NO_CONTINUE=1');
    }

    // OneCLI gateway — injects HTTPS_PROXY + CA cert + CLAUDE_CODE_OAUTH_TOKEN.
    // The proxy intercepts api.anthropic.com traffic and injects the sk-ant-* key
    // from the vault. CLAUDE_CODE_OAUTH_TOKEN=placeholder suppresses CC's login
    // prompt; the proxy replaces the Authorization header on the wire. LOCAL-015
    if (ONECLI_URL && ONECLI_API_KEY) {
      const onecliTracer = getTracer('container');
      await onecliTracer.startActiveSpan(
        'nanoclaw.onecli_ensure',
        {
          attributes: { 'agent.name': agentGroup.name ?? '', 'agent.identifier': agentIdentifier },
        },
        async (onecliSpan) => {
          try {
            await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
          } catch (err) {
            onecliSpan.recordException(err as Error);
            log.warn('OneCLI ensureAgent failed (non-fatal)', { err });
          } finally {
            onecliSpan.end();
          }
        },
      );
      const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
      if (onecliApplied) {
        log.info('OneCLI gateway applied to cc-container', { containerName });
      } else {
        log.warn("OneCLI gateway not applied to cc-container — MCP servers won't have credentials", { containerName });
      }
    }

    args.push(...hostGatewayArgs());

    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
      args.push('-e', 'HOME=/home/node');
    }

    // Named config volume — persists auth, plugins, CC state across rebuilds.
    args.push('-v', `nanoclaw-cc-config-${agentGroup.id}:/home/node/.claude`);

    for (const mount of mounts) {
      if (mount.readonly) {
        args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }

    args.push('--entrypoint', '/usr/bin/tini');
    const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
    args.push(imageTag);
    args.push('--', '/app/cc-entrypoint.sh');

    log.info('Spawning cc-container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });
    fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

    const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const ptyBuffer = { data: '' };
    const ptyPollInterval = startCcPtyPolling(sessDir, ptyBuffer);
    container.on('exit', () => clearInterval(ptyPollInterval));

    activeContainers.set(session.id, {
      process: container,
      containerName,
      isHostProcess: false,
      ptyBuffer,
      spawnedAt: Date.now(),
    });
    markContainerRunning(session.id);
    attachProcessLifecycle(container, session.id, agentGroup.folder);
    return;
  }

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    session.id,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, isHostProcess: false });
  markContainerRunning(session.id);
  attachProcessLifecycle(container, session.id, agentGroup.folder);
}

/**
 * Shared lifecycle setup for both Docker and host-agent processes.
 * Wires stderr logging, stdout drain, close/error cleanup.
 */
function attachProcessLifecycle(child: ChildProcess, sessionId: string, groupFolder: string, pidFile?: string): void {
  child.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: groupFolder });
    }
  });
  child.stdout?.resume();

  child.on('close', (code) => {
    const entry = activeContainers.get(sessionId);
    activeContainers.delete(sessionId);
    markContainerStopped(sessionId);
    stopTypingRefresh(sessionId);
    if (pidFile) fs.rmSync(pidFile, { force: true });
    log.info('Process exited', { sessionId, code, containerName: entry?.containerName, isHost: entry?.isHostProcess });
  });

  child.on('error', (err) => {
    const entry = activeContainers.get(sessionId);
    activeContainers.delete(sessionId);
    markContainerStopped(sessionId);
    stopTypingRefresh(sessionId);
    if (pidFile) fs.rmSync(pidFile, { force: true });
    log.error('Process spawn error', {
      sessionId,
      err,
      containerName: entry?.containerName,
      isHost: entry?.isHostProcess,
    });
  });
}

/** Kill a container for a session. */
export function killContainer(
  sessionId: string,
  reason: string,
  respawnFlags?: RespawnFlags,
  onExit?: () => void,
): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  const tracer = getTracer('container');
  tracer.startActiveSpan(
    'nanoclaw.container_kill',
    {
      attributes: { 'session.id': sessionId, 'kill.reason': reason, 'container.name': entry.containerName ?? '' },
    },
    (killSpan) => {
      try {
        if (respawnFlags) {
          pendingRespawnFlags.set(sessionId, respawnFlags);
          killSpan.setAttribute('respawn.requested', true);
        }

        if (onExit) {
          entry.process.once('close', onExit);
        }

        log.info('Killing container', { sessionId, reason, containerName: entry.containerName, respawnFlags });
        if (entry.isHostProcess) {
          entry.process.kill('SIGTERM');
          return;
        }
        try {
          stopContainer(entry.containerName);
        } catch {
          entry.process.kill('SIGKILL');
        }
      } finally {
        killSpan.end();
      }
    },
  );
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  // Also called by spawnHostProcess in host-runner.ts — both paths need this.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(path.join(claudeDir, 'skills'), containerConfig, (s) => `/app/skills/${s}`);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared MCP servers — read-only, used by both agent-runner and cc-container.
  const mcpServersSrc = path.join(projectRoot, 'container', 'mcp-servers');
  if (fs.existsSync(mcpServersSrc)) {
    mounts.push({ hostPath: mcpServersSrc, containerPath: '/app/mcp-servers', readonly: true });
  }

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  sessionId?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // OTEL telemetry — Agent SDK passes these through to the Claude Code CLI subprocess
  if (!NANOCLAW_OTEL_DISABLE) {
    args.push('-e', 'CLAUDE_CODE_ENABLE_TELEMETRY=1');
    args.push('-e', 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1');
    args.push('-e', 'OTEL_METRICS_EXPORTER=none');
    args.push('-e', 'OTEL_LOGS_EXPORTER=otlp');
    args.push('-e', 'OTEL_TRACES_EXPORTER=otlp');
    args.push('-e', 'OTEL_EXPORTER_OTLP_PROTOCOL=grpc');
    args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${NANOCLAW_OTEL_CONTAINER_ENDPOINT}`);
    args.push('-e', 'OTEL_SERVICE_NAME=agent-runner');
    const resAttrs = [
      `agent.group=${agentGroup.name || agentGroup.id}`,
      ...(sessionId ? [`session.id=${sessionId}`] : []),
    ].join(',');
    args.push('-e', `OTEL_RESOURCE_ATTRIBUTES=${resAttrs}`);
    if (NANOCLAW_DEBUG) {
      args.push('-e', 'OTEL_LOG_USER_PROMPTS=1');
      args.push('-e', 'OTEL_LOG_TOOL_DETAILS=1');
      args.push('-e', 'OTEL_LOG_TOOL_CONTENT=1');
      args.push('-e', 'OTEL_METRIC_EXPORT_INTERVAL=10000');
      args.push('-e', 'OTEL_LOGS_EXPORT_INTERVAL=3000');
    }
  }

  // Local services (vault-search, reddit-search) on host.docker.internal must
  // bypass the OneCLI HTTPS_PROXY. Set before provider env so providers can
  // merge additional entries via mergeNoProxy().
  args.push('-e', 'NO_PROXY=host.docker.internal,localhost,127.0.0.1');
  args.push('-e', 'no_proxy=host.docker.internal,localhost,127.0.0.1');

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  if (agentIdentifier) {
    const onecliTracer = getTracer('container');
    await onecliTracer.startActiveSpan(
      'nanoclaw.onecli_ensure',
      {
        attributes: { 'agent.name': agentGroup.name ?? '', 'agent.identifier': agentIdentifier },
      },
      async (onecliSpan) => {
        try {
          await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
        } finally {
          onecliSpan.end();
        }
      },
    );
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
