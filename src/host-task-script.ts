// LOCAL-012: Host-side pre-task script runner for interactive sessions.
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { log } from './log.js';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

interface MessageRow {
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

async function runScript(script: string, taskId: string): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `host-task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: SCRIPT_MAX_BUFFER, env: process.env },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {}

        if (stderr) log.debug('host-task-script stderr', { taskId, stderr: stderr.slice(0, 500) });

        if (error) {
          log.warn('host-task-script error', { taskId, error: error.message });
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log.warn('host-task-script no output', { taskId });
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log.warn('host-task-script missing wakeAgent', { taskId, output: lastLine.slice(0, 200) });
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log.warn('host-task-script invalid JSON', { taskId, output: lastLine.slice(0, 200) });
          resolve(null);
        }
      },
    );
  });
}

export async function applyHostPreTaskScripts(
  inDb: Database.Database,
  dueMessages: MessageRow[],
): Promise<MessageRow[]> {
  const keep: MessageRow[] = [];

  for (const msg of dueMessages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      try {
        content = JSON.parse(
          msg.content.replace(/[\x00-\x1f]/g, (ch) => {
            const code = ch.charCodeAt(0);
            if (code === 0x0a) return '\\n';
            if (code === 0x0d) return '\\r';
            if (code === 0x09) return '\\t';
            return `\\u${code.toString(16).padStart(4, '0')}`;
          }),
        );
        log.warn('Repaired malformed JSON in task content', { taskId: msg.id });
      } catch {
        keep.push(msg);
        continue;
      }
    }

    const script = typeof content.script === 'string' ? content.script : null;
    if (!script) {
      keep.push(msg);
      continue;
    }

    log.info('Running host pre-task script', { taskId: msg.id });
    const result = await runScript(script, msg.id);

    if (!result || !result.wakeAgent) {
      const reason = result ? 'wakeAgent=false' : 'script error/no output';
      log.info('Host pre-task script suppressed wake', { taskId: msg.id, reason });
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(msg.id);
      continue;
    }

    log.info('Host pre-task script passed', { taskId: msg.id });
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return keep;
}
