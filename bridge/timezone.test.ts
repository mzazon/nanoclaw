import { describe, test, expect } from 'bun:test';
import { parseZonedToUtc } from './timezone.ts';

describe('parseZonedToUtc', () => {
  test('naive timestamp interpreted in given timezone', () => {
    // EST is UTC-5 in January
    const result = parseZonedToUtc('2026-01-15T21:00:00', 'America/New_York');
    expect(result.toISOString()).toBe('2026-01-16T02:00:00.000Z');
  });

  test('UTC string passes through unchanged', () => {
    const result = parseZonedToUtc('2026-01-15T21:00:00Z', 'America/New_York');
    expect(result.toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });

  test('offset string passes through unchanged', () => {
    const result = parseZonedToUtc('2026-01-15T21:00:00+05:00', 'America/New_York');
    expect(result.toISOString()).toBe('2026-01-15T16:00:00.000Z');
  });

  test('invalid input returns NaN date', () => {
    const result = parseZonedToUtc('not-a-date', 'America/New_York');
    expect(Number.isNaN(result.getTime())).toBe(true);
  });

  test('invalid timezone falls back to UTC', () => {
    const result = parseZonedToUtc('2026-01-15T21:00:00', 'Invalid/Zone');
    expect(result.toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });
});
