import { Database } from 'bun:sqlite';
import { writeFileSync } from 'fs';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

function openInbound(sessionDir: string): Database {
  return new Database(`${sessionDir}/inbound.db`, { readonly: true });
}

function openOutbound(sessionDir: string): Database {
  const db = new Database(`${sessionDir}/outbound.db`);
  db.exec('PRAGMA journal_mode=DELETE');
  return db;
}

let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: Database): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

export function getPendingMessages(sessionDir: string, isFirstPoll: boolean): MessageInRow[] {
  const inbound = openInbound(sessionDir);
  const outbound = openOutbound(sessionDir);
  try {
    const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const pending = inbound
      .prepare(
        `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         ${onWakeFilter}
       ORDER BY seq DESC LIMIT ?2`,
      )
      .all(isFirstPoll ? 1 : 0, 10) as MessageInRow[];
    if (pending.length === 0) return [];
    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );
    return pending.filter((m) => {
      if (ackedIds.has(m.id)) return false;
      if (m.kind === 'system') return false;
      if (m.kind === 'task') {
        try {
          const c = JSON.parse(m.content);
          if (typeof c.script === 'string') return false;
        } catch {}
      }
      return true;
    }).reverse();
  } finally {
    inbound.close();
    outbound.close();
  }
}

export function markProcessing(sessionDir: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = openOutbound(sessionDir);
  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES ($id, 'processing', datetime('now'))",
    );
    db.transaction(() => {
      for (const id of ids) stmt.run({ $id: id });
    })();
  } finally {
    db.close();
  }
}

export function markCompleted(sessionDir: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = openOutbound(sessionDir);
  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES ($id, 'completed', datetime('now'))",
    );
    db.transaction(() => {
      for (const id of ids) stmt.run({ $id: id });
    })();
  } finally {
    db.close();
  }
}

export function writeMessageOut(sessionDir: string, msg: WriteMessageOut): number {
  const outbound = openOutbound(sessionDir);
  const inbound = openInbound(sessionDir);
  try {
    const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
    const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const max = Math.max(maxOut, maxIn);
    const nextSeq = max % 2 === 0 ? max + 1 : max + 2;
    outbound
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
       VALUES ($id, $seq, $in_reply_to, datetime('now'), $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
      )
      .run({
        $id: msg.id,
        $seq: nextSeq,
        $in_reply_to: msg.in_reply_to ?? null,
        $deliver_after: msg.deliver_after ?? null,
        $recurrence: msg.recurrence ?? null,
        $kind: msg.kind,
        $platform_id: msg.platform_id ?? null,
        $channel_type: msg.channel_type ?? null,
        $thread_id: msg.thread_id ?? null,
        $content: msg.content,
      });
    return nextSeq;
  } finally {
    outbound.close();
    inbound.close();
  }
}

export function touchHeartbeat(heartbeatPath: string): void {
  writeFileSync(heartbeatPath, String(Date.now()));
}

export function getAllDestinations(sessionDir: string): DestinationEntry[] {
  const db = openInbound(sessionDir);
  try {
    const rows = db.prepare('SELECT * FROM destinations ORDER BY name').all() as Array<{
      name: string;
      display_name: string | null;
      type: 'channel' | 'agent';
      channel_type: string | null;
      platform_id: string | null;
      agent_group_id: string | null;
    }>;
    return rows.map((r) => ({
      name: r.name,
      displayName: r.display_name ?? r.name,
      type: r.type,
      channelType: r.channel_type ?? undefined,
      platformId: r.platform_id ?? undefined,
      agentGroupId: r.agent_group_id ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export function findDestination(sessionDir: string, name: string): DestinationEntry | undefined {
  const all = getAllDestinations(sessionDir);
  return all.find((d) => d.name === name);
}

export function getSessionRouting(sessionDir: string): {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
} {
  const db = openInbound(sessionDir);
  try {
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
      | undefined;
    return row ?? { channel_type: null, platform_id: null, thread_id: null };
  } finally {
    db.close();
  }
}
