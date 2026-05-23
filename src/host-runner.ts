/**
 * Host-agent runner — LOCAL-010.
 *
 * Runs the agent-runner directly on the host (no Docker container) via Bun.
 * All IO still flows through session DBs. Lifecycle management (activeContainers,
 * event handlers) stays in container-runner.ts — this module is a factory that
 * builds the environment and spawns the child process.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { DATA_DIR, GROUPS_DIR, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from './config.js';
import type { ContainerConfig } from './container-config.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { composeHostHome } from './host-home.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { syncSkillSymlinks } from './skill-symlinks.js';
import { heartbeatPath, sessionDir } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

const DOCKER_BRIDGE_IP = '172.17.0.1';

let _bunBin: string | undefined;
export function resolveBunBin(): string {
  if (_bunBin) return _bunBin;
  const home = process.env.HOME || os.homedir();
  const candidate = path.join(home, '.bun', 'bin', 'bun');
  _bunBin = fs.existsSync(candidate) ? candidate : 'bun';
  return _bunBin;
}

/** Exported for testing — resets the cached bun path. */
export function _resetBunBinCache(): void {
  _bunBin = undefined;
}

export interface HostSpawnResult {
  child: ChildProcess;
  name: string;
  pidFile: string;
}

/**
 * Build the env vars for a host-agent process. Pure function — no IO.
 * Exported for testing the proxy rewrite and path construction.
 */
export function buildHostProcessEnv(opts: {
  baseEnv: NodeJS.ProcessEnv;
  onecliEnv: Record<string, string>;
  home: string;
  sessDir: string;
  groupDir: string;
  projectRoot: string;
}): Record<string, string | undefined> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.onecliEnv)) {
    if (typeof value === 'string') {
      rewritten[key] = value.replace(/host\.docker\.internal/g, DOCKER_BRIDGE_IP);
    }
  }

  return {
    ...opts.baseEnv,
    ...rewritten,
    HOME: opts.home,
    NANOCLAW_HOST_MODE: 'true',
    NANOCLAW_WORKSPACE: opts.sessDir,
    NANOCLAW_AGENT_DIR: opts.groupDir,
    NANOCLAW_EXTRA_DIR: path.join(opts.groupDir, '.host-extra'),
    NANOCLAW_GLOBAL_DIR: path.join(GROUPS_DIR, 'global'),
    NANOCLAW_SKILLS_DIR: path.join(opts.projectRoot, 'container', 'skills'),
    NANOCLAW_SHARED_CLAUDE_MD: path.join(opts.projectRoot, 'container', 'CLAUDE.md'),
    TZ: TIMEZONE,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
}

/**
 * Spawn a host-agent process. Returns the child process and metadata —
 * lifecycle management (activeContainers, event handlers) is the caller's
 * responsibility.
 *
 * Mirrors buildMounts + Docker spawn in container-runner.ts: both paths
 * call initGroupFilesystem, syncSkillSymlinks, composeGroupClaudeMd.
 */
export async function spawnHostProcess(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
): Promise<HostSpawnResult> {
  const projectRoot = process.cwd();
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');

  // Mirrors buildMounts in container-runner.ts — both paths need this.
  initGroupFilesystem(agentGroup);
  syncSkillSymlinks(path.join(claudeDir, 'skills'), containerConfig, (s) =>
    path.join(projectRoot, 'container', 'skills', s),
  );
  composeGroupClaudeMd(agentGroup);

  const name = `host-${agentGroup.folder}-${Date.now()}`;
  const home = containerConfig.hostHome
    ? process.env.HOME || os.homedir()
    : composeHostHome(agentGroup.id, containerConfig);

  log.info('Spawning host-agent process', { sessionId: session.id, agentGroup: agentGroup.name, name, home });

  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const agentIdentifier = agentGroup.id;
  await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });

  let onecliEnv: Record<string, string> = {};
  try {
    const cc = await onecli.getContainerConfig(agentIdentifier);
    onecliEnv = { ...cc.env };
    if (cc.caCertificate) {
      const certPath = path.join(DATA_DIR, '.host-home', 'onecli-ca.crt');
      fs.mkdirSync(path.dirname(certPath), { recursive: true });
      fs.writeFileSync(certPath, cc.caCertificate);
      onecliEnv.NODE_EXTRA_CA_CERTS = certPath;
    }
  } catch (err) {
    log.warn('OneCLI getContainerConfig failed — host-agent will lack API auth', { err });
  }

  const env = buildHostProcessEnv({
    baseEnv: process.env,
    onecliEnv,
    home,
    sessDir,
    groupDir,
    projectRoot,
  });

  const child = spawn(
    resolveBunBin(),
    ['run', path.join(projectRoot, 'container', 'agent-runner', 'src', 'index.ts')],
    { cwd: sessDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const pidFile = path.join(sessDir, '.host-pid');
  fs.writeFileSync(pidFile, String(child.pid));

  return { child, name, pidFile };
}

/**
 * Kill orphan host-agent processes from a previous NanoClaw run.
 * Docker containers are cleaned by cleanupOrphans() via label filter.
 * Host processes use a PID file written at spawn time.
 */
export function cleanupHostOrphans(): void {
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsRoot)) return;
  let killed = 0;
  for (const agDir of fs.readdirSync(sessionsRoot)) {
    const agPath = path.join(sessionsRoot, agDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(agPath);
    } catch {
      continue;
    }
    for (const sessDir of entries) {
      const pidFile = path.join(agPath, sessDir, '.host-pid');
      let raw: string;
      try {
        raw = fs.readFileSync(pidFile, 'utf-8').trim();
      } catch {
        continue;
      }
      const pid = Number(raw);
      if (!pid) {
        fs.rmSync(pidFile, { force: true });
        continue;
      }
      try {
        process.kill(pid, 0);
        if (!isOurProcess(pid)) {
          log.debug('Stale host-pid — PID reused by unrelated process', { pid, session: sessDir });
          fs.rmSync(pidFile, { force: true });
          continue;
        }
        process.kill(pid, 'SIGTERM');
        killed++;
        log.info('Killed orphan host-agent process', { pid, session: sessDir });
      } catch {
        // already dead
      }
      fs.rmSync(pidFile, { force: true });
    }
  }
  if (killed > 0) {
    log.info('Cleaned up orphan host-agent processes', { count: killed });
  }
}

function isOurProcess(pid: number): boolean {
  if (process.platform !== 'linux') return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return cmdline.includes('agent-runner') || cmdline.includes('bridge');
  } catch {
    return true;
  }
}
