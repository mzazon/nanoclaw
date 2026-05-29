import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseResetTime,
  computeResetMs,
  getLatches,
  onSessionDestroyed,
  __resetLatchesForTest,
  recordApiError,
  getApiErrorAttempts,
  clearApiErrorAttempts,
  shouldAlertApiError,
  API_ERROR_CAP,
  API_ERROR_RESET_WINDOW_MS,
  API_ERROR_ALERT_COOLDOWN_MS,
  type SessionLatches,
} from './interactive-rate-limit.js';

describe('parseResetTime', () => {
  it('parses "resets 1pm (America/New_York)"', () => {
    expect(parseResetTime("You've hit your weekly limit · resets 1pm (America/New_York)")).toEqual({
      weekday: undefined,
      time: '1pm',
      tz: 'America/New_York',
    });
  });

  it('parses "resets Mon 12:00am" with weekday', () => {
    expect(parseResetTime('resets Mon 12:00am')).toEqual({
      weekday: 'Mon',
      time: '12:00am',
      tz: undefined,
    });
  });

  it('parses "resets 1:30pm" with minutes, no tz', () => {
    expect(parseResetTime('resets 1:30pm')).toEqual({
      weekday: undefined,
      time: '1:30pm',
      tz: undefined,
    });
  });

  it('returns null when no reset clause present', () => {
    expect(parseResetTime('nothing here')).toBeNull();
  });
});

describe('computeResetMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T17:00:00Z')); // 1pm ET
  });
  afterEach(() => vi.useRealTimers());

  it('returns NaN for null', () => {
    expect(Number.isNaN(computeResetMs(null))).toBe(true);
  });

  it('parses absolute time with tz', () => {
    const now = Date.now();
    const result = computeResetMs({ time: '2pm', tz: 'America/New_York' });
    // 1pm ET now → 2pm ET = +1h
    expect(result - now).toBeGreaterThan(50 * 60_000);
    expect(result - now).toBeLessThan(70 * 60_000);
  });

  it('handles missing tz by falling back to local TZ', () => {
    const result = computeResetMs({ time: '2pm' });
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('getLatches', () => {
  beforeEach(() => __resetLatchesForTest());

  it('lazy-creates fresh latch on first call', () => {
    const latch = getLatches('s1');
    expect(latch.quotaWarned.session.size).toBe(0);
    expect(latch.quotaWarned.weekly.size).toBe(0);
    expect(latch.quotaWarned.Opus.size).toBe(0);
    expect(latch.rateLimitScheduled).toBeNull();
  });

  it('returns same instance on subsequent calls', () => {
    const a = getLatches('s1');
    const b = getLatches('s1');
    expect(a).toBe(b);
  });

  it('different session ids → different latches', () => {
    expect(getLatches('s1')).not.toBe(getLatches('s2'));
  });
});

describe('computeResetMs — DST transitions', () => {
  it('spring forward 2026-03-08 ET: 1am EST → 3pm EDT same day', () => {
    vi.useFakeTimers();
    // 2026-03-08T06:00:00Z = 1am EST (before spring forward at 2am)
    vi.setSystemTime(new Date('2026-03-08T06:00:00Z'));
    const result = computeResetMs({ time: '3pm', tz: 'America/New_York' });
    // 3pm EDT = 19:00 UTC = 2026-03-08T19:00:00Z
    expect(new Date(result).toISOString()).toBe('2026-03-08T19:00:00.000Z');
    vi.useRealTimers();
  });

  it('fall back 2026-11-01 ET: 1am EDT → 3pm EST same day', () => {
    vi.useFakeTimers();
    // 2026-11-01T05:00:00Z = 1am EDT (before fall back at 2am)
    vi.setSystemTime(new Date('2026-11-01T05:00:00Z'));
    const result = computeResetMs({ time: '3pm', tz: 'America/New_York' });
    // 3pm EST = 20:00 UTC = 2026-11-01T20:00:00Z
    expect(new Date(result).toISOString()).toBe('2026-11-01T20:00:00.000Z');
    vi.useRealTimers();
  });
});

describe('computeResetMs — weekly resets', () => {
  it('Mon target from Friday: 3-day-forward target preserved (not clamped to 1h)', () => {
    vi.useFakeTimers();
    // Friday 2026-05-22 at noon ET
    vi.setSystemTime(new Date('2026-05-22T16:00:00Z'));
    const result = computeResetMs({ weekday: 'Mon', time: '12:00am', tz: 'America/New_York' });
    const now = Date.now();
    // Should be roughly 60h away (Fri noon → Mon midnight = ~60h)
    // Not clamped to now + 1h
    expect(result - now).toBeGreaterThan(48 * 60 * 60_000); // > 48h
    expect(result - now).toBeLessThan(8 * 24 * 60 * 60_000); // < 8d
    vi.useRealTimers();
  });

  it('weekly target across UTC midnight: Sun 11pm ET resolves to Sun in ET, not Mon UTC', () => {
    vi.useFakeTimers();
    // Friday 2026-05-22 noon ET
    vi.setSystemTime(new Date('2026-05-22T16:00:00Z'));
    const result = computeResetMs({ weekday: 'Sun', time: '11pm', tz: 'America/New_York' });
    // Expected: Sunday 2026-05-24 23:00 ET = 2026-05-25T03:00:00Z (EDT, offset -4)
    expect(new Date(result).toISOString()).toBe('2026-05-25T03:00:00.000Z');
    vi.useRealTimers();
  });

  it('weekly target across spring-forward DST: Sat noon → Sun 11pm ET resolves correctly', () => {
    vi.useFakeTimers();
    // Saturday 2026-03-07 noon ET (still EST, day before spring forward)
    vi.setSystemTime(new Date('2026-03-07T17:00:00Z'));
    const result = computeResetMs({ weekday: 'Sun', time: '11pm', tz: 'America/New_York' });
    // Expected: Sunday 2026-03-08 23:00 EDT = 2026-03-09T03:00:00Z
    expect(new Date(result).toISOString()).toBe('2026-03-09T03:00:00.000Z');
    vi.useRealTimers();
  });

  it('weekly target across fall-back DST: Sat noon Oct 31 → Sun 1:30am ET resolves correctly', () => {
    vi.useFakeTimers();
    // Saturday 2026-10-31 noon ET (still EDT)
    vi.setSystemTime(new Date('2026-10-31T16:00:00Z'));
    const result = computeResetMs({ weekday: 'Sun', time: '1:30am', tz: 'America/New_York' });
    // Sun Nov 1 1:30am ET — ambiguous but tests existing code's resolution.
    // Verify result is finite and after now (regression safety).
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(Date.now());
    vi.useRealTimers();
  });
});

describe('onSessionDestroyed', () => {
  beforeEach(() => __resetLatchesForTest());

  it('clears rate-limit timeout and deletes entry', () => {
    const latch = getLatches('s1');
    const handle = setTimeout(() => {}, 999_999);
    latch.rateLimitScheduled = { resetAt: Date.now() + 1000, timeoutHandle: handle, sessionEpoch: 's1:1' };
    onSessionDestroyed('s1');
    // Subsequent getLatches returns a fresh entry (no scheduled latch)
    expect(getLatches('s1').rateLimitScheduled).toBeNull();
  });

  it('is safe to call for unknown session', () => {
    expect(() => onSessionDestroyed('never-existed')).not.toThrow();
  });
});

// ---- LOCAL-018: api-error attempt counter ----
describe('api-error attempt counter [LOCAL-018]', () => {
  afterEach(() => clearApiErrorAttempts('s1'));

  it('increments within the window', () => {
    const t = 1_000_000;
    expect(recordApiError('s1', t)).toBe(1);
    expect(recordApiError('s1', t + 1000)).toBe(2);
    expect(getApiErrorAttempts('s1')).toBe(2);
  });

  it('resets after the window elapses', () => {
    const t = 1_000_000;
    recordApiError('s1', t);
    expect(recordApiError('s1', t + API_ERROR_RESET_WINDOW_MS + 1)).toBe(1);
  });

  it('SURVIVES onSessionDestroyed (the bug this guards against)', () => {
    const t = 1_000_000;
    expect(recordApiError('s1', t)).toBe(1);
    onSessionDestroyed('s1'); // fires on every kill-respawn
    expect(recordApiError('s1', t + 1000)).toBe(2); // NOT reset to 1
  });

  it('clearApiErrorAttempts resets', () => {
    recordApiError('s1', 1);
    clearApiErrorAttempts('s1');
    expect(getApiErrorAttempts('s1')).toBe(0);
  });

  it('cap is 3', () => expect(API_ERROR_CAP).toBe(3));
});

// ---- LOCAL-018: escalation alert cooldown ----
describe('shouldAlertApiError — escalation throttle [LOCAL-018]', () => {
  afterEach(() => clearApiErrorAttempts('a1'));

  it('allows the first alert, blocks within the cooldown, allows after', () => {
    const t = 2_000_000;
    recordApiError('a1', t); // create entry
    expect(shouldAlertApiError('a1', t)).toBe(true); // first
    expect(shouldAlertApiError('a1', t + 1000)).toBe(false); // within cooldown
    expect(shouldAlertApiError('a1', t + API_ERROR_ALERT_COOLDOWN_MS + 1)).toBe(true); // after
  });

  it('allows the first alert even with no prior recordApiError', () => {
    expect(shouldAlertApiError('a2', 5_000_000)).toBe(true);
    clearApiErrorAttempts('a2');
  });
});
