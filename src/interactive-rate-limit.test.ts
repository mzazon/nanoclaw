import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseResetTime,
  computeResetMs,
  getLatches,
  onSessionDestroyed,
  __resetLatchesForTest,
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
    expect(parseResetTime("resets Mon 12:00am")).toEqual({
      weekday: 'Mon',
      time: '12:00am',
      tz: undefined,
    });
  });

  it('parses "resets 1:30pm" with minutes, no tz', () => {
    expect(parseResetTime("resets 1:30pm")).toEqual({
      weekday: undefined,
      time: '1:30pm',
      tz: undefined,
    });
  });

  it('returns null when no reset clause present', () => {
    expect(parseResetTime("nothing here")).toBeNull();
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
