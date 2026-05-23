// LOCAL-012: Bridge tools — reply, send_file, instructions builder.
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, basename, isAbsolute, resolve } from 'path';
import {
  getAllDestinations,
  findDestination,
  getSessionRouting,
  writeMessageOut,
  touchHeartbeat,
} from './db.ts';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveRouting(
  sessionDir: string,
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    const session = getSessionRouting(sessionDir);
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    const all = getAllDestinations(sessionDir);
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return { error: `Multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}` };
    }
    to = all[0].name;
  }
  const dest = findDestination(sessionDir, to);
  if (!dest) {
    const known = getAllDestinations(sessionDir).map((d) => d.name).join(', ') || '(none)';
    return { error: `Unknown destination "${to}". Known: ${known}` };
  }
  if (dest.type === 'channel') {
    const session = getSessionRouting(sessionDir);
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId
        ? session.thread_id
        : null;
    return { channel_type: dest.channelType!, platform_id: dest.platformId!, thread_id: threadId, resolvedName: to };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

export function handleReply(
  sessionDir: string,
  heartbeatPath: string,
  args: { text: string; to?: string; thread_id?: string },
  currentInReplyTo: string | null,
): ToolResult {
  if (!args.text) return err('text is required');
  const routing = resolveRouting(sessionDir, args.to);
  if ('error' in routing) return err(routing.error);
  const id = generateId();
  const seq = writeMessageOut(sessionDir, {
    id,
    in_reply_to: currentInReplyTo,
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: args.thread_id ?? routing.thread_id,
    content: JSON.stringify({ text: args.text }),
  });
  touchHeartbeat(heartbeatPath);
  return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
}

export function handleSendFile(
  sessionDir: string,
  heartbeatPath: string,
  args: { path: string; to?: string; text?: string; filename?: string; thread_id?: string },
  currentInReplyTo: string | null,
): ToolResult {
  if (!args.path) return err('path is required');
  const routing = resolveRouting(sessionDir, args.to);
  if ('error' in routing) return err(routing.error);
  const resolvedPath = isAbsolute(args.path) ? args.path : resolve(args.path);
  if (!existsSync(resolvedPath)) return err(`File not found: ${args.path}`);
  const id = generateId();
  const filename = args.filename ?? basename(resolvedPath);
  const outboxDir = join(sessionDir, 'outbox', id);
  mkdirSync(outboxDir, { recursive: true });
  copyFileSync(resolvedPath, join(outboxDir, filename));
  writeMessageOut(sessionDir, {
    id,
    in_reply_to: currentInReplyTo,
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: args.thread_id ?? routing.thread_id,
    content: JSON.stringify({ text: args.text ?? '', files: [filename] }),
  });
  touchHeartbeat(heartbeatPath);
  return ok(`File sent to ${routing.resolvedName} (filename: ${filename})`);
}

export function buildInstructions(sessionDir: string, assistantName?: string): string {
  const sections: string[] = [
    'Messages arrive as <channel source="nanoclaw-bridge" chat_id="..." message_id="..." user="..." ts="...">.',
    'Reply using the reply tool — your transcript output does not reach the sender.',
    'Use send_message with a "to" parameter for cross-destination routing.',
    'Use send_file to attach files to messages.',
    'You can schedule, list, cancel, pause, resume, and update tasks using the scheduling tools.',
    'Use the ncl tool to manage your agent group, list sessions, and query destinations.',
  ];
  if (assistantName) {
    sections.push('', `Your name is **${assistantName}**.`);
  }
  const dests = getAllDestinations(sessionDir);
  if (dests.length > 0) {
    sections.push('', 'Available destinations:');
    for (const d of dests) {
      sections.push(`- ${d.name}${d.displayName !== d.name ? ` (${d.displayName})` : ''}`);
    }
  }
  return sections.join('\n');
}
