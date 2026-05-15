/**
 * Forum thread creation MCP tool.
 *
 * LOCAL-001: Writes a system action, then polls for the host's response
 * containing the new thread's platform-qualified ID. Returns the thread_id
 * so the agent can pass it to send_message(thread_id=...) to target the
 * new thread instead of inheriting the session's stale default.
 */
import { findByName } from '../destinations.js';
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const RESPONSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const createForumThread: McpToolDefinition = {
  tool: {
    name: 'create_forum_thread',
    description:
      'Create a new thread in a channel you have as a destination. On Discord this creates a forum thread; on Slack and other platforms it posts a top-level message that starts a thread. Blocks until the thread is created and returns the thread_id for use with send_message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name (e.g., "research")' },
        title: { type: 'string', description: 'Thread title' },
        body: { type: 'string', description: 'Initial message body (markdown)' },
      },
      required: ['to', 'title', 'body'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const title = args.title as string;
    const body = args.body as string;
    if (!to || !title || !body) return err('to, title, and body are required');

    const dest = findByName(to);
    if (!dest) return err(`Unknown destination "${to}".`);
    if (dest.type !== 'channel') return err(`Destination "${to}" is not a channel.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_forum_thread',
        requestId,
        platformId: dest.platformId,
        channelType: dest.channelType,
        title,
        body,
      }),
    });

    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content);
        if (parsed.status === 'ok') {
          return ok(`Forum thread "${title}" created. thread_id: ${parsed.result.threadPlatformId}\n\nPass this thread_id to send_message to post into the new thread.`);
        }
        const error = parsed.result?.error ?? 'Unknown error';
        return err(`Forum thread creation failed: ${error}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return ok(`Forum thread "${title}" creation queued (timed out waiting for confirmation — thread may still be created).`);
  },
};

registerTools([createForumThread]);
