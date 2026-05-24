// LOCAL-015: CC-container runner — mounts, args, PTY polling, keystroke injection.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import type { ContainerConfig, McpServerConfig } from './container-config.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { initGroupFilesystem } from './group-init.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { sessionDir } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';
import type { ProviderContainerContribution, VolumeMount } from './providers/provider-container-registry.js';

const PTY_BUFFER_SIZE = 4096;

export function buildCcContainerMcpJson(
  bridgePath: string,
  additionalServers: Record<string, McpServerConfig>,
): string {
  const servers: Record<string, unknown> = {
    bridge: {
      command: 'bun',
      args: ['run', bridgePath],
    },
  };
  for (const [name, config] of Object.entries(additionalServers)) {
    servers[name] = config;
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

export function buildCcContainerMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();
  initGroupFilesystem(agentGroup);
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session dir → devcontainer-standard path
  mounts.push({ hostPath: sessDir, containerPath: '/workspaces/.nanoclaw', readonly: false });

  // CC project data (session .jsonl, memory) — persists across container restarts
  // so --continue works and CC can resume conversations. Path slug is deterministic
  // because the container CWD is always /workspaces/project.
  const ccProjectsDir = path.join(sessDir, '.claude-projects');
  fs.mkdirSync(ccProjectsDir, { recursive: true });
  mounts.push({ hostPath: ccProjectsDir, containerPath: '/home/node/.claude/projects', readonly: false });

  // Group dir → project CWD
  mounts.push({ hostPath: groupDir, containerPath: '/workspaces/project', readonly: false });

  // Composed CLAUDE.md — RO overlay
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspaces/project/CLAUDE.md', readonly: true });
  }

  // container.json — RO overlay
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspaces/project/container.json', readonly: true });
  }

  // Bridge source — RO (CC spawns bridge via .mcp.json)
  const bridgeSrc = path.join(projectRoot, 'bridge');
  mounts.push({ hostPath: bridgeSrc, containerPath: '/app/bridge', readonly: true });

  // CC entrypoint — RO
  const entrypoint = path.join(projectRoot, 'container', 'cc-entrypoint.sh');
  mounts.push({ hostPath: entrypoint, containerPath: '/app/cc-entrypoint.sh', readonly: true });

  // Shared CLAUDE.md base — needed for flatten compose
  const sharedClaudeMd = path.join(projectRoot, 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Skills — RO (instructions inlined by flatten compose; code used by MCP tools)
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // CC hooks — RO
  const hooksSrc = path.join(projectRoot, 'container', 'cc-hooks');
  if (fs.existsSync(hooksSrc)) {
    mounts.push({ hostPath: hooksSrc, containerPath: '/app/cc-hooks', readonly: true });
  }

  // Global memory — RO
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspaces/global', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts?.length > 0) {
    mounts.push(...validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name));
  }

  // Provider mounts
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

export function buildCcContainerEnv(
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  providerContribution: ProviderContainerContribution,
): string[][] {
  const envPairs: string[][] = [];

  envPairs.push(['-e', `TZ=${TIMEZONE}`]);
  // api.anthropic.com bypasses proxy — CC uses OAuth token directly, proxy breaks it
  envPairs.push(['-e', 'NO_PROXY=host.docker.internal,localhost,127.0.0.1,api.anthropic.com']);
  envPairs.push(['-e', 'no_proxy=host.docker.internal,localhost,127.0.0.1,api.anthropic.com']);
  envPairs.push(['-e', 'NANOCLAW_SESSION_DIR=/workspaces/.nanoclaw']);
  envPairs.push(['-e', `NANOCLAW_AGENT_GROUP_ID=${agentGroup.id}`]);

  if (agentGroup.name) {
    envPairs.push(['-e', `NANOCLAW_ASSISTANT_NAME=${agentGroup.name}`]);
  }
  if (containerConfig.model) {
    envPairs.push(['-e', `NANOCLAW_MODEL=${containerConfig.model}`]);
  }

  // Tool surface minimization: scheduling and NCL disabled by default for cc-container
  envPairs.push(['-e', 'NANOCLAW_BRIDGE_SCHEDULING=0']);
  envPairs.push(['-e', 'NANOCLAW_BRIDGE_NCL=0']);

  const compactPct = containerConfig.model?.includes('opus') ? '50' : '80';
  envPairs.push(['-e', `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${compactPct}`]);

  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      envPairs.push(['-e', `${key}=${value}`]);
    }
  }

  return envPairs;
}

export function startCcPtyPolling(sessDir: string, ptyBuffer: { data: string }): NodeJS.Timeout {
  const ptyOutputPath = path.join(sessDir, '.pty-output');
  let lastSize = 0;
  return setInterval(() => {
    try {
      const stat = fs.statSync(ptyOutputPath);
      if (stat.size > lastSize) {
        const fd = fs.openSync(ptyOutputPath, 'r');
        const buf = Buffer.alloc(Math.min(stat.size - lastSize, PTY_BUFFER_SIZE));
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        ptyBuffer.data = (ptyBuffer.data + buf.toString()).slice(-PTY_BUFFER_SIZE);
      }
    } catch {
      // File may not exist yet during container startup
    }
  }, 2000);
}

export function sendCcContainerKeystroke(containerName: string, key: string): void {
  const tmuxKey = key === '\r' ? 'Enter' : key;
  execSync(`${CONTAINER_RUNTIME_BIN} exec ${containerName} tmux send-keys -t cc ${tmuxKey}`, {
    stdio: 'pipe',
    timeout: 5000,
  });
}

function isIdle(ptyBuffer: { data: string }): boolean {
  const tail = ptyBuffer.data.slice(-200);
  return /[❯>]\s*$/.test(tail);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function injectCcCommand(
  containerName: string,
  command: string,
  ptyBuffer: { data: string },
  opts?: { timeoutMs?: number; pollMs?: number; delayMs?: number },
): Promise<boolean> {
  const { timeoutMs = 30_000, pollMs = 500, delayMs = 500 } = opts ?? {};
  let sentAtIdle = true;

  if (!isIdle(ptyBuffer)) {
    const deadline = Date.now() + timeoutMs;
    sentAtIdle = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (isIdle(ptyBuffer)) {
        sentAtIdle = true;
        break;
      }
    }
    if (!sentAtIdle) {
      const { log } = await import('./log.js');
      log.warn('injectCcCommand: timed out waiting for idle prompt, sending anyway', {
        containerName,
        command,
      });
    }
  }

  execSync(
    `${CONTAINER_RUNTIME_BIN} exec ${containerName} tmux send-keys -t cc -- ${JSON.stringify(command)}`,
    { stdio: 'pipe', timeout: 5000 },
  );
  await sleep(delayMs);
  execSync(`${CONTAINER_RUNTIME_BIN} exec ${containerName} tmux send-keys -t cc Enter`, {
    stdio: 'pipe',
    timeout: 5000,
  });

  return sentAtIdle;
}
