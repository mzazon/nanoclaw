/**
 * Interactive-session runner — LOCAL-012.
 * Spawns Claude Code in interactive TUI mode with the bridge
 * channel plugin for session DB I/O. Uses `script` for PTY allocation.
 */
import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import type { ContainerConfig } from './container-config.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { initGroupFilesystem } from './group-init.js';
import { onSessionDestroyed } from './interactive-rate-limit.js';
import { log } from './log.js';
import { heartbeatPath, sessionDir } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const PTY_BUFFER_SIZE = 4096;

export interface RespawnFlags {
  noContinue?: boolean;
}

export interface InteractiveSpawnResult {
  child: ChildProcess;
  name: string;
  pidFile: string;
  ptyBuffer: { data: string };
}

export function buildInteractiveEnv(opts: {
  baseEnv: NodeJS.ProcessEnv;
  sessionDir: string;
  agentGroupId: string;
  assistantName?: string;
  timezone: string;
}): Record<string, string | undefined> {
  return {
    ...opts.baseEnv,
    HOME: opts.baseEnv.HOME || os.homedir(),
    TZ: opts.timezone,
    NANOCLAW_SESSION_DIR: opts.sessionDir,
    NANOCLAW_AGENT_GROUP_ID: opts.agentGroupId,
    ...(opts.assistantName ? { NANOCLAW_ASSISTANT_NAME: opts.assistantName } : {}),
  };
}

export function resolveBunBin(): string {
  const home = process.env.HOME || os.homedir();
  const candidate = path.join(home, '.bun', 'bin', 'bun');
  if (fs.existsSync(candidate)) return candidate;
  return 'bun';
}

export function buildMcpJson(bridgeServerPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'bridge': {
          command: resolveBunBin(),
          args: ['run', bridgeServerPath],
        },
      },
    },
    null,
    2,
  );
}

export function resolveClaudeBin(): string {
  // Override for pinning to a specific CC version (e.g. when a newer release
  // regresses the interactive runtime). Existence-checked so a stale value
  // doesn't silently brick spawn.
  const override = process.env.NANOCLAW_CLAUDE_BIN;
  if (override && fs.existsSync(override)) return override;

  const home = process.env.HOME || os.homedir();
  const candidates = [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.npm-global', 'bin', 'claude')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}

export function buildSpawnArgs(opts: {
  model?: string;
  continueSession: boolean;
  extraFlags: string[];
  groupDir?: string;
  mcpConfigPath?: string;
}): string[] {
  const args: string[] = [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:bridge',
  ];
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
  if (opts.groupDir) args.push('--add-dir', opts.groupDir);
  if (opts.continueSession) args.push('--continue');
  if (opts.model) args.push('--model', opts.model);
  args.push(...opts.extraFlags);
  return args;
}

export async function spawnInteractiveSession(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  opts?: RespawnFlags,
): Promise<InteractiveSpawnResult> {
  const projectRoot = process.cwd();
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  initGroupFilesystem(agentGroup);
  composeGroupClaudeMd(agentGroup);

  const name = `interactive-${agentGroup.folder}-${Date.now()}`;

  log.info('Spawning interactive session', { sessionId: session.id, agentGroup: agentGroup.name, name });

  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const bridgePath = path.join(projectRoot, 'bridge', 'server.ts');
  const mcpJsonPath = path.join(sessDir, '.mcp.json');
  fs.writeFileSync(mcpJsonPath, buildMcpJson(bridgePath));

  const env = buildInteractiveEnv({
    baseEnv: process.env,
    sessionDir: sessDir,
    agentGroupId: agentGroup.id,
    assistantName: agentGroup.name,
    timezone: TIMEZONE,
  });

  const claudeBin = resolveClaudeBin();
  const claudeArgs = buildSpawnArgs({
    model: containerConfig.model,
    continueSession: !opts?.noContinue,
    extraFlags: [],
    groupDir,
    mcpConfigPath: mcpJsonPath,
  });

  const ptyBuffer = { data: '' };

  function shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  const claudeCmd = [claudeBin, ...claudeArgs].map(shellEscape).join(' ');
  const isLinux = process.platform === 'linux';
  const typescriptFile = path.join(sessDir, '.pty-output');
  const scriptArgs = isLinux ? ['-qfc', claudeCmd, typescriptFile] : ['-q', typescriptFile, claudeBin, ...claudeArgs];

  const child = spawn('script', scriptArgs, {
    cwd: sessDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    const str = data.toString();
    ptyBuffer.data = (ptyBuffer.data + str).slice(-PTY_BUFFER_SIZE);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const str = data.toString();
    ptyBuffer.data = (ptyBuffer.data + str).slice(-PTY_BUFFER_SIZE);
  });

  // Poll the typescript file for PTY output (script doesn't pipe to stdout
  // when its own stdout is not a TTY).
  let lastSize = 0;
  const ptyPollInterval = setInterval(() => {
    try {
      const stat = fs.statSync(typescriptFile);
      if (stat.size > lastSize) {
        const fd = fs.openSync(typescriptFile, 'r');
        const buf = Buffer.alloc(Math.min(stat.size - lastSize, PTY_BUFFER_SIZE));
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const str = buf.toString();
        ptyBuffer.data = (ptyBuffer.data + str).slice(-PTY_BUFFER_SIZE);
      }
    } catch {}
  }, 2000);

  child.on('exit', () => clearInterval(ptyPollInterval));

  // Clear any pending rate-limit timer when the process exits so a stale
  // timer cannot fire against a future session that reuses the same sessionId.
  child.on('exit', () => {
    onSessionDestroyed(session.id);
  });

  // Auto-accept the development channels confirmation prompt.
  // CC always shows this when --dangerously-load-development-channels is used.
  setTimeout(() => {
    if (!child.killed) child.stdin?.write('\r');
  }, 5000);

  const pidFile = path.join(sessDir, '.host-pid');
  fs.writeFileSync(pidFile, String(child.pid));

  return { child, name, pidFile, ptyBuffer };
}
