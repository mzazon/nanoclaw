import { Database } from 'bun:sqlite';
import { join } from 'path';
import { parseZonedToUtc } from './timezone.ts';
import { writeMessageOut, getSessionRouting } from './db.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sysId(): string {
  return `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function tz(): string {
  return process.env.TZ || 'UTC';
}

export function handleScheduleTask(sessionDir: string, args: Record<string, unknown>): ToolResult {
  const prompt = args.prompt as string;
  const processAfterIn = args.processAfter as string;
  if (!prompt || !processAfterIn) return err('prompt and processAfter are required');

  let processAfter: string;
  try {
    const d = parseZonedToUtc(processAfterIn, tz());
    if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
    processAfter = d.toISOString();
  } catch {
    return err(`invalid processAfter: ${processAfterIn}`);
  }

  const id = generateId();
  const routing = getSessionRouting(sessionDir);
  const recurrence = (args.recurrence as string) || null;
  const script = (args.script as string) || null;

  writeMessageOut(sessionDir, {
    id,
    kind: 'system',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({
      action: 'schedule_task',
      taskId: id,
      prompt,
      script,
      processAfter,
      recurrence,
      platformId: routing.platform_id,
      channelType: routing.channel_type,
      threadId: routing.thread_id,
    }),
  });

  return ok(`Task scheduled (id: ${id}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''})`);
}

export function handleListTasks(sessionDir: string, args: Record<string, unknown>): ToolResult {
  const status = args.status as string | undefined;
  const inDb = new Database(join(sessionDir, 'inbound.db'), { readonly: true });
  try {
    let rows: any[];
    if (status) {
      rows = inDb
        .prepare(
          `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
           FROM messages_in WHERE kind = 'task' AND status = ?
           GROUP BY series_id ORDER BY process_after ASC`,
        )
        .all(status);
    } else {
      rows = inDb
        .prepare(
          `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
           FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')
           GROUP BY series_id ORDER BY process_after ASC`,
        )
        .all();
    }

    if (rows.length === 0) return ok('No tasks found.');

    const lines = rows.map((r: any) => {
      const content = JSON.parse(r.content);
      const prompt = ((content.prompt as string) || '').slice(0, 80);
      return `- ${r.id} [${r.status}] at=${r.process_after || 'now'} ${r.recurrence ? `recur=${r.recurrence} ` : ''}→ ${prompt}`;
    });
    return ok(lines.join('\n'));
  } finally {
    inDb.close();
  }
}

export function handleCancelTask(sessionDir: string, args: Record<string, unknown>): ToolResult {
  const taskId = args.taskId as string;
  if (!taskId) return err('taskId is required');

  writeMessageOut(sessionDir, {
    id: sysId(),
    kind: 'system',
    content: JSON.stringify({ action: 'cancel_task', taskId }),
  });
  return ok(`Task cancellation requested: ${taskId}`);
}

export function handlePauseTask(sessionDir: string, args: Record<string, unknown>): ToolResult {
  const taskId = args.taskId as string;
  if (!taskId) return err('taskId is required');

  writeMessageOut(sessionDir, {
    id: sysId(),
    kind: 'system',
    content: JSON.stringify({ action: 'pause_task', taskId }),
  });
  return ok(`Task pause requested: ${taskId}`);
}

export function handleResumeTask(sessionDir: string, args: Record<string, unknown>): ToolResult {
  const taskId = args.taskId as string;
  if (!taskId) return err('taskId is required');

  writeMessageOut(sessionDir, {
    id: sysId(),
    kind: 'system',
    content: JSON.stringify({ action: 'resume_task', taskId }),
  });
  return ok(`Task resume requested: ${taskId}`);
}

export function handleUpdateTask(sessionDir: string, args: Record<string, unknown>): ToolResult {
  const taskId = args.taskId as string;
  if (!taskId) return err('taskId is required');

  const update: Record<string, unknown> = { taskId };
  if (typeof args.prompt === 'string') update.prompt = args.prompt;
  if (typeof args.processAfter === 'string') {
    try {
      const d = parseZonedToUtc(args.processAfter, tz());
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${args.processAfter}`);
      update.processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${args.processAfter}`);
    }
  }
  if (typeof args.recurrence === 'string') update.recurrence = args.recurrence === '' ? null : args.recurrence;
  if (typeof args.script === 'string') update.script = args.script === '' ? null : args.script;

  if (Object.keys(update).length === 1) return err('at least one field to update is required');

  writeMessageOut(sessionDir, {
    id: sysId(),
    kind: 'system',
    content: JSON.stringify({ action: 'update_task', ...update }),
  });
  return ok(`Task update requested: ${taskId}`);
}

export const SCHEDULING_TOOLS = [
  {
    name: 'schedule_task',
    description:
      "Schedule a one-shot or recurring task. Naive timestamps (no Z/offset) are interpreted in your timezone. Cron expressions are interpreted in your timezone too.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description: 'ISO 8601 timestamp for the first run. Naive = local timezone.',
        },
        recurrence: { type: 'string', description: 'Cron expression for recurring tasks' },
        script: { type: 'string', description: 'Optional pre-agent bash script' },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List scheduled tasks (pending/paused). Shows series id for use with other task tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: pending or paused (default: both)' },
      },
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a scheduled task by series id.',
    inputSchema: {
      type: 'object' as const,
      properties: { taskId: { type: 'string', description: 'Task series id' } },
      required: ['taskId'],
    },
  },
  {
    name: 'update_task',
    description: 'Update a scheduled task. Omitted fields are left unchanged.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task series id' },
        prompt: { type: 'string', description: 'New prompt' },
        processAfter: { type: 'string', description: 'New run time (ISO 8601)' },
        recurrence: { type: 'string', description: 'New cron (empty string to clear)' },
        script: { type: 'string', description: 'New script (empty string to clear)' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'pause_task',
    description: 'Pause a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: { taskId: { type: 'string', description: 'Task series id' } },
      required: ['taskId'],
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: { taskId: { type: 'string', description: 'Task series id' } },
      required: ['taskId'],
    },
  },
];
