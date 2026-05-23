#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPendingMessages, markProcessing, markCompleted, touchHeartbeat, readOutboundMaxSeq } from './db.ts';
import { handleReply, handleSendFile, buildInstructions } from './tools.ts';
import {
  handleScheduleTask, handleListTasks, handleCancelTask,
  handleUpdateTask, handlePauseTask, handleResumeTask,
  SCHEDULING_TOOLS,
} from './tools-scheduling.ts';
import { handleNcl, NCL_TOOL } from './tools-ncl.ts';
import { createUnresponsivenessState, checkUnresponsiveness } from './unresponsiveness.ts';
import { join } from 'path';

const SESSION_DIR = process.env.NANOCLAW_SESSION_DIR!;
const AGENT_GROUP_ID = process.env.NANOCLAW_AGENT_GROUP_ID;
const ASSISTANT_NAME = process.env.NANOCLAW_ASSISTANT_NAME;

if (!SESSION_DIR) {
  process.stderr.write('nanoclaw-bridge: NANOCLAW_SESSION_DIR required\n');
  process.exit(1);
}

const HEARTBEAT_PATH = join(SESSION_DIR, '.heartbeat');
const UNRESPONSIVE_MARKER_PATH = join(SESSION_DIR, '.cc-unresponsive');
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
    ...SCHEDULING_TOOLS,
    NCL_TOOL,
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
          thread_id: args.thread_id as string | undefined,
        },
        currentInReplyTo,
      );
    case 'schedule_task':
      return handleScheduleTask(SESSION_DIR, args);
    case 'list_tasks':
      return handleListTasks(SESSION_DIR, args);
    case 'cancel_task':
      return handleCancelTask(SESSION_DIR, args);
    case 'update_task':
      return handleUpdateTask(SESSION_DIR, args);
    case 'pause_task':
      return handlePauseTask(SESSION_DIR, args);
    case 'resume_task':
      return handleResumeTask(SESSION_DIR, args);
    case 'ncl':
      return handleNcl(SESSION_DIR, args);
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  }
});

if (import.meta.main) {
  await mcp.connect(new StdioServerTransport());

  const unresponsivenessState = createUnresponsivenessState(UNRESPONSIVE_MARKER_PATH);
  // Initialize outboundSeqAtLastCheck to current max seq so stuck-on-boot
  // detection doesn't false-positive on pre-existing outbound rows.
  try {
    unresponsivenessState.outboundSeqAtLastCheck = readOutboundMaxSeq(SESSION_DIR);
  } catch (err) {
    process.stderr.write(`nanoclaw-bridge: failed to read initial outbound max-seq: ${err}\n`);
  }
  let lastObservedOutboundSeq = unresponsivenessState.outboundSeqAtLastCheck;

  function poll(): void {
    try {
      const messages = getPendingMessages(SESSION_DIR, isFirstPoll);
      isFirstPoll = false;

      if (messages.length === 0) {
        touchHeartbeat(HEARTBEAT_PATH);
      } else {
        const ids = messages.map((m) => m.id);
        markProcessing(SESSION_DIR, ids);

        function parseMsg(msg: typeof messages[0]): { text: string; user: string } {
          try {
            const p = JSON.parse(msg.content);
            return { text: p.text ?? msg.content, user: p.sender_handle ?? p.senderHandle ?? 'user' };
          } catch {
            return { text: msg.content, user: 'user' };
          }
        }

        // Batch context: older messages prepended as context, only the
        // last (triggering) message sets currentInReplyTo for reply routing.
        if (messages.length > 1) {
          const context = messages.slice(0, -1).map((m) => {
            const { text, user } = parseMsg(m);
            return `[${user} at ${m.timestamp}]: ${text}`;
          });
          const last = messages[messages.length - 1];
          const { text, user } = parseMsg(last);
          currentInReplyTo = last.id;
          mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: `[Earlier messages]\n${context.join('\n')}\n\n[Latest]\n${text}`,
              meta: {
                chat_id: last.platform_id ?? AGENT_GROUP_ID ?? 'unknown',
                message_id: last.id,
                user,
                ts: last.timestamp,
              },
            },
          }).catch((e) => process.stderr.write(`nanoclaw-bridge: notification send failed: ${e}\n`));
          unresponsivenessState.notificationsSent++;
        } else {
          const msg = messages[0];
          const { text, user } = parseMsg(msg);
          currentInReplyTo = msg.id;
          mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: text,
              meta: {
                chat_id: msg.platform_id ?? AGENT_GROUP_ID ?? 'unknown',
                message_id: msg.id,
                user,
                ts: msg.timestamp,
              },
            },
          }).catch((e) => process.stderr.write(`nanoclaw-bridge: notification send failed: ${e}\n`));
          unresponsivenessState.notificationsSent++;
        }
        markCompleted(SESSION_DIR, ids);
        touchHeartbeat(HEARTBEAT_PATH);
      }

      // Unresponsiveness check runs every tick regardless of inbound traffic.
      // checkUnresponsiveness self-throttles to 60s.
      try {
        const currentMaxSeq = readOutboundMaxSeq(SESSION_DIR);
        if (currentMaxSeq > lastObservedOutboundSeq) {
          unresponsivenessState.lastOutboundWriteMs = Date.now();
          lastObservedOutboundSeq = currentMaxSeq;
        }
        checkUnresponsiveness(unresponsivenessState, currentMaxSeq, Date.now());
      } catch (err) {
        process.stderr.write(`nanoclaw-bridge: unresponsiveness check failed: ${err}\n`);
      }
    } catch (e) {
      process.stderr.write(`nanoclaw-bridge: poll error: ${e}\n`);
    }
  }

  let pollTimer: ReturnType<typeof setTimeout>;
  function schedulePoll(): void {
    pollTimer = setTimeout(() => {
      poll();
      if (!shuttingDown) schedulePoll();
    }, POLL_INTERVAL_MS);
    pollTimer.unref();
  }
  schedulePoll();

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(pollTimer);
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
