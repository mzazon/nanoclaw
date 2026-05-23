import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveRouting, handleReply, handleSendFile, buildInstructions } from './tools.ts';

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

describe('bridge/tools', () => {
  let dir: string;
  let inDb: Database;
  let outDb: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-tools-'));
    inDb = seedInboundDb(join(dir, 'inbound.db'));
    outDb = seedOutboundDb(join(dir, 'outbound.db'));
    inDb.prepare(`INSERT INTO destinations (name, type, channel_type, platform_id) VALUES ('default', 'channel', 'slack', 'C123')`).run();
    inDb.prepare(`INSERT INTO destinations (name, display_name, type, channel_type, platform_id) VALUES ('ops', '#ops', 'channel', 'slack', 'C456')`).run();
    inDb.prepare(`INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'C123', NULL)`).run();
  });

  afterEach(() => {
    inDb.close();
    outDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('resolveRouting', () => {
    test('no "to" uses session routing', () => {
      const result = resolveRouting(dir, undefined);
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.channel_type).toBe('slack');
        expect(result.platform_id).toBe('C123');
      }
    });

    test('named destination resolves', () => {
      const result = resolveRouting(dir, 'ops');
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.platform_id).toBe('C456');
        expect(result.resolvedName).toBe('ops');
      }
    });

    test('unknown destination returns error', () => {
      const result = resolveRouting(dir, 'nonexistent');
      expect('error' in result).toBe(true);
    });

    test('no session routing + single destination auto-resolves', () => {
      inDb.prepare('DELETE FROM session_routing').run();
      inDb.prepare('DELETE FROM destinations WHERE name != ?').run('default');
      const result = resolveRouting(dir, undefined);
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.resolvedName).toBe('default');
      }
    });

    test('no session routing + multiple destinations requires "to"', () => {
      inDb.prepare('DELETE FROM session_routing').run();
      const result = resolveRouting(dir, undefined);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('Multiple destinations');
      }
    });
  });

  describe('handleReply', () => {
    test('writes to outbound.db with routing', () => {
      const hb = join(dir, '.heartbeat');
      const result = handleReply(dir, hb, { text: 'hello world' }, 'msg-1');
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('sent');
      const row = outDb.prepare('SELECT * FROM messages_out LIMIT 1').get() as any;
      expect(row).toBeTruthy();
      expect(row.channel_type).toBe('slack');
      expect(row.platform_id).toBe('C123');
      expect(row.in_reply_to).toBe('msg-1');
      expect(JSON.parse(row.content).text).toBe('hello world');
      expect(existsSync(hb)).toBe(true);
    });

    test('routes to named destination', () => {
      const hb = join(dir, '.heartbeat');
      const result = handleReply(dir, hb, { text: 'ops alert', to: 'ops' }, null);
      expect(result.isError).toBeUndefined();
      const row = outDb.prepare('SELECT * FROM messages_out LIMIT 1').get() as any;
      expect(row.platform_id).toBe('C456');
    });

    test('returns error for missing text', () => {
      const hb = join(dir, '.heartbeat');
      const result = handleReply(dir, hb, { text: '' }, null);
      expect(result.isError).toBe(true);
    });
  });

  describe('handleSendFile', () => {
    test('copies file and writes outbound', () => {
      const testFile = join(dir, 'test.txt');
      writeFileSync(testFile, 'file content');
      const hb = join(dir, '.heartbeat');
      const result = handleSendFile(dir, hb, { path: testFile }, null);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('test.txt');
      const row = outDb.prepare('SELECT * FROM messages_out LIMIT 1').get() as any;
      expect(row).toBeTruthy();
      const content = JSON.parse(row.content);
      expect(content.files).toContain('test.txt');
    });

    test('returns error for missing file', () => {
      const hb = join(dir, '.heartbeat');
      const result = handleSendFile(dir, hb, { path: '/nonexistent/file.txt' }, null);
      expect(result.isError).toBe(true);
    });
  });

  describe('buildInstructions', () => {
    test('includes destination names', () => {
      const inst = buildInstructions(dir, 'TestBot');
      expect(inst).toContain('default');
      expect(inst).toContain('ops');
      expect(inst).toContain('#ops');
      expect(inst).toContain('TestBot');
    });

    test('includes channel tag format', () => {
      const inst = buildInstructions(dir);
      expect(inst).toContain('bridge');
      expect(inst).toContain('reply');
    });
  });
});
