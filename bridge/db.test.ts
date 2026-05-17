import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function seedInboundDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER, kind TEXT NOT NULL DEFAULT 'chat',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      process_after TEXT, recurrence TEXT, tries INTEGER NOT NULL DEFAULT 0,
      trigger INTEGER NOT NULL DEFAULT 1, on_wake INTEGER NOT NULL DEFAULT 0,
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name TEXT PRIMARY KEY, display_name TEXT, type TEXT NOT NULL,
      channel_type TEXT, platform_id TEXT, agent_group_id TEXT
    );
    CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT, platform_id TEXT, thread_id TEXT
    );
  `);
  return db;
}

function seedOutboundDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec(`
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
  return db;
}

describe('bridge/db', () => {
  let dir: string;
  let inDb: Database;
  let outDb: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    inDb = seedInboundDb(join(dir, 'inbound.db'));
    outDb = seedOutboundDb(join(dir, 'outbound.db'));
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, content, trigger) VALUES ('msg-1', 2, 'chat', '{"text":"hello"}', 1)`,
      )
      .run();
    inDb
      .prepare(`INSERT INTO destinations (name, type, channel_type, platform_id) VALUES ('default', 'channel', 'slack', 'C123')`)
      .run();
    inDb.prepare(`INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'C123', NULL)`).run();
  });

  afterEach(() => {
    inDb.close();
    outDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('getPendingMessages returns unacked messages', async () => {
    const { getPendingMessages } = await import('./db.ts');
    const msgs = getPendingMessages(dir, false);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('msg-1');
  });

  test('getPendingMessages filters acked messages', async () => {
    outDb.prepare(`INSERT INTO processing_ack (message_id, status) VALUES ('msg-1', 'processing')`).run();
    const { getPendingMessages } = await import('./db.ts');
    const msgs = getPendingMessages(dir, false);
    expect(msgs).toHaveLength(0);
  });

  test('getPendingMessages respects on_wake on first poll', async () => {
    inDb.prepare(`INSERT INTO messages_in (id, seq, kind, content, trigger, on_wake) VALUES ('wake-1', 4, 'chat', '{"text":"wake"}', 1, 1)`).run();
    const { getPendingMessages } = await import('./db.ts');
    const normal = getPendingMessages(dir, false);
    expect(normal.map((m) => m.id)).not.toContain('wake-1');
    const first = getPendingMessages(dir, true);
    expect(first.map((m) => m.id)).toContain('wake-1');
  });

  test('markProcessing writes to processing_ack', async () => {
    const { markProcessing } = await import('./db.ts');
    markProcessing(dir, ['msg-1']);
    const row = outDb.prepare('SELECT * FROM processing_ack WHERE message_id = ?').get('msg-1') as any;
    expect(row).toBeTruthy();
    expect(row.status).toBe('processing');
  });

  test('markCompleted updates processing_ack', async () => {
    const { markProcessing, markCompleted } = await import('./db.ts');
    markProcessing(dir, ['msg-1']);
    markCompleted(dir, ['msg-1']);
    const row = outDb.prepare('SELECT * FROM processing_ack WHERE message_id = ?').get('msg-1') as any;
    expect(row.status).toBe('completed');
  });

  test('writeMessageOut assigns odd seq', async () => {
    const { writeMessageOut } = await import('./db.ts');
    const seq = writeMessageOut(dir, {
      id: 'out-1',
      kind: 'chat',
      content: '{"text":"reply"}',
      platform_id: 'C123',
      channel_type: 'slack',
    });
    expect(seq % 2).toBe(1);
    const row = outDb.prepare('SELECT * FROM messages_out WHERE id = ?').get('out-1') as any;
    expect(row).toBeTruthy();
    expect(row.content).toBe('{"text":"reply"}');
    expect(row.seq).toBe(seq);
  });

  test('writeMessageOut respects existing seq parity', async () => {
    inDb.prepare(`UPDATE messages_in SET seq = 10 WHERE id = 'msg-1'`).run();
    const { writeMessageOut } = await import('./db.ts');
    const seq = writeMessageOut(dir, {
      id: 'out-2',
      kind: 'chat',
      content: '{"text":"second"}',
    });
    expect(seq).toBe(11);
    expect(seq % 2).toBe(1);
  });

  test('touchHeartbeat creates file', async () => {
    const { touchHeartbeat } = await import('./db.ts');
    const hbPath = join(dir, '.heartbeat');
    touchHeartbeat(hbPath);
    expect(existsSync(hbPath)).toBe(true);
  });

  test('getAllDestinations returns seeded destinations', async () => {
    const { getAllDestinations } = await import('./db.ts');
    const dests = getAllDestinations(dir);
    expect(dests).toHaveLength(1);
    expect(dests[0].name).toBe('default');
    expect(dests[0].type).toBe('channel');
    expect(dests[0].channelType).toBe('slack');
  });

  test('findDestination returns match', async () => {
    const { findDestination } = await import('./db.ts');
    const d = findDestination(dir, 'default');
    expect(d).toBeTruthy();
    expect(d!.platformId).toBe('C123');
  });

  test('findDestination returns undefined for unknown', async () => {
    const { findDestination } = await import('./db.ts');
    expect(findDestination(dir, 'nonexistent')).toBeUndefined();
  });

  test('getSessionRouting returns seeded routing', async () => {
    const { getSessionRouting } = await import('./db.ts');
    const r = getSessionRouting(dir);
    expect(r.channel_type).toBe('slack');
    expect(r.platform_id).toBe('C123');
    expect(r.thread_id).toBeNull();
  });

  test('getPendingMessages filters system messages', async () => {
    inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, content, trigger) VALUES ('sys-1', 4, 'system', '{"type":"cli_response","requestId":"cli-123"}', 1)`,
    ).run();
    inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, content, trigger) VALUES ('task-1', 6, 'task', '{"prompt":"do stuff"}', 1)`,
    ).run();
    const { getPendingMessages } = await import('./db.ts');
    const msgs = getPendingMessages(dir, false);
    const kinds = msgs.map((m) => m.kind);
    expect(kinds).not.toContain('system');
    expect(kinds).toContain('chat');
    expect(kinds).toContain('task');
  });
});
