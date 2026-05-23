// LOCAL-012: Bridge NCL tool with async request/response correlation.
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { writeMessageOut } from './db.ts';

type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function generateId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function writeNclRequest(sessionDir: string, command: string, args: Record<string, unknown>): string {
  const requestId = generateId();

  writeMessageOut(sessionDir, {
    id: requestId,
    kind: 'system',
    content: JSON.stringify({
      action: 'cli_request',
      requestId,
      command,
      args,
    }),
  });

  return requestId;
}

export async function pollNclResponse(sessionDir: string, requestId: string, timeoutMs: number): Promise<ResponseFrame | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inDb = new Database(join(sessionDir, 'inbound.db'), { readonly: true });
    inDb.exec('PRAGMA busy_timeout = 5000');
    inDb.exec('PRAGMA mmap_size = 0');

    try {
      const row = inDb
        .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | null;

      if (row) {
        inDb.close();
        const outDb = new Database(join(sessionDir, 'outbound.db'));
        outDb.exec('PRAGMA journal_mode = DELETE');
        outDb.exec('PRAGMA busy_timeout = 5000');
        outDb
          .prepare(
            "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
          )
          .run(row.id);
        outDb.close();

        const parsed = JSON.parse(row.content);
        return parsed.frame as ResponseFrame;
      }
    } finally {
      inDb.close();
    }

    await Bun.sleep(500);
  }

  return null;
}

function formatResponse(resp: ResponseFrame): string {
  if (!resp.ok) return `error (${resp.error.code}): ${resp.error.message}`;

  const data = resp.data;
  if (!Array.isArray(data) || data.length === 0) return JSON.stringify(data, null, 2);

  const isFlat = data.every(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      !Array.isArray(r) &&
      Object.values(r as Record<string, unknown>).every((v) => typeof v !== 'object' || v === null),
  );
  if (!isFlat) return JSON.stringify(data, null, 2);

  const keys = Object.keys(data[0] as Record<string, unknown>);
  const widths = keys.map((k) =>
    Math.max(k.length, ...data.map((r) => String((r as Record<string, unknown>)[k] ?? '').length)),
  );
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const rows = data.map((r) =>
    keys.map((k, i) => String((r as Record<string, unknown>)[k] ?? '').padEnd(widths[i])).join('  '),
  );
  return [header, sep, ...rows].join('\n');
}

const NCL_TIMEOUT_MS = 30_000;

export async function handleNcl(sessionDir: string, args: Record<string, unknown>): Promise<ToolResult> {
  const command = args.command as string;
  if (!command) return { content: [{ type: 'text', text: 'Error: command is required' }], isError: true };

  const cliArgs = (args.args as Record<string, unknown>) || {};
  const requestId = writeNclRequest(sessionDir, command, cliArgs);
  const resp = await pollNclResponse(sessionDir, requestId, NCL_TIMEOUT_MS);

  if (!resp) {
    return { content: [{ type: 'text', text: 'Error: ncl command timed out after 30s' }], isError: true };
  }

  const text = formatResponse(resp);
  return { content: [{ type: 'text', text }], isError: !resp.ok };
}

export const NCL_TOOL = {
  name: 'ncl',
  description:
    'Run a NanoClaw CLI command. Examples: "groups-list", "sessions-list", "destinations-list". Use "help" for full list.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'Command name (resource-verb format, e.g. "groups-list", "sessions-get")',
      },
      args: {
        type: 'object',
        description: 'Command arguments as key-value pairs (e.g. {"id": "abc123"})',
      },
    },
    required: ['command'],
  },
};
