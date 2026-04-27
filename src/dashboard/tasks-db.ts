/**
 * Task scanning + session resolution for the dashboard.
 * Used by both the pusher (periodic snapshot) and the router (live reads + mutations).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import type { ScheduledTask } from './types.js';

interface TaskRow {
  id: string;
  series_id: string;
  status: string;
  content: string;
  recurrence: string | null;
  process_after: string | null;
  tries: number;
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
            "SELECT id, series_id, status, content, recurrence, process_after, tries FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused', 'processing') ORDER BY process_after ASC",
          )
          .all() as TaskRow[];

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
