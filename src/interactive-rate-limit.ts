// LOCAL-012: Interactive rate-limit recovery — reset-time parser + session latches.
export interface ResetSpec {
  weekday?: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  time: string;
  tz?: string;
}

export interface SessionLatches {
  quotaWarned: {
    session: Set<number>;
    weekly: Set<number>;
    monthly: Set<number>;
    Opus: Set<number>;
  };
  rateLimitScheduled: {
    resetAt: number;
    timeoutHandle: NodeJS.Timeout;
    sessionEpoch: string;
  } | null;
  lastSignal: string | null;
  lastSignalAt: number;
}

const RESET_TIME_RE =
  /resets\s+(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+\(([^)]+)\))?/i;

export function parseResetTime(buffer: string): ResetSpec | null {
  const m = buffer.match(RESET_TIME_RE);
  if (!m) return null;
  return {
    weekday: m[1] as ResetSpec['weekday'],
    time: m[2].replace(/\s+/g, '').toLowerCase(),
    tz: m[3],
  };
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export function computeResetMs(spec: ResetSpec | null): number {
  if (!spec) return NaN;

  const now = Date.now();
  const tz = spec.tz;
  const targetMs = resolveAbsoluteEpoch(spec, now, tz);

  if (Number.isNaN(targetMs)) return NaN;

  // Slight-past clamp: lazy reset, clock skew. Recover quickly.
  if (targetMs < now) return now + ONE_MIN_MS;

  // Sanity fallback: >24h future is implausible for daily resets — use 1h instead.
  // Weekly resets can legitimately be 2-7 days out, so raise the upper bound when weekday is set.
  const upperBoundMs = spec.weekday ? 7 * ONE_DAY_MS + ONE_HOUR_MS : ONE_DAY_MS;
  if (targetMs - now > upperBoundMs) return now + ONE_HOUR_MS;

  return targetMs;
}

/** Compute the UTC offset (in ms) for a given Y/M/D/H/Min interpreted in `targetTz`. */
function tzOffsetForDate(targetTz: string, y: number, mo: number, d: number, h: number, min: number): number {
  // Build a UTC timestamp as if those wall-clock components were UTC, then
  // compare to what Intl reports for that timestamp in the target tz.
  const utcMs = Date.UTC(y, mo, d, h, min);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: targetTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const probeMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    parseInt(get('hour'), 10),
    parseInt(get('minute'), 10),
  );
  return probeMs - utcMs;
}

function resolveAbsoluteEpoch(spec: ResetSpec, now: number, tz?: string): number {
  const m = spec.time.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (!m) return NaN;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3].toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === 'pm') hour += 12;

  try {
    const targetTz = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Get current wall-clock date components in the target tz.
    const nowParts = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(new Date(now));
    const get = (t: string) => nowParts.find((p) => p.type === t)?.value ?? '0';
    const y = parseInt(get('year'), 10);
    const mo = parseInt(get('month'), 10) - 1;
    let d = parseInt(get('day'), 10);

    // Bug 1 fix: compute offset for the TARGET date (not now) to handle DST transitions.
    // First pass: figure out if we need to roll to the next day, using now's offset as an
    // approximation, then recompute the offset for the actual target date.
    const nowOffsetMs = tzOffsetForDate(targetTz, y, mo, d, parseInt(get('hour'), 10), parseInt(get('minute'), 10));

    // Initial candidate using now's offset (may be off by 1h on DST-transition days).
    let candidate = Date.UTC(y, mo, d, hour, minute) - nowOffsetMs;

    // If it's in the past (more than 1h ago), roll to next day.
    if (candidate < now - ONE_HOUR_MS) {
      d += 1;
    }

    // Now recompute offset for the actual target date so DST transitions are handled correctly.
    // `Date.UTC` normalises overflows (e.g. d=32 → first of next month) so we pass the
    // possibly-incremented `d` directly.
    const normDate = new Date(Date.UTC(y, mo, d));
    const ty = normDate.getUTCFullYear();
    const tmo = normDate.getUTCMonth();
    const td = normDate.getUTCDate();
    const targetOffsetMs = tzOffsetForDate(targetTz, ty, tmo, td, hour, minute);
    candidate = Date.UTC(ty, tmo, td, hour, minute) - targetOffsetMs;

    // Bug 3 fix: use Intl weekday in target tz (not getUTCDay()) to handle evening times
    // that cross UTC midnight.
    // Bug 4 fix: advance by calendar day in target tz (not by fixed ONE_DAY_MS) so that
    // DST transitions don't silently shift the wall-clock hour and cause the weekday check
    // to miss the target (e.g. spring-forward skipping Sun 11pm ET entirely).
    if (spec.weekday) {
      // Start from the already-normalised calendar day for the initial candidate.
      let cy = ty,
        cmo = tmo,
        cd = td;
      for (let i = 0; i < 8; i++) {
        // Recompute offset for this specific calendar day + target time (DST-safe).
        const offsetMs = tzOffsetForDate(targetTz, cy, cmo, cd, hour, minute);
        const epochMs = Date.UTC(cy, cmo, cd, hour, minute) - offsetMs;
        const dayParts = new Intl.DateTimeFormat('en-US', {
          timeZone: targetTz,
          weekday: 'short',
        }).formatToParts(new Date(epochMs));
        const wdStr = dayParts.find((p) => p.type === 'weekday')?.value;
        if (wdStr === spec.weekday) {
          candidate = epochMs;
          break;
        }
        // Advance by one calendar day; Date.UTC normalises month/year overflows.
        cd += 1;
        const next = new Date(Date.UTC(cy, cmo, cd));
        cy = next.getUTCFullYear();
        cmo = next.getUTCMonth();
        cd = next.getUTCDate();
      }
    }

    return candidate;
  } catch {
    return NaN;
  }
}

// ---- Session latches ----

const _latches: Map<string, SessionLatches> = new Map();

export function getLatches(sessionId: string): SessionLatches {
  let entry = _latches.get(sessionId);
  if (!entry) {
    entry = {
      quotaWarned: { session: new Set(), weekly: new Set(), monthly: new Set(), Opus: new Set() },
      rateLimitScheduled: null,
      lastSignal: null,
      lastSignalAt: 0,
    };
    _latches.set(sessionId, entry);
  }
  return entry;
}

export function onSessionDestroyed(sessionId: string): void {
  const entry = _latches.get(sessionId);
  if (entry?.rateLimitScheduled) {
    clearTimeout(entry.rateLimitScheduled.timeoutHandle);
  }
  _latches.delete(sessionId);
}

/** @internal — test-only reset; not exported from index */
export function __resetLatchesForTest(): void {
  for (const [id] of _latches) onSessionDestroyed(id);
  _apiErrorAttempts.clear(); // LOCAL-018
}

// ---- LOCAL-018: API-error attempt counter ----
// MUST live OUTSIDE SessionLatches: onSessionDestroyed (interactive-runner.ts:225,
// fired on EVERY child exit including a guard kill-respawn) deletes the latch entry.
// Storing the counter here, untouched by onSessionDestroyed, lets it survive the
// respawn that recovery itself triggers. Reset is time-window based (a fresh
// incident), never session-destroyed based.
export const API_ERROR_CAP = 3;
// 15 min, not 5: each incident takes ~3-4 sweep ticks to confirm (two-scan +
// respawn), and respawn latency spikes under the very load that produces 5xx.
// A short window resets the counter mid-outage → cap never reached (no
// escalation) AND every cycle looks like "attempt 1" (retry-notice spam). The
// window must comfortably exceed the slowest re-error cadence. LOCAL-018.
export const API_ERROR_RESET_WINDOW_MS = 15 * 60 * 1000;
// While a pending message keeps re-driving, the guard re-escalates every cycle.
// Gate operator/user escalation alerts to at most one per cooldown so the
// recovery loop stays quiet (recovery itself keeps running). LOCAL-018.
export const API_ERROR_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

interface ApiErrorEntry {
  attempts: number;
  lastErrorAt: number;
  lastAlertedAt: number;
}
const _apiErrorAttempts: Map<string, ApiErrorEntry> = new Map();

/** Record a confirmed api-error; returns the running attempt count. Starts a
 *  fresh count (and resets the alert cooldown) if the previous error was older
 *  than the reset window. */
export function recordApiError(sessionId: string, now: number): number {
  // Opportunistic prune of logically-expired entries (bounded memory).
  for (const [id, e] of _apiErrorAttempts) {
    if (id !== sessionId && now - e.lastErrorAt > API_ERROR_RESET_WINDOW_MS) {
      _apiErrorAttempts.delete(id);
    }
  }
  const e = _apiErrorAttempts.get(sessionId);
  if (!e || now - e.lastErrorAt > API_ERROR_RESET_WINDOW_MS) {
    _apiErrorAttempts.set(sessionId, { attempts: 1, lastErrorAt: now, lastAlertedAt: 0 });
    return 1;
  }
  e.attempts += 1;
  e.lastErrorAt = now;
  return e.attempts;
}

export function getApiErrorAttempts(sessionId: string): number {
  return _apiErrorAttempts.get(sessionId)?.attempts ?? 0;
}

/** Returns true (and stamps `lastAlertedAt`) when an escalation alert may fire
 *  now — i.e. none fired within API_ERROR_ALERT_COOLDOWN_MS. Throttles operator
 *  and user notices while the recovery loop keeps re-driving. */
export function shouldAlertApiError(sessionId: string, now: number): boolean {
  let e = _apiErrorAttempts.get(sessionId);
  if (!e) {
    e = { attempts: 0, lastErrorAt: now, lastAlertedAt: 0 };
    _apiErrorAttempts.set(sessionId, e);
  }
  if (e.lastAlertedAt !== 0 && now - e.lastAlertedAt < API_ERROR_ALERT_COOLDOWN_MS) {
    return false;
  }
  e.lastAlertedAt = now;
  return true;
}

/** Reset on a genuine clean turn. Deliberately NOT called from onSessionDestroyed. */
export function clearApiErrorAttempts(sessionId: string): void {
  _apiErrorAttempts.delete(sessionId);
}
