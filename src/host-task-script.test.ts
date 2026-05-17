import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyHostPreTaskScripts } from './host-task-script.js';

function createInMemoryDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER, kind TEXT DEFAULT 'chat',
      timestamp TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'pending',
      process_after TEXT, recurrence TEXT, tries INTEGER DEFAULT 0,
      trigger INTEGER DEFAULT 1, platform_id TEXT, channel_type TEXT,
      thread_id TEXT, content TEXT, on_wake INTEGER DEFAULT 0,
      series_id TEXT
    );
    CREATE TABLE processing_ack (
      message_id TEXT PRIMARY KEY, status TEXT, status_changed TEXT
    );
  `);
  return db;
}

describe('applyHostPreTaskScripts', () => {
  test('non-task messages pass through unchanged', async () => {
    const db = createInMemoryDb();
    db.exec(`INSERT INTO messages_in (id, seq, kind, content) VALUES ('m1', 2, 'chat', '{"text":"hello"}')`);
    const rows = db.prepare("SELECT * FROM messages_in WHERE id = 'm1'").all() as any[];

    const result = await applyHostPreTaskScripts(db, rows);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('m1');
    db.close();
  });

  test('task without script passes through', async () => {
    const db = createInMemoryDb();
    db.exec(`INSERT INTO messages_in (id, seq, kind, content) VALUES ('t1', 2, 'task', '{"prompt":"check stuff"}')`);
    const rows = db.prepare("SELECT * FROM messages_in WHERE id = 't1'").all() as any[];

    const result = await applyHostPreTaskScripts(db, rows);
    expect(result.length).toBe(1);
    db.close();
  });

  test('task with wakeAgent=true script is kept and enriched', async () => {
    const db = createInMemoryDb();
    const content = JSON.stringify({ prompt: 'check', script: 'echo \'{"wakeAgent":true,"data":{"cpu":42}}\'' });
    db.prepare("INSERT INTO messages_in (id, seq, kind, content) VALUES ('t2', 2, 'task', ?)").run(content);
    const rows = db.prepare("SELECT * FROM messages_in WHERE id = 't2'").all() as any[];

    const result = await applyHostPreTaskScripts(db, rows);
    expect(result.length).toBe(1);
    const parsed = JSON.parse(result[0].content);
    expect(parsed.scriptOutput).toEqual({ cpu: 42 });
    db.close();
  });

  test('task with wakeAgent=false script is suppressed', async () => {
    const db = createInMemoryDb();
    const content = JSON.stringify({ prompt: 'check', script: 'echo \'{"wakeAgent":false}\'' });
    db.prepare("INSERT INTO messages_in (id, seq, kind, content) VALUES ('t3', 2, 'task', ?)").run(content);
    const rows = db.prepare("SELECT * FROM messages_in WHERE id = 't3'").all() as any[];

    const result = await applyHostPreTaskScripts(db, rows);
    expect(result.length).toBe(0);

    const status = db.prepare("SELECT status FROM messages_in WHERE id = 't3'").get() as any;
    expect(status.status).toBe('completed');
    db.close();
  });

  test('script error suppresses task', async () => {
    const db = createInMemoryDb();
    const content = JSON.stringify({ prompt: 'check', script: 'exit 1' });
    db.prepare("INSERT INTO messages_in (id, seq, kind, content) VALUES ('t4', 2, 'task', ?)").run(content);
    const rows = db.prepare("SELECT * FROM messages_in WHERE id = 't4'").all() as any[];

    const result = await applyHostPreTaskScripts(db, rows);
    expect(result.length).toBe(0);

    const status = db.prepare("SELECT status FROM messages_in WHERE id = 't4'").get() as any;
    expect(status.status).toBe('completed');
    db.close();
  });

  test('sequential execution preserves order', async () => {
    const db = createInMemoryDb();
    const c1 = JSON.stringify({ prompt: 'first', script: 'echo \'{"wakeAgent":true,"data":"a"}\'' });
    const c2 = JSON.stringify({ prompt: 'second', script: 'echo \'{"wakeAgent":true,"data":"b"}\'' });
    db.prepare("INSERT INTO messages_in (id, seq, kind, content) VALUES ('s1', 2, 'task', ?)").run(c1);
    db.prepare("INSERT INTO messages_in (id, seq, kind, content) VALUES ('s2', 4, 'task', ?)").run(c2);
    const rows = db.prepare("SELECT * FROM messages_in ORDER BY seq").all() as any[];

    const result = await applyHostPreTaskScripts(db, rows);
    expect(result.length).toBe(2);
    expect(JSON.parse(result[0].content).scriptOutput).toBe('a');
    expect(JSON.parse(result[1].content).scriptOutput).toBe('b');
    db.close();
  });
});
