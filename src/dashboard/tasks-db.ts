/**
 * Task scanning + session resolution for the dashboard.
 * Used by both the pusher (periodic snapshot) and the router (live reads + mutations).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import type { ScheduledTask, TaskDetail, TaskRun } from './types.js';

interface TaskRow {
  id: string;
  series_id: string;
  status: string;
  content: string;
  recurrence: string | null;
  process_after: string | null;
  tries: number;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

interface TaskHistoryRow {
  id: string;
  timestamp: string;
  status: string;
  tries: number;
  process_after: string | null;
}

/**
 * Scan all session inbound.db files for scheduled tasks.
 */
export function scanScheduledTasks(sessionsDir: string, groupMap: Map<string, string>): ScheduledTask[] {
  if (!fs.existsSync(sessionsDir)) return [];

  const tasks: ScheduledTask[] = [];

  for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
    const agPath = path.join(sessionsDir, agDir);
    let sessDirs: string[];
    try {
      sessDirs = fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'));
    } catch {
      continue;
    }

    for (const sessDir of sessDirs) {
      const dbPath = path.join(agPath, sessDir, 'inbound.db');
      if (!fs.existsSync(dbPath)) continue;

      try {
        const db = new Database(dbPath, { readonly: true });
        const rows = db
          .prepare(
            `SELECT id, series_id, status, content, recurrence, process_after, tries, channel_type, platform_id, thread_id,
               (SELECT COUNT(*) FROM messages_in m2 WHERE m2.series_id = messages_in.series_id AND m2.status IN ('completed', 'failed')) AS total_runs
             FROM messages_in
             WHERE kind = 'task' AND status IN ('pending', 'paused', 'processing')
             ORDER BY process_after ASC`,
          )
          .all() as (TaskRow & { total_runs: number })[];

        for (const row of rows) {
          let promptSummary = '';
          try {
            const parsed = JSON.parse(row.content) as { prompt?: string };
            promptSummary = (parsed.prompt || JSON.stringify(parsed)).slice(0, 200);
          } catch {
            promptSummary = row.content.slice(0, 200);
          }

          let lastCompleted: string | null = null;
          try {
            const completed = db
              .prepare(
                "SELECT timestamp FROM messages_in WHERE series_id = ? AND status = 'completed' ORDER BY timestamp DESC LIMIT 1",
              )
              .get(row.series_id) as { timestamp: string } | undefined;
            lastCompleted = completed?.timestamp || null;
          } catch {
            /* skip */
          }

          tasks.push({
            id: row.id,
            session_id: sessDir,
            agent_group_id: agDir,
            agent_group_name: groupMap.get(agDir) || agDir,
            series_id: row.series_id,
            status: row.status,
            prompt_summary: promptSummary,
            recurrence: row.recurrence || undefined,
            recurrence_human: row.recurrence ? cronToHuman(row.recurrence) : undefined,
            process_after: row.process_after || undefined,
            last_completed: lastCompleted || undefined,
            tries: row.tries,
            channel_type: row.channel_type || undefined,
            platform_id: row.platform_id || undefined,
            total_runs: (row as TaskRow & { total_runs: number }).total_runs,
          });
        }
        db.close();
      } catch {
        /* skip locked or missing DBs */
      }
    }
  }

  return tasks;
}

/**
 * Find which session DB contains a given task ID.
 * Matches by id OR series_id so recurring task series resolve correctly.
 * Returns the dbPath if found, null otherwise.
 */
export function findTaskSession(sessionsDir: string, taskId: string): { dbPath: string } | null {
  if (!fs.existsSync(sessionsDir)) return null;

  for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
    const agPath = path.join(sessionsDir, agDir);
    let sessDirs: string[];
    try {
      sessDirs = fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'));
    } catch {
      continue;
    }

    for (const sessDir of sessDirs) {
      const dbPath = path.join(agPath, sessDir, 'inbound.db');
      if (!fs.existsSync(dbPath)) continue;

      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare("SELECT id FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task' LIMIT 1")
          .get(taskId, taskId) as { id: string } | undefined;
        db.close();
        if (row) return { dbPath };
      } catch {
        /* skip locked or missing DBs */
      }
    }
  }

  return null;
}

/**
 * Get full detail for a single task, including run history and metrics.
 * Scans all session DBs for the task by id, then computes metrics from the series.
 */
export function getTaskDetail(sessionsDir: string, taskId: string, groupMap: Map<string, string>): TaskDetail | null {
  if (!fs.existsSync(sessionsDir)) return null;

  for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
    const agPath = path.join(sessionsDir, agDir);
    let sessDirs: string[];
    try {
      sessDirs = fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'));
    } catch {
      continue;
    }

    for (const sessDir of sessDirs) {
      const dbPath = path.join(agPath, sessDir, 'inbound.db');
      if (!fs.existsSync(dbPath)) continue;

      try {
        const db = new Database(dbPath, { readonly: true });

        // Find the live row by exact id
        const liveRow = db
          .prepare(
            "SELECT id, series_id, status, content, recurrence, process_after, tries, channel_type, platform_id, thread_id FROM messages_in WHERE id = ? AND kind = 'task' LIMIT 1",
          )
          .get(taskId) as TaskRow | undefined;

        if (!liveRow) {
          db.close();
          continue;
        }

        // Metrics from historical rows sharing the same series_id
        const totalRunsRow = db
          .prepare(
            "SELECT COUNT(*) AS count FROM messages_in WHERE series_id = ? AND status IN ('completed', 'failed')",
          )
          .get(liveRow.series_id) as { count: number };

        const successfulRunsRow = db
          .prepare("SELECT COUNT(*) AS count FROM messages_in WHERE series_id = ? AND status = 'completed'")
          .get(liveRow.series_id) as { count: number };

        const failedRunsRow = db
          .prepare("SELECT COUNT(*) AS count FROM messages_in WHERE series_id = ? AND status = 'failed'")
          .get(liveRow.series_id) as { count: number };

        const lastRunRow = db
          .prepare(
            "SELECT timestamp FROM messages_in WHERE series_id = ? AND status IN ('completed', 'failed') ORDER BY timestamp DESC LIMIT 1",
          )
          .get(liveRow.series_id) as { timestamp: string } | undefined;

        // Historical run rows ordered newest first
        const historyRows = db
          .prepare(
            "SELECT id, timestamp, status, tries, process_after FROM messages_in WHERE series_id = ? AND status IN ('completed', 'failed') ORDER BY timestamp DESC",
          )
          .all(liveRow.series_id) as TaskHistoryRow[];

        db.close();

        // Extract prompt from content JSON (full, not truncated)
        let prompt = '';
        try {
          const parsed = JSON.parse(liveRow.content) as { prompt?: string };
          prompt = parsed.prompt || JSON.stringify(parsed);
        } catch {
          prompt = liveRow.content;
        }

        const runs: TaskRun[] = historyRows.map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          status: r.status,
          tries: r.tries,
          process_after: r.process_after || undefined,
        }));

        return {
          id: liveRow.id,
          session_id: sessDir,
          agent_group_id: agDir,
          agent_group_name: groupMap.get(agDir) || agDir,
          series_id: liveRow.series_id,
          status: liveRow.status,
          prompt,
          recurrence: liveRow.recurrence || undefined,
          recurrence_human: liveRow.recurrence ? cronToHuman(liveRow.recurrence) : undefined,
          process_after: liveRow.process_after || undefined,
          channel_type: liveRow.channel_type || undefined,
          platform_id: liveRow.platform_id || undefined,
          thread_id: liveRow.thread_id || undefined,
          total_runs: totalRunsRow.count,
          successful_runs: successfulRunsRow.count,
          failed_runs: failedRunsRow.count,
          last_run: lastRunRow?.timestamp || undefined,
          runs,
        };
      } catch {
        /* skip locked or missing DBs */
      }
    }
  }

  return null;
}

/**
 * Update channel routing fields for a task.
 * Only applies when status is 'pending' or 'paused' (task is not in flight).
 * Returns the number of rows updated (0 if the guard rejected the update).
 */
export function updateTaskChannel(
  db: Database.Database,
  taskId: string,
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
): number {
  const result = db
    .prepare(
      "UPDATE messages_in SET channel_type = ?, platform_id = ?, thread_id = ? WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run(channelType, platformId, threadId, taskId);
  return result.changes;
}

/**
 * Convert a cron expression to a human-readable string.
 */
export function cronToHuman(cron: string): string {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  if (dom === '*' && mon === '*' && dow === '*') {
    if (hour === '*') return min === '0' ? 'every hour' : 'every hour at :' + min.padStart(2, '0');
    if (min === '0') return 'daily at ' + hour + ':00';
    return 'daily at ' + hour + ':' + min.padStart(2, '0');
  }
  if (hour.includes('/')) return 'every ' + hour.split('/')[1] + ' hours';
  if (min.includes('/')) return 'every ' + min.split('/')[1] + ' minutes';
  return cron;
}
