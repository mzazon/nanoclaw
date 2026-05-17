import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function setupSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-sched-'));
  const inDb = new Database(join(dir, 'inbound.db'));
  inDb.exec('PRAGMA journal_mode=DELETE');
  inDb.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER, kind TEXT NOT NULL DEFAULT 'chat',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      process_after TEXT, recurrence TEXT, tries INTEGER NOT NULL DEFAULT 0,
      trigger INTEGER NOT NULL DEFAULT 1, on_wake INTEGER NOT NULL DEFAULT 0,
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL,
      series_id TEXT
    );
    CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT, platform_id TEXT, thread_id TEXT
    );
    INSERT INTO session_routing VALUES (1, 'slack', 'C123', NULL);
    CREATE TABLE destinations (
      name TEXT PRIMARY KEY, display_name TEXT, type TEXT NOT NULL,
      channel_type TEXT, platform_id TEXT, agent_group_id TEXT
    );
  `);
  inDb.close();

  const outDb = new Database(join(dir, 'outbound.db'));
  outDb.exec('PRAGMA journal_mode=DELETE');
  outDb.exec(`
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, seq INTEGER, in_reply_to TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      deliver_after TEXT, recurrence TEXT, kind TEXT NOT NULL DEFAULT 'chat',
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id TEXT PRIMARY KEY, status TEXT NOT NULL,
      status_changed TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT);
  `);
  outDb.close();
  return dir;
}

describe('scheduling tools', () => {
  let dir: string;
  beforeEach(() => { dir = setupSessionDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('schedule_task writes system action to outbound', async () => {
    const { handleScheduleTask } = await import('./tools-scheduling.ts');
    const result = handleScheduleTask(dir, {
      prompt: 'check servers',
      processAfter: '2026-05-18T09:00:00Z',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Task scheduled');

    const outDb = new Database(join(dir, 'outbound.db'), { readonly: true });
    const row = outDb.prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as any;
    outDb.close();
    expect(row).toBeTruthy();
    const content = JSON.parse(row.content);
    expect(content.action).toBe('schedule_task');
    expect(content.prompt).toBe('check servers');
    expect(content.processAfter).toBe('2026-05-18T09:00:00.000Z');
    expect(row.seq % 2).toBe(1);
  });

  test('schedule_task converts naive timestamp to UTC', async () => {
    process.env.TZ = 'America/New_York';
    const { handleScheduleTask } = await import('./tools-scheduling.ts');
    const result = handleScheduleTask(dir, {
      prompt: 'morning check',
      processAfter: '2026-01-15T09:00:00',
    });
    expect(result.isError).toBeUndefined();

    const outDb = new Database(join(dir, 'outbound.db'), { readonly: true });
    const row = outDb.prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as any;
    outDb.close();
    const content = JSON.parse(row.content);
    expect(content.processAfter).toBe('2026-01-15T14:00:00.000Z');
    delete process.env.TZ;
  });

  test('list_tasks returns formatted list from inbound', async () => {
    const inDb = new Database(join(dir, 'inbound.db'));
    inDb.exec(`
      INSERT INTO messages_in (id, seq, kind, status, process_after, content, series_id)
        VALUES ('t1', 2, 'task', 'pending', '2026-05-18T09:00:00', '{"prompt":"check servers"}', 't1');
    `);
    inDb.close();

    const { handleListTasks } = await import('./tools-scheduling.ts');
    const result = handleListTasks(dir, {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('check servers');
    expect(result.content[0].text).toContain('t1');
  });

  test('list_tasks returns "No tasks" when empty', async () => {
    const { handleListTasks } = await import('./tools-scheduling.ts');
    const result = handleListTasks(dir, {});
    expect(result.content[0].text).toBe('No tasks found.');
  });

  test('cancel_task writes system action', async () => {
    const { handleCancelTask } = await import('./tools-scheduling.ts');
    const result = handleCancelTask(dir, { taskId: 'task-123' });
    expect(result.isError).toBeUndefined();

    const outDb = new Database(join(dir, 'outbound.db'), { readonly: true });
    const row = outDb.prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as any;
    outDb.close();
    const content = JSON.parse(row.content);
    expect(content.action).toBe('cancel_task');
    expect(content.taskId).toBe('task-123');
  });

  test('pause_task writes system action', async () => {
    const { handlePauseTask } = await import('./tools-scheduling.ts');
    const result = handlePauseTask(dir, { taskId: 'task-456' });
    expect(result.isError).toBeUndefined();

    const outDb = new Database(join(dir, 'outbound.db'), { readonly: true });
    const row = outDb.prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as any;
    outDb.close();
    const content = JSON.parse(row.content);
    expect(content.action).toBe('pause_task');
  });

  test('resume_task writes system action', async () => {
    const { handleResumeTask } = await import('./tools-scheduling.ts');
    const result = handleResumeTask(dir, { taskId: 'task-789' });
    expect(result.isError).toBeUndefined();

    const outDb = new Database(join(dir, 'outbound.db'), { readonly: true });
    const row = outDb.prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as any;
    outDb.close();
    const content = JSON.parse(row.content);
    expect(content.action).toBe('resume_task');
  });

  test('update_task writes partial update', async () => {
    const { handleUpdateTask } = await import('./tools-scheduling.ts');
    const result = handleUpdateTask(dir, { taskId: 'task-abc', prompt: 'new prompt' });
    expect(result.isError).toBeUndefined();

    const outDb = new Database(join(dir, 'outbound.db'), { readonly: true });
    const row = outDb.prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as any;
    outDb.close();
    const content = JSON.parse(row.content);
    expect(content.action).toBe('update_task');
    expect(content.prompt).toBe('new prompt');
    expect(content.taskId).toBe('task-abc');
  });

  test('update_task requires at least one field', async () => {
    const { handleUpdateTask } = await import('./tools-scheduling.ts');
    const result = handleUpdateTask(dir, { taskId: 'task-abc' });
    expect(result.isError).toBe(true);
  });

  test('schedule_task rejects invalid processAfter', async () => {
    const { handleScheduleTask } = await import('./tools-scheduling.ts');
    const result = handleScheduleTask(dir, { prompt: 'test', processAfter: 'garbage' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid processAfter');
  });
});
