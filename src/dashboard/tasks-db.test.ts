/**
 * Tests for dashboard task DB helpers: getTaskDetail, updateTaskChannel,
 * and the extended scanScheduledTasks (channel info + total_runs metrics).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ensureSchema, openInboundDb } from '../db/session-db.js';
import { insertTask, insertRecurrence, type RecurringMessage } from '../modules/scheduling/db.js';
import { getTaskDetail, updateTaskChannel, scanScheduledTasks } from './tasks-db.js';

let tmpDir: string;

/**
 * Creates a realistic sessions directory layout under tmpDir:
 *   <tmpDir>/ag-<agId>/sess-<sessId>/inbound.db
 * Returns the path to the created inbound.db.
 */
function createSessionDb(agId: string, sessId: string): { dbPath: string; sessionsDir: string } {
  const sessionsDir = tmpDir;
  const sessPath = path.join(sessionsDir, agId, sessId);
  fs.mkdirSync(sessPath, { recursive: true });
  const dbPath = path.join(sessPath, 'inbound.db');
  ensureSchema(dbPath, 'inbound');
  return { dbPath, sessionsDir };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tasks-test-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// updateTaskChannel
// ---------------------------------------------------------------------------
describe('updateTaskChannel', () => {
  it('updates channel fields on a pending task', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-001');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'hello' }),
    });

    const changed = updateTaskChannel(db, 'task-1', 'discord', 'C123', 'T456');
    expect(changed).toBe(1);

    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE id = ?').get('task-1') as {
      channel_type: string;
      platform_id: string;
      thread_id: string;
    };
    expect(row.channel_type).toBe('discord');
    expect(row.platform_id).toBe('C123');
    expect(row.thread_id).toBe('T456');
    db.close();
  });

  it('updates channel fields on a paused task', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-002');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-2',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'paused task' }),
    });
    db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = 'task-2'").run();

    const changed = updateTaskChannel(db, 'task-2', 'slack', 'S999', null);
    expect(changed).toBe(1);
    db.close();
  });

  it('returns 0 and does not update a processing task', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-003');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-3',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: 'old-platform',
      channelType: 'old-channel',
      threadId: null,
      content: JSON.stringify({ prompt: 'in flight' }),
    });
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'task-3'").run();

    const changed = updateTaskChannel(db, 'task-3', 'discord', 'NEW', null);
    expect(changed).toBe(0);

    const row = db.prepare('SELECT channel_type FROM messages_in WHERE id = ?').get('task-3') as {
      channel_type: string;
    };
    expect(row.channel_type).toBe('old-channel');
    db.close();
  });

  it('returns 0 and does not update a completed task', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-004');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-4',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'done' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-4'").run();

    const changed = updateTaskChannel(db, 'task-4', 'discord', 'X', null);
    expect(changed).toBe(0);
    db.close();
  });

  it('returns 0 for a non-existent task', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-005');
    const db = openInboundDb(dbPath);
    const changed = updateTaskChannel(db, 'no-such-task', 'discord', 'X', null);
    expect(changed).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// getTaskDetail — metrics
// ---------------------------------------------------------------------------
describe('getTaskDetail', () => {
  it('returns null for a missing sessionsDir', () => {
    const detail = getTaskDetail('/no/such/path', 'task-1', new Map());
    expect(detail).toBeNull();
  });

  it('returns null when the task does not exist', () => {
    createSessionDb('ag-001', 'sess-001');
    const detail = getTaskDetail(tmpDir, 'no-such-task', new Map());
    expect(detail).toBeNull();
  });

  it('returns detail with zero runs for a brand-new task', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-001');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-new',
      processAfter: '2026-05-01T09:00:00Z',
      recurrence: '0 9 * * *',
      platformId: 'discord:C1',
      channelType: 'discord',
      threadId: 'T1',
      content: JSON.stringify({ prompt: 'full prompt text here' }),
    });
    db.close();

    const groupMap = new Map([['ag-001', 'My Group']]);
    const detail = getTaskDetail(tmpDir, 'task-new', groupMap);

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('task-new');
    expect(detail!.agent_group_id).toBe('ag-001');
    expect(detail!.agent_group_name).toBe('My Group');
    expect(detail!.series_id).toBe('task-new');
    expect(detail!.status).toBe('pending');
    expect(detail!.prompt).toBe('full prompt text here');
    expect(detail!.channel_type).toBe('discord');
    expect(detail!.platform_id).toBe('discord:C1');
    expect(detail!.thread_id).toBe('T1');
    expect(detail!.recurrence).toBe('0 9 * * *');
    expect(detail!.recurrence_human).toBe('daily at 9:00');
    expect(detail!.total_runs).toBe(0);
    expect(detail!.successful_runs).toBe(0);
    expect(detail!.failed_runs).toBe(0);
    expect(detail!.last_run).toBeUndefined();
    expect(detail!.runs).toHaveLength(0);
  });

  it('computes total_runs, successful_runs, failed_runs from completed/failed history', () => {
    const { dbPath } = createSessionDb('ag-002', 'sess-001');
    const db = openInboundDb(dbPath);

    // Seed original (completed)
    insertTask(db, {
      id: 'task-orig',
      processAfter: '2026-01-01T09:00:00Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'recurring task' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    // Seed a failed recurrence (series_id = 'task-orig')
    const base: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: JSON.stringify({ prompt: 'recurring task' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, base, 'task-run2', '2026-01-02T09:00:00Z');
    db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = 'task-run2'").run();

    // Live pending row (the current occurrence)
    insertRecurrence(db, base, 'task-live', '2026-01-03T09:00:00Z');

    db.close();

    const groupMap = new Map([['ag-002', 'Group 2']]);
    const detail = getTaskDetail(tmpDir, 'task-live', groupMap);

    expect(detail).not.toBeNull();
    expect(detail!.total_runs).toBe(2); // completed + failed
    expect(detail!.successful_runs).toBe(1);
    expect(detail!.failed_runs).toBe(1);
    expect(detail!.runs).toHaveLength(2);
    expect(detail!.runs[0].status).toMatch(/completed|failed/);
  });

  it('last_run reflects the most recent completed/failed timestamp', () => {
    const { dbPath } = createSessionDb('ag-003', 'sess-001');
    const db = openInboundDb(dbPath);

    insertTask(db, {
      id: 'task-a',
      processAfter: '2026-01-01T09:00:00Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'p' }),
    });
    // Force a specific timestamp on the completed original
    db.prepare(
      "UPDATE messages_in SET status = 'completed', timestamp = '2026-03-01T09:00:00' WHERE id = 'task-a'",
    ).run();

    const base: RecurringMessage = {
      id: 'task-a',
      kind: 'task',
      content: JSON.stringify({ prompt: 'p' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-a',
    };
    insertRecurrence(db, base, 'task-b', '2026-03-02T09:00:00Z');
    db.prepare(
      "UPDATE messages_in SET status = 'completed', timestamp = '2026-03-02T09:00:00' WHERE id = 'task-b'",
    ).run();

    // Live row
    insertRecurrence(db, base, 'task-live', '2026-03-03T09:00:00Z');
    db.close();

    const detail = getTaskDetail(tmpDir, 'task-live', new Map());
    expect(detail!.last_run).toBe('2026-03-02T09:00:00');
  });

  it('returns full prompt (not truncated)', () => {
    const { dbPath } = createSessionDb('ag-004', 'sess-001');
    const db = openInboundDb(dbPath);
    const longPrompt = 'x'.repeat(500);
    insertTask(db, {
      id: 'task-long',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: longPrompt }),
    });
    db.close();

    const detail = getTaskDetail(tmpDir, 'task-long', new Map());
    expect(detail!.prompt).toHaveLength(500);
    expect(detail!.prompt).toBe(longPrompt);
  });

  it('does not count the live pending row in total_runs', () => {
    const { dbPath } = createSessionDb('ag-005', 'sess-001');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-only',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'once' }),
    });
    db.close();

    const detail = getTaskDetail(tmpDir, 'task-only', new Map());
    expect(detail!.total_runs).toBe(0);
    expect(detail!.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanScheduledTasks — channel info + total_runs
// ---------------------------------------------------------------------------
describe('scanScheduledTasks', () => {
  it('returns empty array when sessionsDir does not exist', () => {
    const tasks = scanScheduledTasks('/no/such/path', new Map());
    expect(tasks).toEqual([]);
  });

  it('returns empty array when no task rows exist', () => {
    createSessionDb('ag-001', 'sess-001'); // creates the schema but no tasks
    const tasks = scanScheduledTasks(tmpDir, new Map());
    expect(tasks).toEqual([]);
  });

  it('includes channel_type, platform_id, and total_runs in scan results', () => {
    const { dbPath } = createSessionDb('ag-001', 'sess-001');
    const db = openInboundDb(dbPath);

    insertTask(db, {
      id: 'task-scan',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: 'C123',
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ prompt: 'scan me' }),
    });
    db.close();

    const groupMap = new Map([['ag-001', 'Group One']]);
    const tasks = scanScheduledTasks(tmpDir, groupMap);

    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.id).toBe('task-scan');
    expect(t.channel_type).toBe('discord');
    expect(t.platform_id).toBe('C123');
    expect(t.total_runs).toBe(0);
    expect(t.agent_group_name).toBe('Group One');
  });

  it('computes total_runs correctly in scan', () => {
    const { dbPath } = createSessionDb('ag-002', 'sess-001');
    const db = openInboundDb(dbPath);

    insertTask(db, {
      id: 'task-series',
      processAfter: '2026-01-01T09:00:00Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'recurring' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-series'").run();

    const base: RecurringMessage = {
      id: 'task-series',
      kind: 'task',
      content: JSON.stringify({ prompt: 'recurring' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-series',
    };
    // Two completed recurrences
    insertRecurrence(db, base, 'task-r2', '2026-01-02T09:00:00Z');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-r2'").run();
    insertRecurrence(db, base, 'task-r3', '2026-01-03T09:00:00Z');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-r3'").run();

    // Live pending row
    insertRecurrence(db, base, 'task-live', '2026-01-04T09:00:00Z');
    db.close();

    const tasks = scanScheduledTasks(tmpDir, new Map());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-live');
    expect(tasks[0].total_runs).toBe(3); // 3 completed historical rows
  });

  it('truncates prompt_summary to 200 chars in scan results', () => {
    const { dbPath } = createSessionDb('ag-003', 'sess-001');
    const db = openInboundDb(dbPath);
    insertTask(db, {
      id: 'task-trunc',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'y'.repeat(400) }),
    });
    db.close();

    const tasks = scanScheduledTasks(tmpDir, new Map());
    expect(tasks[0].prompt_summary).toHaveLength(200);
  });
});
