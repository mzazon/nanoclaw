/**
 * Interactive session lifecycle guard — integrated into host-sweep.
 *
 * Scans the PTY output buffer for known modals (rate-limit, auth, context,
 * policy, etc.) and decides whether to send a keystroke, kill, or kill-respawn.
 */
import { log } from './log.js';
import {
  parseResetTime,
  computeResetMs,
  type ResetSpec,
  type SessionLatches,
} from './interactive-rate-limit.js';
import type { RespawnFlags } from './interactive-runner.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;
const AUTO_MODE_GRACE_MS = 2 * 60 * 1000;
const NETWORK_GRACE_MS = 5 * 60 * 1000;
const TAIL_SCAN_CHARS = 4000;

export type BufferSignal =
  | 'rate-limit'
  | 'quota-warning'
  | 'dev-prompt'
  | 'auth-required'
  | 'context-overflow'
  | 'policy-refusal'
  | 'auto-mode-block'
  | 'network-block'
  | 'model-error'
  | null;

export type LimitType = 'session' | 'weekly' | 'Opus' | 'unknown';

export interface ScanResult {
  signal: BufferSignal;
  limitType?: LimitType;
  percent?: number;
  resetSpec?: ResetSpec | null;
}

export type GuardAction =
  | 'send-enter'
  | 'kill'
  | 'kill-respawn'
  | 'kill-respawn-noContinue'
  | 'kill-idle'
  | 'rate-limit-schedule'
  | 'quota-warning-notify'
  | 'ok';

// Regex anchors — see spec §"Regex anchors" for citations.
const HEADLINE_RE = /You(?:'|’)ve hit your\s*(?:session|weekly|Opus|)?\s?limit/i;
const LEGACY_RE = /(Claude (?:AI )?usage limit reached|5-hour limit reached)/i;
const MENU_RE = /(Stop and wait for limit|Upgrade your plan)/;
const QUOTA_WARNING_RE = /You(?:'|’)ve used (\d+)% of your (session|weekly|Opus) limit/i;
const LIMIT_TYPE_RE = /\b(session|weekly|Opus)\s+limit\b/i;

const AUTH_RE =
  /(Please run \/login|Not logged in|OAuth token (?:revoked|has expired|does not meet scope)|Invalid API key|organization has been disabled|disabled Claude subscription access|authentication_error)/i;
// "exceeded context window" / "Image was too large" are the weakest anchors
// here — agent prose could include them. Mitigations: (1) tail-slice limits
// scan to last 4000 chars so older self-description scrolls away; (2) the
// kill-respawn-noContinue action is recoverable (user re-sends, fresh context).
// Bare "Conversation too long" was removed because "Error during compaction"
// already catches the canonical CC framing for that case.
const CONTEXT_OVERFLOW_RE =
  /(Prompt is too long|Error during compaction|Request too large \(max \d+ MB\)|Image was too large|exceeded context window)/i;
const POLICY_REFUSAL_RE = /violate our Usage Policy/i;
const AUTO_MODE_RE =
  /(auto mode cannot determine the safety|Auto mode could not evaluate this action|classifier transcript exceeded)/i;
const NETWORK_RE = /(Unable to connect to API|Credit balance is too low|Request rejected \(429\))/i;
const MODEL_ERROR_RE =
  /(There(?:'|’)s an issue with the selected model|Claude Opus is not available with the Claude Pro plan|thinking\.type\.enabled is not supported)/i;

export function scanPtyBuffer(buffer: string): ScanResult {
  const tail = buffer.length > TAIL_SCAN_CHARS ? buffer.slice(-TAIL_SCAN_CHARS) : buffer;

  // Priority 1: rate-limit (any of 3 anchors)
  if (HEADLINE_RE.test(tail) || LEGACY_RE.test(tail) || MENU_RE.test(tail)) {
    const limitTypeMatch = tail.match(LIMIT_TYPE_RE);
    const limitType: LimitType = limitTypeMatch
      ? (limitTypeMatch[1].toLowerCase() === 'opus'
          ? 'Opus'
          : (limitTypeMatch[1].toLowerCase() as 'session' | 'weekly'))
      : 'unknown';
    return {
      signal: 'rate-limit',
      limitType,
      resetSpec: parseResetTime(tail),
    };
  }

  // Priority 2: auth (operator escalation)
  if (AUTH_RE.test(tail)) return { signal: 'auth-required' };

  // Priority 3: model-error (operator escalation)
  if (MODEL_ERROR_RE.test(tail)) return { signal: 'model-error' };

  // Priority 4: context-overflow
  if (CONTEXT_OVERFLOW_RE.test(tail)) return { signal: 'context-overflow' };

  // Priority 5: policy-refusal
  if (POLICY_REFUSAL_RE.test(tail)) return { signal: 'policy-refusal' };

  // Priority 6: auto-mode-block (conditional action)
  if (AUTO_MODE_RE.test(tail)) return { signal: 'auto-mode-block' };

  // Priority 7: network-block (conditional action)
  if (NETWORK_RE.test(tail)) return { signal: 'network-block' };

  // Priority 8: quota-warning (informational)
  const quotaMatch = tail.match(QUOTA_WARNING_RE);
  if (quotaMatch) {
    const percent = parseInt(quotaMatch[1], 10);
    const limitType = (quotaMatch[2].toLowerCase() === 'opus'
      ? 'Opus'
      : (quotaMatch[2].toLowerCase() as 'session' | 'weekly')) as LimitType;
    return {
      signal: 'quota-warning',
      percent,
      limitType,
      resetSpec: parseResetTime(tail),
    };
  }

  // Priority 9: existing dev-prompt
  if (tail.includes('I am using this for local development')) {
    return { signal: 'dev-prompt' };
  }

  return { signal: null };
}

// Re-exports for consumer (host-sweep, will use these in Task 6)
export {
  STUCK_THRESHOLD_MS,
  IDLE_THRESHOLD_MS,
  AUTO_MODE_GRACE_MS,
  NETWORK_GRACE_MS,
};

// ---- decideAction ----

export interface DecideState {
  scan: ScanResult;
  latch: SessionLatches;            // per-session, caller looks up via getLatches
  heartbeatStaleMs: number;
  processAlive: boolean;
  pendingMessages: number;
}

export function decideAction(state: DecideState): GuardAction {
  const { scan, latch, heartbeatStaleMs, processAlive, pendingMessages } = state;

  switch (scan.signal) {
    case 'rate-limit':
      return latch.rateLimitScheduled !== null ? 'ok' : 'rate-limit-schedule';

    case 'quota-warning': {
      if (!scan.percent || !scan.limitType || scan.limitType === 'unknown') return 'ok';
      const bucket = scan.percent >= 100 ? 100 : scan.percent >= 99 ? 99 : 95;
      const seen = latch.quotaWarned[scan.limitType as 'session' | 'weekly' | 'Opus'];
      return seen.has(bucket) ? 'ok' : 'quota-warning-notify';
    }

    case 'dev-prompt':
      return 'send-enter';

    case 'auth-required':
      return 'kill';

    case 'model-error':
      return 'kill';

    case 'context-overflow':
      return 'kill-respawn-noContinue';

    case 'policy-refusal':
      return 'kill-respawn-noContinue';

    case 'auto-mode-block':
      return heartbeatStaleMs > AUTO_MODE_GRACE_MS && processAlive ? 'kill-respawn' : 'ok';

    case 'network-block':
      return heartbeatStaleMs > NETWORK_GRACE_MS && processAlive ? 'kill-respawn' : 'ok';

    case null:
      // No PTY signal — fall through to existing heartbeat-based heuristics
      if (latch.rateLimitScheduled !== null) return 'ok';   // suppression during rate-limit wait
      if (heartbeatStaleMs > STUCK_THRESHOLD_MS && processAlive && pendingMessages > 0) {
        return 'kill-respawn';
      }
      if (heartbeatStaleMs > IDLE_THRESHOLD_MS && processAlive && pendingMessages === 0) {
        return 'kill-idle';
      }
      return 'ok';
  }
}

// ---- executeAction ----

export interface ExecuteContext {
  sessionId: string;
  sessionEpoch: string;
  ptyWrite?: (data: string) => void;
  killProcess?: (respawnFlags?: RespawnFlags) => void;
  notify?: (text: string) => void;
  getEntry?: () => { sessionEpoch: string } | undefined;
}

export function executeAction(
  action: GuardAction,
  scan: ScanResult,
  latch: SessionLatches,
  ctx: ExecuteContext,
): void {
  switch (action) {
    case 'send-enter':
      ctx.ptyWrite?.('\r');
      log.info('Interactive guard: sent Enter keystroke', { sessionId: ctx.sessionId });
      return;

    case 'kill':
      log.info('Interactive guard: killing session (no respawn)', { sessionId: ctx.sessionId, signal: scan.signal });
      if (scan.signal === 'auth-required') {
        ctx.notify?.('🔒 Auth error — operator action required (run /login or fix credentials). Session killed.');
      } else if (scan.signal === 'model-error') {
        ctx.notify?.('🛠 Model config error — operator must fix `/model` selection. Session killed.');
      }
      ctx.killProcess?.();
      return;

    case 'kill-respawn':
      log.info('Interactive guard: kill-respawn', { sessionId: ctx.sessionId, signal: scan.signal });
      ctx.killProcess?.();
      return;

    case 'kill-respawn-noContinue':
      log.info('Interactive guard: kill-respawn (noContinue)', { sessionId: ctx.sessionId, signal: scan.signal });
      if (scan.signal === 'context-overflow') {
        ctx.notify?.('📏 My context filled up. Restarting with a fresh transcript — please re-state your last request.');
      } else if (scan.signal === 'policy-refusal') {
        ctx.notify?.('⚠️ Last response blocked by Anthropic Usage Policy. Restarting; please rephrase.');
      }
      ctx.killProcess?.({ noContinue: true });
      return;

    case 'kill-idle':
      log.info('Interactive guard: killing idle session', { sessionId: ctx.sessionId });
      ctx.killProcess?.();
      return;

    case 'rate-limit-schedule': {
      ctx.ptyWrite?.('\r');   // accept "Stop and wait" default
      const now = Date.now();
      const computed = computeResetMs(scan.resetSpec ?? null);
      const resetAt = Number.isFinite(computed) ? computed : now + 60 * 60 * 1000;

      const limitLabel = scan.limitType && scan.limitType !== 'unknown' ? ` (${scan.limitType})` : '';
      const whenLabel = scan.resetSpec
        ? `${scan.resetSpec.weekday ? scan.resetSpec.weekday + ' ' : ''}${scan.resetSpec.time}${scan.resetSpec.tz ? ' ' + scan.resetSpec.tz : ''}`
        : `in ~${Math.round((resetAt - now) / 60_000)} min`;
      ctx.notify?.(
        `⏸ Rate limited${limitLabel} — resets at ${whenLabel}. Your message is queued; I'll respond when the limit lifts.`,
      );

      const sessionEpoch = ctx.sessionEpoch;
      const timeoutHandle = setTimeout(() => {
        const entry = ctx.getEntry?.();
        if (!entry) return;
        if (entry.sessionEpoch !== sessionEpoch) {
          log.info('Rate-limit timer fired but session epoch changed — skipping', {
            sessionId: ctx.sessionId,
            armedEpoch: sessionEpoch,
            currentEpoch: entry.sessionEpoch,
          });
          return;
        }
        log.info('Rate-limit timer firing — kill+respawn', { sessionId: ctx.sessionId });
        ctx.killProcess?.();   // default flags → continueSession stays true
        // Defensive: clear the latch even if onSessionDestroyed doesn't fire (killProcess no-op, etc.)
        // Without this, decideAction would suppress all future re-arms after this point.
        latch.rateLimitScheduled = null;
      }, Math.max(0, resetAt - now + 30_000));

      latch.rateLimitScheduled = { resetAt, timeoutHandle, sessionEpoch };
      log.info('Rate-limit scheduled', { sessionId: ctx.sessionId, resetAt: new Date(resetAt).toISOString() });
      return;
    }

    case 'quota-warning-notify': {
      if (!scan.percent || !scan.limitType || scan.limitType === 'unknown') return;
      const bucket = scan.percent >= 100 ? 100 : scan.percent >= 99 ? 99 : 95;
      latch.quotaWarned[scan.limitType as 'session' | 'weekly' | 'Opus'].add(bucket);
      const whenLabel = scan.resetSpec
        ? `${scan.resetSpec.weekday ? scan.resetSpec.weekday + ' ' : ''}${scan.resetSpec.time}${scan.resetSpec.tz ? ' ' + scan.resetSpec.tz : ''}`
        : 'soon';
      ctx.notify?.(
        `⚠️ Heads up — at ${scan.percent}% of my ${scan.limitType} limit. If I stop responding, resets at ${whenLabel}.`,
      );
      return;
    }

    case 'ok':
      return;
  }
}
