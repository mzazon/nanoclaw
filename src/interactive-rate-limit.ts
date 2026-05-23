export interface ResetSpec {
  weekday?: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  time: string;
  tz?: string;
}

export interface SessionLatches {
  quotaWarned: {
    session: Set<number>;
    weekly: Set<number>;
    Opus: Set<number>;
  };
  rateLimitScheduled: {
    resetAt: number;
    timeoutHandle: NodeJS.Timeout;
    sessionEpoch: string;
  } | null;
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
function tzOffsetForDate(
  targetTz: string,
  y: number, mo: number, d: number, h: number, min: number,
): number {
  // Build a UTC timestamp as if those wall-clock components were UTC, then
  // compare to what Intl reports for that timestamp in the target tz.
  const utcMs = Date.UTC(y, mo, d, h, min);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: targetTz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hour12: false,
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
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(now));
    const get = (t: string) => nowParts.find((p) => p.type === t)?.value ?? '0';
    const y = parseInt(get('year'), 10);
    const mo = parseInt(get('month'), 10) - 1;
    let d = parseInt(get('day'), 10);

    // Bug 1 fix: compute offset for the TARGET date (not now) to handle DST transitions.
    // First pass: figure out if we need to roll to the next day, using now's offset as an
    // approximation, then recompute the offset for the actual target date.
    const nowOffsetMs = tzOffsetForDate(targetTz, y, mo, d,
      parseInt(get('hour'), 10), parseInt(get('minute'), 10));

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
    if (spec.weekday) {
      let dayMs = candidate;
      for (let i = 0; i < 8; i++) {
        const dayParts = new Intl.DateTimeFormat('en-US', {
          timeZone: targetTz,
          weekday: 'short',
        }).formatToParts(new Date(dayMs));
        const wdStr = dayParts.find((p) => p.type === 'weekday')?.value;
        if (wdStr === spec.weekday) break;
        dayMs += ONE_DAY_MS;
      }
      candidate = dayMs;
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
      quotaWarned: { session: new Set(), weekly: new Set(), Opus: new Set() },
      rateLimitScheduled: null,
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
}
