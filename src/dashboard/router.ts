/**
 * Dashboard route dispatch.
 * All data comes from the in-memory store (populated via POST /api/ingest).
 */
import crypto from 'crypto';
import type http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { getSnapshot, getLastUpdated } from './store.js';
import { overviewPage } from './ui/pages/overview.js';
import { agentGroupsPage } from './ui/pages/agent-groups.js';
import { sessionsPage } from './ui/pages/sessions.js';
import { channelsPage } from './ui/pages/channels.js';
import { messagesPage } from './ui/pages/messages.js';
import { usersPage } from './ui/pages/users.js';
import { logsPage } from './ui/pages/logs.js';
import { hostHealthPage } from './ui/pages/host-health.js';
import { containersPage } from './ui/pages/containers.js';
import { tasksPage } from './ui/pages/tasks.js';
import { credentialsPage } from './ui/pages/credentials.js';
import { errorsPage } from './ui/pages/errors.js';
import { auditPage } from './ui/pages/audit.js';
import { settingsPage } from './ui/pages/settings.js';
import { mountsPage } from './ui/pages/mounts.js';
import { scanScheduledTasks, findTaskSession } from './tasks-db.js';
import { cancelTask, pauseTask, resumeTask } from '../modules/scheduling/db.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { DATA_DIR, GROUPS_DIR, ASSISTANT_NAME, CONTAINER_INSTALL_LABEL, ONECLI_URL } from '../config.js';
import { getActiveContainerEntries } from '../container-runner.js';
import { getDashboardSecret, setDashboardSecret } from './server.js';
import { updateEnvSecret, parseAllEnvKeys, redactEnvKeys } from './token-rotate-helpers.js';

const execFileAsync = promisify(execFile);

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function html(res: http.ServerResponse, content: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

export async function dispatch(
  method: string,
  urlPath: string,
  params: URLSearchParams,
  res: http.ServerResponse,
): Promise<void> {
  const s = getSnapshot();

  // --- API routes ---
  if (method === 'GET' && urlPath === '/api/status') {
    return json(res, { ok: true, hasData: !!s, lastUpdated: getLastUpdated() });
  }

  if (method === 'GET' && urlPath === '/api/overview') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, {
      assistantName: s.assistant_name,
      uptime: s.uptime,
      agentGroups: {
        total: s.agent_groups.length,
        list: s.agent_groups.map((g) => ({ id: g.id, name: g.name, folder: g.folder })),
      },
      sessions: {
        active: s.sessions.filter((x) => x.status === 'active').length,
        running: s.sessions.filter((x) => x.container_status === 'running' || x.container_status === 'idle').length,
      },
      channels: {
        registered: s.channels.filter((c) => c.isRegistered).map((c) => c.channelType),
        live: s.channels.filter((c) => c.isLive).map((c) => c.channelType),
        messagingGroups: s.channels.reduce((n, c) => n + c.groups.length, 0),
        byType: Object.fromEntries(s.channels.map((c) => [c.channelType, c.groups.length])),
      },
      users: {
        total: s.users.length,
        owners: s.users.filter((u) => u.privilege === 'owner').length,
        globalAdmins: s.users.filter((u) => u.privilege === 'global_admin').length,
      },
      lastUpdated: getLastUpdated(),
    });
  }

  if (method === 'GET' && urlPath === '/api/activity') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, { buckets: s.activity });
  }

  if (method === 'GET' && urlPath === '/api/agent-groups') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.agent_groups);
  }

  if (method === 'GET' && urlPath.match(/^\/api\/agent-groups\/[^/]+\/config$/)) {
    const id = decodeURIComponent(urlPath.split('/')[3]);
    const groups = getAllAgentGroups();
    const group = groups.find((g) => g.id === id);
    if (!group) return json(res, { error: 'Not found' }, 404);

    // Path traversal guard
    const groupDir = path.resolve(GROUPS_DIR, group.folder);
    if (!groupDir.startsWith(path.resolve(GROUPS_DIR) + path.sep)) {
      return json(res, { error: 'Invalid folder' }, 403);
    }

    // CLAUDE.md
    let claude_md: string | null = null;
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    try {
      if (fs.existsSync(claudeMdPath)) {
        claude_md = fs.readFileSync(claudeMdPath, 'utf-8');
      }
    } catch {
      // leave null
    }

    // container.json
    let container_json: unknown = null;
    const containerJsonPath = path.join(groupDir, 'container.json');
    try {
      if (fs.existsSync(containerJsonPath)) {
        container_json = JSON.parse(fs.readFileSync(containerJsonPath, 'utf-8'));
      }
    } catch {
      // leave null
    }

    // skills
    const skills: { name: string; size: number }[] = [];
    const skillsDir = path.join(groupDir, 'skills');
    try {
      if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
        for (const entry of fs.readdirSync(skillsDir)) {
          try {
            const skillPath = path.join(skillsDir, entry);
            const stat = fs.statSync(skillPath);
            skills.push({ name: entry, size: stat.size });
          } catch {
            // skip unreadable entries
          }
        }
      }
    } catch {
      // leave skills empty
    }

    return json(res, { claude_md, container_json, skills });
  }

  if (method === 'GET' && urlPath.startsWith('/api/agent-groups/')) {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    const id = urlPath.slice('/api/agent-groups/'.length);
    const group = s.agent_groups.find((g) => g.id === id);
    if (!group) return json(res, { error: 'Not found' }, 404);
    return json(res, {
      group,
      sessions: s.sessions.filter((x) => x.agent_group_id === id),
      wirings: group.wirings,
      destinations: group.destinations,
      members: group.members,
      admins: group.admins,
    });
  }

  if (method === 'GET' && urlPath === '/api/sessions') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.sessions);
  }

  if (method === 'GET' && urlPath === '/api/channels') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, {
      channels: s.channels,
      liveAdapters: s.channels.filter((c) => c.isLive).map((c) => c.channelType),
      registeredChannels: s.channels.filter((c) => c.isRegistered).map((c) => c.channelType),
    });
  }

  if (method === 'GET' && urlPath === '/api/messages') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    const agentGroupId = params.get('agentGroupId');
    const sessionId = params.get('sessionId');
    if (!agentGroupId || !sessionId)
      return json(res, { error: 'agentGroupId and sessionId required', inbound: [], outbound: [] });

    const msgs = s.messages;
    const match = msgs?.find((m) => m.agentGroupId === agentGroupId && m.sessionId === sessionId);
    return json(res, match || { inbound: [], outbound: [] });
  }

  if (method === 'GET' && urlPath === '/api/users') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.users);
  }

  if (method === 'GET' && urlPath === '/api/tokens/summary') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.tokens);
  }

  if (method === 'GET' && urlPath === '/api/context') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, { sessions: s.context_windows });
  }

  if (method === 'GET' && urlPath === '/api/host-health') {
    if (!s || !s.host_health) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.host_health);
  }

  if (method === 'GET' && urlPath.startsWith('/api/containers/') && urlPath.endsWith('/logs')) {
    const sessionId = decodeURIComponent(urlPath.slice('/api/containers/'.length, -'/logs'.length));
    // Only allow fetching logs for containers tracked in the active map (security allowlist)
    const entries = getActiveContainerEntries();
    const entry = entries.find((e) => e.sessionId === sessionId);
    if (!entry) return json(res, { error: 'Container not found or not running' }, 404);

    const rawTail = parseInt(params.get('tail') ?? '100', 10);
    const tail = isNaN(rawTail) || rawTail <= 0 ? 100 : Math.min(rawTail, 1000);

    try {
      const { stdout, stderr } = await execFileAsync('docker', [
        'logs',
        '--tail',
        String(tail),
        '--timestamps',
        entry.containerName,
      ]);
      const combined = (stdout + stderr)
        .split('\n')
        .filter((l) => l.length > 0);
      return json(res, { lines: combined });
    } catch (err) {
      return json(res, { error: String(err) }, 500);
    }
  }

  if (method === 'GET' && urlPath === '/api/containers') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.containers || []);
  }

  if (method === 'GET' && urlPath === '/api/errors') {
    const logFile = path.resolve(process.cwd(), 'logs', 'nanoclaw.error.log');
    try {
      if (!fs.existsSync(logFile)) return json(res, []);
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content
        .split('\n')
        .filter((l) => l.trim())
        .slice(-200)
        .reverse();
      const entries = lines.map((line) => {
        const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(\w+)\s+(.*)/);
        if (match) return { timestamp: match[1], level: match[2], message: match[3] };
        return { timestamp: '', level: 'raw', message: line };
      });
      return json(res, entries);
    } catch {
      return json(res, []);
    }
  }

  if (method === 'GET' && urlPath === '/api/credentials') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.credentials || { available: false, agents: [], secrets: [] });
  }

  if (method === 'GET' && urlPath === '/api/audit/senders') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.unregistered_senders || []);
  }

  if (method === 'GET' && urlPath === '/api/audit/approvals') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.pending_approvals || []);
  }

  if (method === 'GET' && urlPath === '/api/audit/questions') {
    if (!s) return json(res, { error: 'No data yet' }, 503);
    return json(res, s.pending_questions || []);
  }

  // Tasks — live read (queries session DBs directly, not from snapshot)
  if (method === 'GET' && urlPath === '/api/tasks') {
    const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
    const groups = getAllAgentGroups();
    const groupMap = new Map(groups.map((g) => [g.id, g.name]));
    return json(res, scanScheduledTasks(sessionsDir, groupMap));
  }

  // Task mutations — pause/resume/cancel
  if (method === 'POST' && urlPath.match(/^\/api\/tasks\/[^/]+\/(pause|resume|cancel)$/)) {
    const parts = urlPath.split('/');
    const taskId = decodeURIComponent(parts[3]);
    const action = parts[4];

    const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
    const found = findTaskSession(sessionsDir, taskId);
    if (!found) return json(res, { error: 'Task not found' }, 404);

    const db = new Database(found.dbPath);
    try {
      if (action === 'pause') pauseTask(db, taskId);
      else if (action === 'resume') resumeTask(db, taskId);
      else if (action === 'cancel') cancelTask(db, taskId);
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: String(err) }, 500);
    } finally {
      db.close();
    }
  }

  // Token rotation
  if (method === 'POST' && urlPath === '/api/token/rotate') {
    const newToken = crypto.randomBytes(32).toString('hex');
    setDashboardSecret(newToken);
    const envPath = path.join(process.cwd(), '.env');
    try {
      updateEnvSecret(envPath, 'DASHBOARD_SECRET', newToken);
    } catch {
      // .env write failure is non-fatal — in-memory secret is already updated
    }
    return json(res, { ok: true, token: newToken });
  }

  // Settings API — runtime config + .env viewer
  if (method === 'GET' && urlPath === '/api/settings') {
    const envPath = path.join(process.cwd(), '.env');
    let envKeys: Record<string, string> = {};
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      envKeys = redactEnvKeys(parseAllEnvKeys(content));
    } catch {
      // .env not found — return empty
    }

    return json(res, {
      runtimeConfig: {
        assistantName: ASSISTANT_NAME,
        dashboardPort: process.env.DASHBOARD_PORT || '3100',
        containerInstallLabel: CONTAINER_INSTALL_LABEL,
        onecliUrl: ONECLI_URL || null,
        dataDir: DATA_DIR,
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
      },
      envKeys,
    });
  }

  // --- HTML pages ---
  if (method === 'GET') {
    if (urlPath === '/dashboard') return html(res, overviewPage());
    if (urlPath === '/dashboard/host-health') return html(res, hostHealthPage());
    if (urlPath === '/dashboard/containers') return html(res, containersPage());
    if (urlPath.startsWith('/dashboard/agent-groups')) return html(res, agentGroupsPage());
    if (urlPath === '/dashboard/sessions') return html(res, sessionsPage());
    if (urlPath === '/dashboard/channels') return html(res, channelsPage());
    if (urlPath.startsWith('/dashboard/messages')) return html(res, messagesPage());
    if (urlPath === '/dashboard/users') return html(res, usersPage());
    if (urlPath === '/dashboard/logs') return html(res, logsPage());
    if (urlPath === '/dashboard/tasks') return html(res, tasksPage());
    if (urlPath === '/dashboard/credentials') return html(res, credentialsPage());
    if (urlPath === '/dashboard/errors') return html(res, errorsPage());
    if (urlPath === '/dashboard/audit') return html(res, auditPage());
    if (urlPath === '/dashboard/settings') return html(res, settingsPage());

    if (urlPath === '/') {
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
