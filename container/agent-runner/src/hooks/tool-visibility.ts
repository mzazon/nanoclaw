import path from 'path';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { getInboundDb } from '../db/connection.js';

let _isTaskSession: boolean | null = null;
function isTaskSession(): boolean {
  if (_isTaskSession !== null) return _isTaskSession;
  try {
    const db = getInboundDb();
    const row = db.prepare("SELECT kind FROM messages_in ORDER BY seq DESC LIMIT 1").get() as { kind?: string } | undefined;
    _isTaskSession = row?.kind === 'task';
  } catch { _isTaskSession = false; }
  return _isTaskSession;
}

function skipVisibility(): boolean {
  return isTaskSession();
}

const SKIP_TOOLS = new Set(['WebSearch', 'Glob', 'Grep']);

const MAX_INPUT_PREVIEW = 120;
const LONG_CALL_THRESHOLD_MS = 3000;
const PROGRESS_FIRST_DELAY_MS = 30000;
const PROGRESS_INTERVAL_MS = 30000;

const TOOL_EMOJI: Record<string, string> = {
  Bash: '🖥️',
  Read: '📖',
  Write: '✍️',
  Edit: '✏️',
  MultiEdit: '✏️',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '🤖',
  Task: '🤖',
  TodoWrite: '📝',
};

const TOOL_LABEL: Record<string, string> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  WebFetch: 'fetch',
  WebSearch: 'search',
  Agent: 'agent',
  Task: 'task',
  TodoWrite: 'todo',
};

const BATCH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'WebFetch']);

const BASH_WITH_SUBCOMMAND = new Set([
  'git', 'npm', 'pnpm', 'bun', 'apt', 'apt-get', 'pip', 'pip3',
  'systemctl', 'docker', 'yarn', 'uv', 'gh', 'ssh',
]);

function log(msg: string): void {
  console.error(`[tool-visibility] ${msg}`);
}

function truncate(s: string): string {
  return s.length > MAX_INPUT_PREVIEW ? s.slice(0, MAX_INPUT_PREVIEW) + '…' : s;
}

function domainOf(url: string): string {
  return url.replace(/^https?:\/\//, '').split('/')[0];
}

function shortPath(p: string, maxLen = 35): string {
  if (p.length <= maxLen) return p;
  return '…' + p.slice(-(maxLen - 1));
}

function formatToolLine(emoji: string, label: string, desc: string, count = 0): string {
  const countStr = count > 1 ? ` ×${count}` : '';
  const paddedLabel = label.padEnd(8);
  return desc ? `${emoji} ${paddedLabel}${countStr} ${desc}`.trimEnd()
              : `${emoji} ${paddedLabel.trimEnd()}${countStr}`;
}

function extractResponseText(toolResponse: unknown): string | null {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.output === 'string') return r.output;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.content === 'string') return r.content;
    if (typeof r.stdout === 'string') return r.stdout;
  }
  return null;
}

function resultShape(toolName: string, toolResponse: unknown): string | null {
  const text = extractResponseText(toolResponse);
  if (toolName === 'Read' && text) {
    const lines = text.split('\n').length;
    return `${lines} lines`;
  }
  if (toolName === 'Bash' && text) {
    const allLines = text.split('\n');
    const nonEmpty = allLines.filter((l) => l.trim()).length;
    if (nonEmpty < 1) return null;
    const firstLine = allLines.find((l) => l.trim()) || '';
    const peek = firstLine.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (nonEmpty >= 5) {
      return peek ? `${nonEmpty} lines  → \`${peek}\`` : `${nonEmpty} lines`;
    }
    if (peek) return `→ \`${peek}\``;
    return null;
  }
  if (toolName === 'WebFetch' && text) {
    const kb = Math.round(text.length / 1024);
    if (kb >= 1) return `${kb}KB`;
    return null;
  }
  return null;
}

function detectFailureFromResponse(_toolName: string, toolResponse: unknown): string | null {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (r.is_error === true || r.success === false) {
      const explicit = typeof r.error === 'string' ? r.error
        : typeof r.message === 'string' ? r.message
        : 'failed';
      return explicit.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    if (typeof r.error === 'string' && r.error.trim()) {
      return r.error.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  const text = extractResponseText(toolResponse);
  if (!text) return null;
  const patterns: RegExp[] = [
    /^(Error|ERROR): (.+)$/m,
    /(permission denied)/i,
    /(no such file or directory)/i,
    /(command not found)/i,
    /(Traceback \(most recent call last\))/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return null;
}

function summarizeBash(raw: string): string {
  const cmd = raw.replace(/\s+/g, ' ').trim();

  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  const isPureAssignment = (s: string) =>
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+$/.test(s);
  let first = segments[0] ?? '';
  for (const seg of segments) {
    if (isPureAssignment(seg)) continue;
    first = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
    break;
  }

  const stripped = first.replace(/^sudo\s+/, '');
  const words = stripped.split(' ');
  const bin = path.basename(words[0] ?? '');
  const sub = words[1] ?? '';

  const isSshLike = bin === 'ssh' || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(words[0] ?? '');
  if (isSshLike) {
    const sshFlagsWithArg = new Set(['-i', '-o', '-p', '-J', '-F', '-L', '-R', '-D', '-l', '-c', '-m', '-b', '-B', '-e', '-I', '-Q', '-S', '-W', '-w']);
    const sshArgs = words.slice(1);
    let idx = 0;
    while (idx < sshArgs.length) {
      const a = sshArgs[idx];
      if (sshFlagsWithArg.has(a)) {
        idx += 2;
        continue;
      }
      if (a.startsWith('-')) {
        idx += 1;
        continue;
      }
      break;
    }
    const host = sshArgs[idx];
    if (host) {
      const afterHost = sshArgs.slice(idx + 1).join(' ');
      const remoteCmd = afterHost.replace(/^["']|["']$/g, '').trim();
      return truncate(remoteCmd ? `ssh ${host}: ${remoteCmd}` : `ssh ${host}`);
    }
    return truncate(first);
  }
  if (BASH_WITH_SUBCOMMAND.has(bin) && sub && !sub.startsWith('-')) {
    return truncate(`${bin} ${sub}`);
  }
  return truncate(first);
}

function describeToolInput(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const input = toolInput as Record<string, unknown>;

  if (toolName === 'Bash' && typeof input.command === 'string') {
    return `\`${summarizeBash(input.command)}\``;
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && typeof input.file_path === 'string') {
    return `\`${shortPath(input.file_path)}\``;
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    return `\`${input.pattern}\``;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return `\`${input.pattern}\``;
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return `\`${domainOf(input.url)}\``;
  }
  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return `\`${truncate(input.query)}\``;
  }
  if (toolName === 'Task' && typeof input.description === 'string') {
    return truncate(input.description);
  }
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const n = input.todos.length;
    return `${n} task${n === 1 ? '' : 's'}`;
  }

  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) {
      return truncate(val.replace(/\s+/g, ' ').trim());
    }
  }
  return '';
}

function emit(text: string): void {
  if (isTaskSession()) return;
  try {
    const routing = getSessionRouting();
    if (!routing.channel_type || !routing.platform_id) return;
    writeMessageOut({
      id: `tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text, _toolVis: true }),
    });
  } catch (err) {
    log(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Batching for rapid file I/O ──────────────────────────────────────

interface BatchEntry {
  emoji: string;
  label: string;
  lastDesc: string;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}
const toolBatch = new Map<string, BatchEntry>();

function flushBatch(toolName: string): void {
  const entry = toolBatch.get(toolName);
  if (!entry) return;
  toolBatch.delete(toolName);
  emit(formatToolLine(entry.emoji, entry.label, entry.lastDesc, entry.count));
}

function sendBatched(toolName: string, emoji: string, label: string, desc: string): void {
  const existing = toolBatch.get(toolName);
  if (existing) {
    clearTimeout(existing.timer);
    existing.count++;
    existing.lastDesc = desc;
    existing.timer = setTimeout(() => flushBatch(toolName), 300);
  } else {
    const timer = setTimeout(() => flushBatch(toolName), 300);
    toolBatch.set(toolName, { emoji, label, lastDesc: desc, count: 1, timer });
  }
}

// ── Duration tracking for slow Bash ──────────────────────────────────

const toolStartTimes: Record<string, number> = {};
const progressTimers: Record<string, ReturnType<typeof setInterval>> = {};

// ── Hook implementations ─────────────────────────────────────────────

export const preToolUseVisibility: HookCallback = async (input, toolUseId) => {
  if (skipVisibility()) return { continue: true };
  const i = input as { tool_name?: string; tool_input?: unknown; tool_use_id?: string; transcript_path?: string };
  if (typeof i.transcript_path === 'string' && i.transcript_path.includes('/subagents/')) {
    return { continue: true };
  }
  const toolName = i.tool_name ?? '';

  if (SKIP_TOOLS.has(toolName)) return { continue: true };

  const id = toolUseId || i.tool_use_id;
  if (id) toolStartTimes[id] = Date.now();

  const desc = describeToolInput(toolName, i.tool_input);
  const emoji = TOOL_EMOJI[toolName] ?? '🔧';
  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();

  if (BATCH_TOOLS.has(toolName)) {
    sendBatched(toolName, emoji, label, desc);
  } else {
    emit(formatToolLine(emoji, label, desc));
  }

  if ((toolName === 'Agent' || toolName === 'Task') && id) {
    const startedAt = toolStartTimes[id] ?? Date.now();
    const tick = () => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const elapsedStr = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;
      emit(formatToolLine('⏳', label, `still working — ${elapsedStr} elapsed`));
    };
    progressTimers[id] = setInterval(tick, PROGRESS_INTERVAL_MS);
    setTimeout(tick, PROGRESS_FIRST_DELAY_MS);
  }

  return { continue: true };
};

export const postToolUseVisibility: HookCallback = async (input, toolUseId) => {
  if (skipVisibility()) return { continue: true };
  const i = input as {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    error?: string;
    tool_use_id?: string;
    transcript_path?: string;
  };
  if (typeof i.transcript_path === 'string' && i.transcript_path.includes('/subagents/')) {
    return { continue: true };
  }
  const toolName = i.tool_name ?? '';

  if (SKIP_TOOLS.has(toolName)) return { continue: true };

  const id = toolUseId || i.tool_use_id;
  const startTime = id ? toolStartTimes[id] : undefined;
  if (id) delete toolStartTimes[id];

  if (id && progressTimers[id]) {
    clearInterval(progressTimers[id]);
    delete progressTimers[id];
  }

  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();
  const desc = describeToolInput(toolName, i.tool_input);

  if (i.hook_event_name === 'PostToolUseFailure') {
    const reason = (i.error ?? 'failed').replace(/\s+/g, ' ').trim().slice(0, 80);
    const merged = desc ? `${desc}  ✗ ${reason}` : `✗ ${reason}`;
    emit(formatToolLine('❌', label, merged));
    return { continue: true };
  }

  const inferred = detectFailureFromResponse(toolName, i.tool_response);
  if (inferred) {
    const merged = desc ? `${desc}  ✗ ${inferred}` : `✗ ${inferred}`;
    emit(formatToolLine('❌', label, merged));
    return { continue: true };
  }

  if (toolName === 'Bash' && startTime) {
    const elapsed = Date.now() - startTime;
    if (elapsed > LONG_CALL_THRESHOLD_MS) {
      const shape = resultShape(toolName, i.tool_response);
      const elapsedStr = `done in ${(elapsed / 1000).toFixed(1)}s`;
      const finalDesc = shape ? `${elapsedStr}  ${shape}` : elapsedStr;
      emit(formatToolLine('🖥️', 'bash', finalDesc));
    }
  }

  return { continue: true };
};
