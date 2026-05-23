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

  // Sanity fallback: >24h future is implausible — use 1h instead.
  if (targetMs - now > ONE_DAY_MS) return now + ONE_HOUR_MS;

  return targetMs;
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
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(now));

    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
    const y = parseInt(get('year'), 10);
    const mo = parseInt(get('month'), 10) - 1;
    const d = parseInt(get('day'), 10);
    const currentHour = parseInt(get('hour'), 10);

    const probe = new Date(Date.UTC(y, mo, d, currentHour, parseInt(get('minute'), 10)));
    const tzOffsetMs = probe.getTime() - now;
    let candidate = new Date(Date.UTC(y, mo, d, hour, minute)).getTime() - tzOffsetMs;

    if (candidate < now - ONE_HOUR_MS) {
      candidate += ONE_DAY_MS;
    }

    if (spec.weekday) {
      const targetWd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(spec.weekday);
      let dayMs = candidate;
      for (let i = 0; i < 8; i++) {
        const wd = new Date(dayMs).getUTCDay();
        if (wd === targetWd) break;
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
