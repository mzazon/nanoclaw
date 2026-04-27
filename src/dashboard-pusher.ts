/**
 * Dashboard pusher — collects NanoClaw state and POSTs a JSON
 * snapshot to the dashboard's /api/ingest endpoint every interval.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execSync, execFileSync } from 'child_process';
import Database from 'better-sqlite3';

import { getAllAgentGroups, getAgentGroup } from './db/agent-groups.js';
import { getSessionsByAgentGroup, getSession } from './db/sessions.js';
import { getAllMessagingGroups, getMessagingGroupAgents } from './db/messaging-groups.js';
import { getDestinations } from './modules/agent-to-agent/db/agent-destinations.js';
import { getMembers } from './modules/permissions/db/agent-group-members.js';
import { getAllUsers, getUser } from './modules/permissions/db/users.js';
import { getUserRoles, getAdminsOfAgentGroup } from './modules/permissions/db/user-roles.js';
import { getUserDmsForUser } from './modules/permissions/db/user-dms.js';
import { getActiveAdapters, getRegisteredChannelNames } from './channels/channel-registry.js';
import { DATA_DIR, ASSISTANT_NAME, CONTAINER_INSTALL_LABEL, ONECLI_URL } from './config.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { getActiveContainerEntries } from './container-runner.js';
import { heartbeatPath } from './session-manager.js';
import { scanScheduledTasks } from './dashboard/tasks-db.js';

interface PusherConfig {
  port: number;
  secret: string;
  intervalMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;

export function startDashboardPusher(config: PusherConfig): void {
  const interval = config.intervalMs || 60000;

  // Push immediately on start, then on interval
  push(config).catch((err) => log.error('Dashboard push failed', { err }));
  timer = setInterval(() => {
    push(config).catch((err) => log.error('Dashboard push failed', { err }));
  }, interval);

  // Start log file tailing
  startLogTail(config);

  log.info('Dashboard pusher started', { intervalMs: interval });
}

export function stopDashboardPusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

/** Fire-and-forget POST to the dashboard. */
function postJson(config: PusherConfig, urlPath: string, data: unknown): void {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port: config.port,
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${config.secret}`,
    },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function startLogTail(config: PusherConfig): void {
  const logFile = path.resolve(process.cwd(), 'logs', 'nanoclaw.log');
  if (!fs.existsSync(logFile)) return;

  // Send last 200 lines as backfill
  try {
    const allLines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    logOffset = fs.statSync(logFile).size;
    const tail = allLines.slice(-200).map((l) => l.replace(ANSI_RE, ''));
    if (tail.length > 0) postJson(config, '/api/logs/push', { lines: tail });
  } catch {
    return;
  }

  // Poll every 2s for new lines
  logTimer = setInterval(() => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= logOffset) {
        logOffset = stat.size;
        return;
      }
      const buf = Buffer.alloc(stat.size - logOffset);
      const fd = fs.openSync(logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      fs.closeSync(fd);
      logOffset = stat.size;
      const lines = buf
        .toString()
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => l.replace(ANSI_RE, ''));
      if (lines.length > 0) postJson(config, '/api/logs/push', { lines });
    } catch {
      /* ignore */
    }
  }, 2000);
}

async function push(config: PusherConfig): Promise<void> {
  const snapshot = await collectSnapshot();
  postJson(config, '/api/ingest', snapshot);
  log.debug('Dashboard snapshot pushed');
}

async function collectSnapshot(): Promise<Record<string, unknown>> {
  return {
    timestamp: new Date().toISOString(),
    assistant_name: ASSISTANT_NAME,
    uptime: Math.floor(process.uptime()),
    agent_groups: collectAgentGroups(),
    sessions: collectSessions(),
    channels: collectChannels(),
    users: collectUsers(),
    tokens: collectTokens(),
    context_windows: collectContextWindows(),
    activity: collectActivity(),
    messages: collectMessages(),
    host_health: collectHostHealth(),
    containers: await collectContainers(),
    scheduled_tasks: collectScheduledTasks(),
    credentials: await collectCredentials(),
    ...collectAuditData(),
  };
}

/**
 * Parse a Docker memory string like "1.5GiB" or "128MiB" into bytes.
 */
function parseDockerMemory(s: string): number {
  const match = s.trim().match(/^([\d.]+)\s*(GiB|MiB|KiB|B)$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 'gib':
      return val * 1073741824;
    case 'mib':
      return val * 1048576;
    case 'kib':
      return val * 1024;
    default:
      return val;
  }
}

/**
 * Collect per-container details: docker ps + docker stats + outbound.db container_state + heartbeat.
 * Returns empty array if Docker is unavailable or slow.
 */
async function collectContainers(): Promise<unknown[]> {
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  // Build a map from containerName → sessionId using the in-memory tracker
  const activeEntries = getActiveContainerEntries();
  const containerToSession = new Map<string, string>();
  for (const entry of activeEntries) {
    containerToSession.set(entry.containerName, entry.sessionId);
  }

  // List running containers with our install label
  let psOutput: string;
  try {
    psOutput = execFileSync('docker', ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', 'json'], {
      timeout: 5000,
    }).toString();
  } catch {
    return [];
  }

  const containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    createdAt: string;
  }> = [];
  for (const line of psOutput.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      containers.push({
        id: c.ID || '',
        name: c.Names || '',
        image: c.Image || '',
        status: c.Status || '',
        createdAt: c.CreatedAt || '',
      });
    } catch {
      /* skip */
    }
  }

  if (containers.length === 0) return [];

  // Get CPU/memory stats for all containers at once
  const statsMap = new Map<string, { cpuPercent: number; memUsage: number; memLimit: number }>();
  try {
    const ids = containers.map((c) => c.id);
    const statsOutput = execFileSync('docker', ['stats', '--no-stream', '--format', 'json', ...ids], {
      timeout: 5000,
    }).toString();
    for (const line of statsOutput.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line);
        const cpuStr = (s.CPUPerc || '0%').replace('%', '');
        const memParts = (s.MemUsage || '').split('/');
        statsMap.set(s.ID || '', {
          cpuPercent: parseFloat(cpuStr) || 0,
          memUsage: memParts[0] ? parseDockerMemory(memParts[0].trim()) : 0,
          memLimit: memParts[1] ? parseDockerMemory(memParts[1].trim()) : 0,
        });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* stats unavailable — continue without */
  }

  // Build result array
  const results: unknown[] = [];

  for (const c of containers) {
    const sessionId = containerToSession.get(c.name);
    if (!sessionId) continue; // Unknown container — skip

    // Look up session to get agent_group_id
    const session = getSession(sessionId);
    if (!session) continue;

    const agentGroupId = session.agent_group_id;
    const agentGroupName = nameMap.get(agentGroupId) || agentGroupId;

    // Read container_state from outbound.db
    let currentTool: string | undefined;
    let toolStartedAt: string | undefined;
    try {
      const outDbPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'outbound.db');
      if (fs.existsSync(outDbPath)) {
        const db = new Database(outDbPath, { readonly: true });
        try {
          const row = db.prepare('SELECT current_tool, tool_started_at FROM container_state WHERE id = 1').get() as
            | { current_tool: string | null; tool_started_at: string | null }
            | undefined;
          if (row?.current_tool) {
            currentTool = row.current_tool;
            toolStartedAt = row.tool_started_at ?? undefined;
          }
        } catch {
          /* table may not exist in older DBs */
        }
        db.close();
      }
    } catch {
      /* skip — DB may be locked */
    }

    // Read heartbeat age
    let heartbeatAge: number | undefined;
    try {
      const hbPath = heartbeatPath(agentGroupId, sessionId);
      const stat = fs.statSync(hbPath);
      heartbeatAge = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    } catch {
      /* file may not exist yet (fresh spawn) */
    }

    const stats = statsMap.get(c.id);

    results.push({
      session_id: sessionId,
      agent_group_id: agentGroupId,
      agent_group_name: agentGroupName,
      container_id: c.id,
      status: c.status.toLowerCase().startsWith('up') ? 'running' : 'stopped',
      started_at: c.createdAt,
      cpu_percent: stats?.cpuPercent,
      memory_usage: stats?.memUsage,
      memory_limit: stats?.memLimit,
      image: c.image,
      current_tool: currentTool,
      tool_started_at: toolStartedAt,
      heartbeat_age: heartbeatAge,
    });
  }

  return results;
}

async function collectCredentials(): Promise<{
  available: boolean;
  agents: { id: string; name: string; agent_group_id: string; secret_mode: string; secret_count: number }[];
  secrets: { id: string; name: string; host_patterns: string[] }[];
}> {
  if (!ONECLI_URL) return { available: false, agents: [], secrets: [] };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const [agentsRes, secretsRes] = await Promise.all([
      fetch(`${ONECLI_URL}/api/agents`, { signal: controller.signal }),
      fetch(`${ONECLI_URL}/api/secrets`, { signal: controller.signal }),
    ]);
    clearTimeout(timeout);
    if (!agentsRes.ok || !secretsRes.ok) return { available: false, agents: [], secrets: [] };
    const agentsData = (await agentsRes.json()) as any[];
    const secretsData = (await secretsRes.json()) as any[];
    return {
      available: true,
      agents: agentsData.map((a: any) => ({
        id: a.id,
        name: a.name,
        agent_group_id: a.identifier,
        secret_mode: a.secretMode || a.secret_mode || 'selective',
        secret_count: Array.isArray(a.secrets) ? a.secrets.length : 0,
      })),
      secrets: secretsData.map((s: any) => ({
        id: s.id,
        name: s.name,
        host_patterns: Array.isArray(s.hostPatterns || s.host_patterns) ? s.hostPatterns || s.host_patterns : [],
      })),
    };
  } catch {
    return { available: false, agents: [], secrets: [] };
  }
}

function collectAuditData() {
  const db = getDb();

  const unregisteredSenders = db.prepare('SELECT * FROM unregistered_senders ORDER BY last_seen DESC LIMIT 100').all();

  const pendingApprovals = db.prepare('SELECT * FROM pending_approvals ORDER BY created_at DESC LIMIT 100').all();

  const pendingSenderApprovals = db
    .prepare('SELECT * FROM pending_sender_approvals ORDER BY created_at DESC LIMIT 100')
    .all();

  const pendingChannelApprovals = db.prepare('SELECT * FROM pending_channel_approvals ORDER BY created_at DESC').all();

  const pendingQuestions = db.prepare('SELECT * FROM pending_questions ORDER BY created_at DESC LIMIT 100').all();

  // Unify all approval types into one array
  const allApprovals = [
    ...pendingApprovals.map((a: any) => ({ ...a, approval_type: 'credential' })),
    ...pendingSenderApprovals.map((a: any) => ({
      approval_id: a.id,
      action: 'sender_approval',
      title: a.title || `Sender: ${a.sender_name || a.sender_identity}`,
      status: 'pending',
      agent_group_id: a.agent_group_id,
      created_at: a.created_at,
      approval_type: 'sender',
    })),
    ...pendingChannelApprovals.map((a: any) => ({
      approval_id: a.messaging_group_id,
      action: 'channel_approval',
      title: a.title || 'Channel approval',
      status: 'pending',
      agent_group_id: a.agent_group_id,
      created_at: a.created_at,
      approval_type: 'channel',
    })),
  ];

  return {
    unregistered_senders: unregisteredSenders,
    pending_approvals: allApprovals,
    pending_questions: pendingQuestions.map((q: any) => ({
      ...q,
      options: JSON.parse(q.options_json || '[]'),
    })),
    dropped_messages: [],
  };
}

function collectHostHealth() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let disk: { mount: string; total: number; used: number; percent: number }[] = [];
  try {
    const dfOut = execSync('df -B1 --output=target,size,used /', { timeout: 3000 }).toString();
    const lines = dfOut.trim().split('\n').slice(1);
    disk = lines.map((line) => {
      const [mount, totalStr, usedStr] = line.trim().split(/\s+/);
      const total = parseInt(totalStr, 10);
      const used = parseInt(usedStr, 10);
      return { mount, total, used, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
    });
  } catch {
    /* skip */
  }

  return {
    memory_total: totalMem,
    memory_used: usedMem,
    memory_percent: Math.round((usedMem / totalMem) * 100),
    disk,
    uptime: Math.floor(os.uptime()),
    load_avg: os.loadavg() as [number, number, number],
  };
}

function collectAgentGroups() {
  return getAllAgentGroups().map((g) => {
    const sessions = getSessionsByAgentGroup(g.id);
    const running = sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle');
    const destinations = getDestinations(g.id);
    const members = getMembers(g.id).map((m) => {
      const user = getUser(m.user_id);
      return { ...m, display_name: user?.display_name ?? null };
    });
    const admins = getAdminsOfAgentGroup(g.id).map((a) => {
      const user = getUser(a.user_id);
      return { ...a, display_name: user?.display_name ?? null };
    });

    // Wirings
    const db = getDb();
    const wirings = db
      .prepare(
        `SELECT mga.*, mg.channel_type, mg.platform_id, mg.name as mg_name, mg.is_group, mg.unknown_sender_policy
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ?`,
      )
      .all(g.id) as Array<Record<string, unknown>>;

    return {
      id: g.id,
      name: g.name,
      folder: g.folder,
      agent_provider: g.agent_provider,
      container_config: null,
      sessionCount: sessions.length,
      runningSessions: running.length,
      wirings,
      destinations,
      members,
      admins,
      created_at: g.created_at,
    };
  });
}

function collectSessions() {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.*, ag.name as agent_group_name, ag.folder as agent_group_folder,
              mg.channel_type, mg.platform_id, mg.name as messaging_group_name
       FROM sessions s
       LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       ORDER BY s.last_active DESC NULLS LAST`,
    )
    .all() as Array<Record<string, unknown>>;
}

function collectChannels() {
  const messagingGroups = getAllMessagingGroups();
  const liveAdapters = getActiveAdapters().map((a) => a.channelType);
  const registeredChannels = getRegisteredChannelNames();

  const byType: Record<string, { channelType: string; isLive: boolean; isRegistered: boolean; groups: unknown[] }> = {};

  for (const mg of messagingGroups) {
    if (!byType[mg.channel_type]) {
      byType[mg.channel_type] = {
        channelType: mg.channel_type,
        isLive: liveAdapters.includes(mg.channel_type),
        isRegistered: registeredChannels.includes(mg.channel_type),
        groups: [],
      };
    }

    const agents = getMessagingGroupAgents(mg.id).map((a) => {
      const group = getAgentGroup(a.agent_group_id);
      return { agent_group_id: a.agent_group_id, agent_group_name: group?.name ?? null, priority: a.priority };
    });

    byType[mg.channel_type].groups.push({
      messagingGroup: {
        id: mg.id,
        platform_id: mg.platform_id,
        name: mg.name,
        is_group: mg.is_group,
        unknown_sender_policy: (mg as unknown as Record<string, unknown>).unknown_sender_policy ?? 'strict',
      },
      agents,
    });
  }

  // Include live adapters with no messaging groups
  for (const ct of liveAdapters) {
    if (!byType[ct]) {
      byType[ct] = { channelType: ct, isLive: true, isRegistered: true, groups: [] };
    }
  }

  return Object.values(byType).sort((a, b) => a.channelType.localeCompare(b.channelType));
}

function collectUsers() {
  return getAllUsers().map((u) => {
    const roles = getUserRoles(u.id);
    const dms = getUserDmsForUser(u.id);

    const db = getDb();
    const memberships = db
      .prepare(
        `SELECT agm.agent_group_id, ag.name as agent_group_name
         FROM agent_group_members agm
         JOIN agent_groups ag ON ag.id = agm.agent_group_id
         WHERE agm.user_id = ?`,
      )
      .all(u.id) as Array<Record<string, unknown>>;

    let privilege = 'none';
    if (roles.some((r) => r.role === 'owner')) privilege = 'owner';
    else if (roles.some((r) => r.role === 'admin' && !r.agent_group_id)) privilege = 'global_admin';
    else if (roles.some((r) => r.role === 'admin')) privilege = 'admin';
    else if (memberships.length > 0) privilege = 'member';

    return {
      id: u.id,
      kind: u.kind,
      display_name: u.display_name,
      privilege,
      roles,
      memberships,
      dmChannels: dms.map((d) => ({ channel_type: d.channel_type })),
      created_at: u.created_at,
    };
  });
}

function collectTokens() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  const allEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    agentGroupId: string;
  }> = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  if (fs.existsSync(sessionsDir)) {
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const entries = scanJsonlTokens(path.join(sessionsDir, agDir));
      allEntries.push(...entries.map((e) => ({ ...e, agentGroupId: agDir })));
    }
  }

  const byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  > = {};
  const byGroup: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      name: string;
    }
  > = {};
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  for (const e of allEntries) {
    if (!byModel[e.model])
      byModel[e.model] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    byModel[e.model].requests++;
    byModel[e.model].inputTokens += e.inputTokens;
    byModel[e.model].outputTokens += e.outputTokens;
    byModel[e.model].cacheReadTokens += e.cacheReadTokens;
    byModel[e.model].cacheCreationTokens += e.cacheCreationTokens;

    if (!byGroup[e.agentGroupId])
      byGroup[e.agentGroupId] = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        name: nameMap.get(e.agentGroupId) || e.agentGroupId,
      };
    byGroup[e.agentGroupId].requests++;
    byGroup[e.agentGroupId].inputTokens += e.inputTokens;
    byGroup[e.agentGroupId].outputTokens += e.outputTokens;
    byGroup[e.agentGroupId].cacheReadTokens += e.cacheReadTokens;
    byGroup[e.agentGroupId].cacheCreationTokens += e.cacheCreationTokens;

    totals.requests++;
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.cacheReadTokens += e.cacheReadTokens;
    totals.cacheCreationTokens += e.cacheCreationTokens;
  }

  return { totals, byModel, byGroup };
}

function scanJsonlTokens(agentDir: string) {
  const claudeDir = path.join(agentDir, '.claude-shared', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const entries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = [];

  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) {
          try {
            for (const line of fs.readFileSync(full, 'utf-8').split('\n')) {
              if (!line.trim()) continue;
              try {
                const r = JSON.parse(line);
                if (r.type === 'assistant' && r.message?.usage) {
                  const u = r.message.usage;
                  entries.push({
                    model: r.message.model || 'unknown',
                    inputTokens: u.input_tokens || 0,
                    outputTokens: u.output_tokens || 0,
                    cacheReadTokens: u.cache_read_input_tokens || 0,
                    cacheCreationTokens: u.cache_creation_input_tokens || 0,
                  });
                }
              } catch {
                /* skip line */
              }
            }
          } catch {
            /* skip file */
          }
        }
      }
    } catch {
      /* skip dir */
    }
  };
  walk(claudeDir);
  return entries;
}

function collectContextWindows() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: unknown[] = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
    const claudeDir = path.join(sessionsDir, agDir, '.claude-shared', 'projects');
    if (!fs.existsSync(claudeDir)) continue;

    // Find most recent JSONL
    const jsonlFiles: string[] = [];
    const walk = (dir: string): void => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.jsonl')) jsonlFiles.push(full);
        }
      } catch {
        /* skip */
      }
    };
    walk(claudeDir);
    if (jsonlFiles.length === 0) continue;

    jsonlFiles.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    // Read last assistant turn from newest file
    const content = fs.readFileSync(jsonlFiles[0], 'utf-8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const r = JSON.parse(lines[i]);
        if (r.type === 'assistant' && r.message?.usage) {
          const u = r.message.usage;
          const model = r.message.model || 'unknown';
          const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const max = 200000;
          results.push({
            agentGroupId: agDir,
            agentGroupName: nameMap.get(agDir),
            sessionId: path.basename(jsonlFiles[0], '.jsonl'),
            model,
            contextTokens: ctx,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cache_creation_input_tokens || 0,
            maxContext: max,
            usagePercent: max > 0 ? Math.round((ctx / max) * 100) : 0,
            timestamp: r.timestamp || '',
          });
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  return results;
}

function collectScheduledTasks() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  const groups = getAllAgentGroups();
  const groupMap = new Map(groups.map((g) => [g.id, g.name]));
  return scanScheduledTasks(sessionsDir, groupMap);
}

function collectActivity() {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};

  for (let i = 0; i < 24; i++) {
    const key = new Date(now - i * 3600000).toISOString().slice(0, 13);
    buckets[key] = { inbound: 0, outbound: 0 };
  }

  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return toBucketArray(buckets);

  const cutoff = new Date(now - 86400000).toISOString();

  try {
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const agPath = path.join(sessionsDir, agDir);
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        for (const [dbName, direction] of [
          ['outbound.db', 'outbound'],
          ['inbound.db', 'inbound'],
        ] as const) {
          const dbPath = path.join(agPath, sessDir, dbName);
          if (!fs.existsSync(dbPath)) continue;
          try {
            const db = new Database(dbPath, { readonly: true });
            const table = direction === 'outbound' ? 'messages_out' : 'messages_in';
            const rows = db.prepare(`SELECT timestamp FROM ${table} WHERE timestamp > ?`).all(cutoff) as {
              timestamp: string;
            }[];
            for (const row of rows) {
              const key = row.timestamp.slice(0, 13);
              if (buckets[key]) buckets[key][direction]++;
            }
            db.close();
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* skip */
  }

  return toBucketArray(buckets);
}

function toBucketArray(buckets: Record<string, { inbound: number; outbound: number }>) {
  return Object.entries(buckets)
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function collectMessages() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: Array<{ agentGroupId: string; sessionId: string; inbound: unknown[]; outbound: unknown[] }> = [];
  const limit = 50;

  try {
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const agPath = path.join(sessionsDir, agDir);
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        const inbound: unknown[] = [];
        const outbound: unknown[] = [];

        const inDbPath = path.join(agPath, sessDir, 'inbound.db');
        if (fs.existsSync(inDbPath)) {
          try {
            const db = new Database(inDbPath, { readonly: true });
            const rows = db.prepare('SELECT * FROM messages_in ORDER BY seq DESC LIMIT ?').all(limit);
            inbound.push(...(rows as unknown[]).reverse());
            db.close();
          } catch {
            /* skip */
          }
        }

        const outDbPath = path.join(agPath, sessDir, 'outbound.db');
        if (fs.existsSync(outDbPath)) {
          try {
            const db = new Database(outDbPath, { readonly: true });
            const rows = db.prepare('SELECT * FROM messages_out ORDER BY seq DESC LIMIT ?').all(limit);
            outbound.push(...(rows as unknown[]).reverse());
            db.close();
          } catch {
            /* skip */
          }
        }

        if (inbound.length > 0 || outbound.length > 0) {
          results.push({ agentGroupId: agDir, sessionId: sessDir, inbound, outbound });
        }
      }
    }
  } catch {
    /* skip */
  }

  return results;
}
