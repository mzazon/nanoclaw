import { AGENT_DIR, HOST_MODE } from './paths.js';
import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo, wasDeliveredViaMcp } from './current-batch.js';
import { resetToolVisStream } from './hooks/tool-visibility.js';
import { getSessionRouting } from './db/session-routing.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  getRunnerHandledCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type ErrorKind =
  | 'rate-limit'
  | 'auth'
  | 'context-overflow'
  | 'policy-refusal'
  | 'network'
  | 'model-error'
  | 'overloaded'
  | 'server-error' // LOCAL-018
  | 'bad-request' // LOCAL-018
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  userMessage: string;
  resetAt?: number;
  suppressNudge: boolean;
}

interface ErrorLike {
  message?: string;
  classification?: string;
  retryable?: boolean;
}

/**
 * Classify an SDK 'error' event into a user-facing message. Returns
 * { kind: 'unknown', suppressNudge: false, userMessage: '' } when the
 * error doesn't match any known pattern — the caller leaves the existing
 * unwrapped-text nudge to fire as before.
 */
export function classifyError(event: ErrorLike): ClassifiedError {
  const m = event.message ?? '';
  const cls = event.classification ?? '';

  if (cls === 'rate_limit' || /rate.?limit/i.test(m) || /\b429\b/.test(m)) {
    const when = parseResetFromSdkMessage(m) ?? 'shortly';
    return {
      kind: 'rate-limit',
      userMessage: `⏸ I hit my API rate limit. Resets at ${when}. Please re-send your message after the reset.`,
      suppressNudge: true,
    };
  }

  if (cls === 'authentication_error' || /\b401\b|invalid.api.key/i.test(m)) {
    return {
      kind: 'auth',
      userMessage: '🔒 Auth error — API credentials need attention. Operator has been notified.',
      suppressNudge: true,
    };
  }

  if (/prompt is too long|context_length_exceeded|conversation too long/i.test(m)) {
    return {
      kind: 'context-overflow',
      userMessage: '📏 My context window filled up. Please re-state your last request.',
      suppressNudge: true,
    };
  }

  if (/violate our Usage Policy/i.test(m)) {
    return {
      kind: 'policy-refusal',
      userMessage: "⚠️ My last response was blocked by Anthropic's usage policy. Please rephrase.",
      suppressNudge: true,
    };
  }

  if (cls === 'overloaded_error' || /overloaded|\b529\b/.test(m)) {
    return {
      kind: 'overloaded',
      userMessage: "⏳ Anthropic's API is temporarily overloaded. Will retry next message.",
      suppressNudge: true,
    };
  }

  // LOCAL-018: 5xx server errors. The SDK retries these internally; this fires
  // mainly for the THROWN post-exhaustion error surfaced via the catch path.
  // Placed after the 529 check so overloaded keeps its own kind.
  if (/\b5\d{2}\b|internal server error|API Error:\s*5\d{2}/i.test(m)) {
    return {
      kind: 'server-error',
      userMessage: "⏳ Anthropic's API returned a server error and retries were exhausted. Please try again shortly.",
      suppressNudge: true,
    };
  }

  if (/network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(m)) {
    return {
      kind: 'network',
      userMessage: '🌐 Network error reaching the API. Will retry on the next message.',
      suppressNudge: true,
    };
  }

  if (/model.*(not.found|does.not.exist|unavailable)|invalid_request.*model/i.test(m)) {
    return {
      kind: 'model-error',
      userMessage: `🛠 Model config issue: ${m.slice(0, 200)}. Operator notified.`,
      suppressNudge: true,
    };
  }

  // LOCAL-018: client errors (4xx other than 401/429) — not retryable. Placed
  // after model-error so model-specific invalid_request keeps its own kind.
  if (/\b400\b|\b422\b|invalid_request|API Error:\s*4(?:00|22)/i.test(m)) {
    return {
      kind: 'bad-request',
      userMessage: `⚠️ The API rejected the request (${m.slice(0, 160)}). This won't succeed on retry — please rephrase or simplify.`,
      suppressNudge: true,
    };
  }

  return { kind: 'unknown', userMessage: '', suppressNudge: false };
}

function parseResetFromSdkMessage(m: string): string | null {
  const patterns = [
    /resets?\s+at\s+([^.\n]+)/i,
    /resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s+\([^)]+\))?)/i,
    /try again after\s+([^.\n]+)/i,
  ];
  for (const p of patterns) {
    const match = m.match(p);
    if (match) return match[1].trim();
  }
  return null;
}

// LOCAL-003: generate responses for commands the Agent SDK ignores.
// These are CLI-only features (/context, /cost) that produce terminal
// output in Claude Code but emit nothing in headless agent mode.
function handleRunnerCommand(command: string, continuation: string | undefined): string {
  if (command === '/context') {
    return getContextInfo(continuation);
  }
  if (command === '/cost') {
    return 'Cost tracking is not available in headless agent mode. Check your Anthropic dashboard for API usage.';
  }
  return `Unknown command: ${command}`;
}

function getContextInfo(continuation: string | undefined): string {
  const compactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';
  const lines: string[] = [];

  if (!continuation) {
    lines.push('No active session (no transcript).');
    lines.push(`Auto-compact threshold: ${Number(compactWindow).toLocaleString()} tokens`);
    return lines.join('\n');
  }

  const fs = require('fs');
  const projectHash = HOST_MODE ? AGENT_DIR.replace(/\//g, '-') : '-workspace-agent';
  const home = process.env.HOME || '/home/node';
  const transcriptDir = `${home}/.claude/projects/${projectHash}`;
  const transcriptPath = `${transcriptDir}/${continuation}.jsonl`;

  try {
    if (fs.existsSync(transcriptPath)) {
      const stat = fs.statSync(transcriptPath);
      const sizeKb = Math.round(stat.size / 1024);
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const transcriptLines = content.split('\n').filter((l: string) => l.trim());
      const messageCount = transcriptLines.length;

      // Extract token usage from the most recent assistant message with usage data
      let contextTokens: number | null = null;
      for (let i = transcriptLines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(transcriptLines[i]);
          const usage = obj?.message?.usage;
          if (usage && typeof usage.input_tokens === 'number') {
            contextTokens = (usage.input_tokens || 0)
              + (usage.cache_creation_input_tokens || 0)
              + (usage.cache_read_input_tokens || 0);
            break;
          }
        } catch { /* skip malformed lines */ }
      }

      lines.push(`Session: \`${continuation}\``);
      if (contextTokens !== null) {
        const threshold = Number(compactWindow);
        const pct = Math.round((contextTokens / threshold) * 100);
        lines.push(`Context: ${contextTokens.toLocaleString()} tokens (${pct}% of ${threshold.toLocaleString()} compact threshold)`);
      }
      lines.push(`Transcript: ${messageCount} messages, ${sizeKb.toLocaleString()} KB`);
    } else {
      lines.push(`Session: \`${continuation}\` (transcript not found)`);
    }
  } catch {
    lines.push(`Session: \`${continuation}\` (could not read transcript)`);
  }

  lines.push(`Auto-compact threshold: ${Number(compactWindow).toLocaleString()} tokens`);
  return lines.join('\n');
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);
    // PR #2440: session_routing is the authoritative reply channel set by the
    // host on every container wake. Override extractRouting (which reads
    // messages[0]) because agent-type inbound messages (e.g. approval
    // notifications) can appear first and misdirect replies to the agent
    // channel instead of the user's channel.
    const sessionRouting = getSessionRouting();
    if (sessionRouting.channel_type && sessionRouting.platform_id) {
      routing.channelType = sessionRouting.channel_type;
      routing.platformId = sessionRouting.platform_id;
      routing.threadId = sessionRouting.thread_id;
    }

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      // LOCAL-003: handle commands the Agent SDK ignores (CLI-only features)
      const runnerCmd = getRunnerHandledCommand(msg);
      if (runnerCmd) {
        const response = handleRunnerCommand(runnerCmd, continuation);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: response }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    resetToolVisStream();
    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // LOCAL-018: classify the thrown error (by the time a transient error is
      // thrown, the SDK has already exhausted its internal retries) for a
      // class-appropriate notice instead of a raw stack message, and emit an
      // operator-escalation line for terminal transient / client errors.
      const cls = classifyError({ message: errMsg });
      const text = cls.kind !== 'unknown' ? cls.userMessage : `Error: ${errMsg}`;
      if (cls.kind === 'server-error' || cls.kind === 'network' || cls.kind === 'bad-request') {
        log(`ESCALATION api-error kind=${cls.kind} msg=${errMsg.slice(0, 200)}`);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text }),
      });
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Per-batch scope. Reset whenever a fresh follow-up batch is pushed
  // (alongside unwrappedNudged) so each turn gets at most one classified
  // notice but the next turn can fire one too.
  let errorClassified = false;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        errorClassified = false;
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        resetToolVisStream();
        markCompleted(initialBatchIds);
        if (event.text) {
          const { hasUnwrapped, droppedDestinations } = dispatchResultText(event.text, routing);
          if (droppedDestinations.length > 0) {
            sendDropNotice(
              `Message delivery failed — unknown destination(s): ${droppedDestinations.join(', ')}. The response was lost.`,
              routing,
            );
          }
          if (hasUnwrapped && !unwrappedNudged && !errorClassified) {
            unwrappedNudged = true;
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                `Your destinations: ${names}. ` +
                `Please re-send your response with the correct wrapping.</system>`,
            );
          } else if (hasUnwrapped && unwrappedNudged && !errorClassified) {
            sendDropNotice(
              `Agent response was not delivered — it was not wrapped in message tags, and the retry also failed. Please re-send your last message.`,
              routing,
            );
          }
          // If errorClassified === true and hasUnwrapped, do nothing — the
          // user already received a classified error message (rate-limit,
          // auth, etc.) and re-prompting them about XML wrapping would be
          // confusing and wrong.
        }
      } else if (event.type === 'error') {
        if (errorClassified) {
          log('Additional error suppressed — already classified one this batch');
          // Early-break guard: if 2+ distinct errors fire in one turn, the
          // user gets exactly one notice (the first), not a spam of them.
        } else {
          const cls = classifyError(event);
          // Retryable gate: SDK marks transient errors retryable=true and
          // handles them via internal retry. Only surface notices for terminal
          // errors (retryable=false) that need user/operator action. Keeps
          // happy-path Docker container behavior invisible to the user.
          if (cls.kind !== 'unknown' && event.retryable === false) {
            sendErrorNotice(cls.userMessage, routing);
            errorClassified = true;
          }
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
export function dispatchResultText(
  text: string,
  routing: RoutingContext,
): { sent: number; hasUnwrapped: boolean; droppedDestinations: string[] } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];
  const droppedDestinations: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      droppedDestinations.push(toName);
      continue;
    }
    const destPlatformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
    const destChannelType = dest.type === 'channel' ? dest.channelType! : 'agent';
    if (wasDeliveredViaMcp(destChannelType, destPlatformId)) {
      // Agent already sent to this destination via send_message/send_file
      // earlier in the turn. Skip the XML duplicate. Counts as sent so the
      // unwrapped-text nudge doesn't fire.
      log(`Skipping <message to="${toName}"> — destination already delivered via MCP tool this turn`);
      sent++;
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped, droppedDestinations };
}

function sendDropNotice(notice: string, routing: RoutingContext): void {
  const sessionRouting = getSessionRouting();
  if (!sessionRouting.platform_id) return;
  log(`Sending drop notice: ${notice}`);
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: sessionRouting.platform_id,
    channel_type: sessionRouting.channel_type,
    thread_id: sessionRouting.thread_id,
    content: JSON.stringify({ text: `⚠️ ${notice}` }),
  });
}

/**
 * Send a classified-error notice to the user. The classified message
 * already includes its own emoji/prefix, so we don't prepend `⚠️` like
 * sendDropNotice does. Same routing pattern: writes to outbound DB; host
 * delivery picks it up via session_routing.
 */
function sendErrorNotice(notice: string, routing: RoutingContext): void {
  const sessionRouting = getSessionRouting();
  if (!sessionRouting.platform_id) return;
  log(`Sending error notice: ${notice}`);
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: sessionRouting.platform_id,
    channel_type: sessionRouting.channel_type,
    thread_id: sessionRouting.thread_id,
    content: JSON.stringify({ text: notice }),
  });
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
