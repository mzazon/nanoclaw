#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPendingMessages, markProcessing, markCompleted, touchHeartbeat } from './db.ts';
import { handleReply, handleSendFile, buildInstructions } from './tools.ts';
import { join } from 'path';

const SESSION_DIR = process.env.NANOCLAW_SESSION_DIR;
const AGENT_GROUP_ID = process.env.NANOCLAW_AGENT_GROUP_ID;
const ASSISTANT_NAME = process.env.NANOCLAW_ASSISTANT_NAME;

if (!SESSION_DIR) {
  process.stderr.write('nanoclaw-bridge: NANOCLAW_SESSION_DIR required\n');
  process.exit(1);
}

const HEARTBEAT_PATH = join(SESSION_DIR, '.heartbeat');
const POLL_INTERVAL_MS = 1000;

let currentInReplyTo: string | null = null;
let isFirstPoll = true;

const mcp = new Server(
  { name: 'nanoclaw-bridge', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: buildInstructions(SESSION_DIR, ASSISTANT_NAME),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply to the current conversation. Omit "to" for default routing, or specify a destination name.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message content' },
          to: { type: 'string', description: 'Destination name (optional — defaults to current conversation)' },
          thread_id: { type: 'string', description: 'Target a specific thread' },
        },
        required: ['text'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to a named destination.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Destination name' },
          text: { type: 'string', description: 'Message content' },
          thread_id: { type: 'string', description: 'Target a specific thread' },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'send_file',
      description: 'Send a file to a named destination.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Destination name (optional)' },
          path: { type: 'string', description: 'Absolute file path' },
          text: { type: 'string', description: 'Optional accompanying message' },
          filename: { type: 'string', description: 'Display name (default: basename)' },
        },
        required: ['path'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  switch (req.params.name) {
    case 'reply':
      return handleReply(
        SESSION_DIR,
        HEARTBEAT_PATH,
        { text: args.text as string, to: args.to as string | undefined, thread_id: args.thread_id as string | undefined },
        currentInReplyTo,
      );
    case 'send_message':
      return handleReply(
        SESSION_DIR,
        HEARTBEAT_PATH,
        { text: args.text as string, to: args.to as string, thread_id: args.thread_id as string | undefined },
        currentInReplyTo,
      );
    case 'send_file':
      return handleSendFile(
        SESSION_DIR,
        HEARTBEAT_PATH,
        {
          path: args.path as string,
          to: args.to as string | undefined,
          text: args.text as string | undefined,
          filename: args.filename as string | undefined,
        },
        currentInReplyTo,
      );
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  }
});

if (import.meta.main) {
  await mcp.connect(new StdioServerTransport());

  function poll(): void {
    try {
      const messages = getPendingMessages(SESSION_DIR, isFirstPoll);
      isFirstPoll = false;
      if (messages.length === 0) {
        touchHeartbeat(HEARTBEAT_PATH);
        return;
      }
      const ids = messages.map((m) => m.id);
      markProcessing(SESSION_DIR, ids);
      for (const msg of messages) {
        let text: string;
        try {
          const parsed = JSON.parse(msg.content);
          text = parsed.text ?? msg.content;
        } catch {
          text = msg.content;
        }
        currentInReplyTo = msg.id;
        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: text,
            meta: {
              chat_id: msg.platform_id ?? AGENT_GROUP_ID ?? 'unknown',
              message_id: msg.id,
              user: (() => {
                try {
                  const p = JSON.parse(msg.content);
                  return p.sender_handle ?? p.senderHandle ?? 'user';
                } catch {
                  return 'user';
                }
              })(),
              ts: msg.timestamp,
            },
          },
        });
      }
      markCompleted(SESSION_DIR, ids);
      touchHeartbeat(HEARTBEAT_PATH);
    } catch (e) {
      process.stderr.write(`nanoclaw-bridge: poll error: ${e}\n`);
    }
  }

  const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref();

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pollTimer);
    process.stderr.write('nanoclaw-bridge: shutting down\n');
    process.exit(0);
  }
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stderr.write(`nanoclaw-bridge: started (session=${SESSION_DIR})\n`);
}

export { mcp };
