/**
 * Interactive session lifecycle guard — integrated into host-sweep.
 *
 * Scans the PTY output buffer for known modals (rate-limit, auth, context,
 * policy, etc.) and decides whether to send a keystroke, kill, or kill-respawn.
 */
import { log } from './log.js';
import {
  parseResetTime,
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
const CONTEXT_OVERFLOW_RE =
  /(Prompt is too long|Error during compaction|Request too large \(max \d+ MB\)|Image was too large|exceeded context window|Conversation too long)/i;
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

// decideAction + executeAction in Task 5
