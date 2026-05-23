/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Writes to outbound.db only to clear continuations before wake (container
 *     is confirmed stopped, so the single-writer-per-file invariant holds)
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getActiveSessions, getSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { applyHostPreTaskScripts } from './host-task-script.js';
import { getLatches } from './interactive-rate-limit.js';
import type { RespawnFlags } from './interactive-runner.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  heartbeatPath,
  sessionDir,
  writeOutboundDirect,
} from './session-manager.js';
import {
  isContainerRunning,
  killContainer,
  wakeContainer,
  getInteractiveEntry,
  getContainerName,
} from './container-runner.js';
import type { ContainerConfigRow, Session } from './types.js';

function parseFreshContext(config: ContainerConfigRow): string | null {
  return config.fresh_context ?? null;
}

function isInteractiveRuntime(runtime: string | undefined | null): boolean {
  return runtime === 'interactive' || runtime === 'cc-container';
}

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/**
 * If any due message is a recurring task, clear the provider continuation so
 * the container starts a fresh agent conversation. Safe to call only when
 * the container is confirmed stopped (!isContainerRunning passed).
 */
function clearContinuationForRecurringTasks(inDb: Database.Database, agentGroupId: string, sessionId: string): void {
  if (!hasDueRecurringTask(inDb)) return;

  const outDb = openOutboundDbRw(agentGroupId, sessionId);
  try {
    clearContinuations(outDb, sessionId);
  } finally {
    outDb.close();
  }
}

function hasDueRecurringTask(inDb: Database.Database): boolean {
  return !!inDb
    .prepare(
      `SELECT 1 FROM messages_in
       WHERE status = 'pending' AND trigger = 1 AND recurrence IS NOT NULL
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
       LIMIT 1`,
    )
    .get();
}

function clearContinuations(outDb: Database.Database, sessionId: string, reason?: string): number {
  const result = outDb.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'").run();
  if (result.changes > 0) {
    log.info('Cleared continuation for fresh start', { sessionId, reason: reason ?? 'recurring-task' });
  }
  return result.changes;
}

export function _clearContinuationForRecurringTasksForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  sessionId: string,
): number {
  if (!hasDueRecurringTask(inDb)) return 0;
  return clearContinuations(outDb, sessionId);
}

function clearContinuationIfFreshContext(
  freshContext: string | null | undefined,
  agentGroupId: string,
  sessionId: string,
): boolean {
  if (freshContext !== 'always') return false;

  const outDb = openOutboundDbRw(agentGroupId, sessionId);
  try {
    clearContinuations(outDb, sessionId, 'fresh-context-always');
  } finally {
    outDb.close();
  }
  return true;
}

export function _clearContinuationIfFreshContextForTesting(
  outDb: Database.Database,
  freshContext: string | null | undefined,
): number {
  if (freshContext !== 'always') return 0;
  return clearContinuations(outDb, 'test-session', 'fresh-context-always');
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      const configRow = getContainerConfig(agentGroup.id);
      const freshContext = configRow ? parseFreshContext(configRow) : null;
      if (!clearContinuationIfFreshContext(freshContext, agentGroup.id, session.id)) {
        clearContinuationForRecurringTasks(inDb, agentGroup.id, session.id);
      }
      if (isInteractiveRuntime(configRow?.runtime)) {
        const dueRows = inDb
          .prepare(
            `SELECT * FROM messages_in
             WHERE status = 'pending' AND trigger = 1
               AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
          )
          .all() as any[];
        const remaining = await applyHostPreTaskScripts(inDb, dueRows);
        if (remaining.length > 0) {
          log.info('Waking container for due messages', { sessionId: session.id, count: remaining.length });
          await wakeContainer(session);
        }
      } else {
        log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
        // wakeContainer never throws — transient spawn failures (OneCLI down,
        // etc.) return false and leave messages pending for the next tick.
        await wakeContainer(session);
      }
    }

    const alive = isContainerRunning(session.id);

    // 2a. Script gate for running interactive sessions. The bridge filters out
    // script-gated tasks, so they sit pending until the sweep evaluates them.
    if (alive && isInteractiveRuntime(getContainerConfig(agentGroup.id)?.runtime)) {
      const scriptTasks = inDb
        .prepare(
          `SELECT * FROM messages_in
           WHERE status = 'pending' AND trigger = 1 AND kind = 'task'
             AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
        )
        .all() as any[];
      if (scriptTasks.length > 0) {
        await applyHostPreTaskScripts(inDb, scriptTasks);
      }
    }

    // 2b. Interactive session guard — scan PTY buffer for blocking modals.
    const interactiveEntry = getInteractiveEntry(session.id);
    if (alive && interactiveEntry) {
      const { scanPtyBuffer, decideAction, executeAction } = await import('./interactive-guard.js');
      const scan = scanPtyBuffer(interactiveEntry.ptyBuffer.data);
      if (scan.signal) {
        log.warn(
          `Interactive guard: signal=${scan.signal} limitType=${scan.limitType ?? '-'} percent=${scan.percent ?? '-'} session=${session.id} buffer=${JSON.stringify(interactiveEntry.ptyBuffer.data.slice(-2000))}`,
        );
      }
      const hbMtime = heartbeatMtimeMs(agentGroup.id, session.id);
      // No heartbeat yet = bridge hasn't started polling. Use process spawn
      // time as baseline so the guard doesn't treat it as infinitely stale.
      const hbStaleMs =
        hbMtime === 0
          ? Date.now() - (interactiveEntry.process.pid ? (interactiveEntry.spawnedAt ?? Date.now()) : Date.now())
          : Date.now() - hbMtime;

      // Read bridge unresponsiveness marker (TOCTOU-safe: stat can race with
      // marker cleanup in the bridge; treat ENOENT as "no marker present").
      const markerPath = path.join(sessionDir(agentGroup.id, session.id), '.cc-unresponsive');
      let markerStaleMs = 0;
      let markerExists = false;
      try {
        const stat = fs.statSync(markerPath);
        markerExists = true;
        markerStaleMs = Date.now() - stat.mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      const latch = getLatches(session.id);
      const sessionEpoch = `${session.id}:${interactiveEntry.spawnedAt ?? 0}`;

      // Bridge marker says CC stopped responding. If there's no PTY signal
      // explaining it (modal, quota notice, etc.) AND we're not already in a
      // scheduled rate-limit wait, treat as silent-stuck and kill-respawn.
      // Rate-limit wait takes priority — we don't want to interrupt the timer.
      if (markerExists && scan.signal === null && latch.rateLimitScheduled === null) {
        log.warn(
          `Bridge marker detected silent stuck — kill-respawn session=${session.id} markerStaleMs=${markerStaleMs}`,
        );
        killContainer(session.id, `bridge-unresponsive-${markerStaleMs}ms`);
        // Skip the rest of the sweep tick for this session — the container is
        // dying, decideAction would just race with that. Recurrence/etc. will
        // pick up on the next tick once the container is fully gone.
        return;
      }

      const action = decideAction({
        scan,
        latch,
        heartbeatStaleMs: hbStaleMs,
        processAlive: true,
        pendingMessages: dueCount,
      });

      if (action !== 'ok') {
        log.warn(
          `Interactive guard: action=${action} signal=${scan.signal ?? '-'} hbStaleMs=${hbStaleMs} pending=${dueCount} session=${session.id}`,
        );

        const killWithFlags = (flags?: RespawnFlags) => killContainer(session.id, `interactive-guard-${action}`, flags);

        const notify = (text: string) => {
          try {
            const sess = getSession(session.id);
            if (!sess) return;
            let platformId: string | null = null;
            let channelType: string | null = null;
            if (sess.messaging_group_id) {
              const mg = getMessagingGroup(sess.messaging_group_id);
              if (mg) {
                platformId = mg.platform_id;
                channelType = mg.channel_type;
              }
            }
            writeOutboundDirect(agentGroup.id, session.id, {
              id: `guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              platformId,
              channelType,
              threadId: sess.thread_id ?? null,
              content: JSON.stringify({ text }),
            });
          } catch (err) {
            log.error('Interactive guard: notify write failed', { sessionId: session.id, err });
          }
        };

        const containerName = getContainerName(session.id);
        const isCcContainerSession = !!containerName && !interactiveEntry.process.stdin;

        executeAction(action, scan, latch, {
          sessionId: session.id,
          sessionEpoch,
          ptyWrite: (data: string) => {
            if (isCcContainerSession && containerName) {
              try {
                const { sendCcContainerKeystroke } = require('./cc-container-runner.js');
                sendCcContainerKeystroke(containerName, data);
              } catch (err) {
                log.warn('cc-container keystroke failed', { sessionId: session.id, err });
              }
            } else {
              interactiveEntry.process.stdin?.write(data);
            }
          },
          killProcess: killWithFlags,
          notify,
          // LIVE LOOKUP — captures the active map, NOT a stale entry. The
          // rate-limit timer fires minutes/hours later; by then the entry may
          // have been replaced by a respawn, so we must re-read each time.
          getEntry: () => {
            const e = getInteractiveEntry(session.id);
            return e ? { sessionEpoch: `${session.id}:${e.spawnedAt ?? 0}` } : undefined;
          },
        });

        if (action === 'send-enter') {
          interactiveEntry.ptyBuffer.data = '';
        }
      }
    }

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    // Interactive sessions are handled by the guard above — skip the
    // standard SLA which would issue competing kill decisions.
    if (alive && outDb && !interactiveEntry) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
