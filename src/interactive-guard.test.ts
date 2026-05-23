import { describe, test, expect } from 'vitest';
import { scanPtyBuffer } from './interactive-guard.js';

describe('scanPtyBuffer — rate-limit (3-layer regex)', () => {
  test('HEADLINE matches "You\'ve hit your weekly limit"', () => {
    const r = scanPtyBuffer("You've hit your weekly limit · resets 1pm (America/New_York)");
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('weekly');
    expect(r.resetSpec).toEqual({ weekday: undefined, time: '1pm', tz: 'America/New_York' });
  });

  test('HEADLINE matches 5-hour ("session") limit', () => {
    const r = scanPtyBuffer("You've hit your session limit · resets 3:45pm");
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('session');
  });

  test('HEADLINE matches Opus limit', () => {
    const r = scanPtyBuffer("You've hit your Opus limit · resets 3:45pm");
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('Opus');
  });

  test('HEADLINE matches typographic apostrophe', () => {
    const r = scanPtyBuffer("You’ve hit your weekly limit · resets 1pm");
    expect(r.signal).toBe('rate-limit');
  });

  test('HEADLINE matches elided form (v2.1.123)', () => {
    const r = scanPtyBuffer("You've hit your limit · resets 9:40pm (Europe/Madrid)");
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('unknown');
  });

  test('MENU layer matches even without headline', () => {
    const r = scanPtyBuffer("❯ 1. Stop and wait for limit to reset");
    expect(r.signal).toBe('rate-limit');
  });

  test('MENU "Upgrade your plan" matches', () => {
    const r = scanPtyBuffer("  2. Upgrade your plan");
    expect(r.signal).toBe('rate-limit');
  });

  test('LEGACY wording matches', () => {
    const r = scanPtyBuffer("Claude usage limit reached. Your limit will reset at Oct 7, 1am.");
    expect(r.signal).toBe('rate-limit');
  });
});

describe('scanPtyBuffer — quota-warning', () => {
  test('extracts percent + weekly', () => {
    const r = scanPtyBuffer("You've used 98% of your weekly limit · resets 1pm");
    expect(r.signal).toBe('quota-warning');
    expect(r.percent).toBe(98);
    expect(r.limitType).toBe('weekly');
  });

  test('extracts session', () => {
    const r = scanPtyBuffer("You've used 95% of your session limit · resets 3:45pm");
    expect(r.signal).toBe('quota-warning');
    expect(r.limitType).toBe('session');
  });

  test('rate-limit takes priority over quota-warning when both present', () => {
    const buf = "You've used 100% of your weekly limit · resets 1pm\nYou've hit your weekly limit";
    const r = scanPtyBuffer(buf);
    expect(r.signal).toBe('rate-limit');
  });
});

describe('scanPtyBuffer — other modals', () => {
  test('auth-required: /login prompt', () => {
    expect(scanPtyBuffer("Not logged in · Please run /login").signal).toBe('auth-required');
  });

  test('auth-required: OAuth revoked', () => {
    expect(scanPtyBuffer("OAuth token revoked · Please run /login").signal).toBe('auth-required');
  });

  test('context-overflow: prompt too long', () => {
    expect(scanPtyBuffer("Prompt is too long").signal).toBe('context-overflow');
  });

  test('context-overflow: compaction error', () => {
    expect(scanPtyBuffer("Error during compaction: Conversation too long").signal).toBe('context-overflow');
  });

  test('policy-refusal', () => {
    expect(scanPtyBuffer("violate our Usage Policy").signal).toBe('policy-refusal');
  });

  test('auto-mode-block', () => {
    expect(scanPtyBuffer("auto mode cannot determine the safety of Bash right now").signal).toBe('auto-mode-block');
  });

  test('network-block: unable to connect', () => {
    expect(scanPtyBuffer("Unable to connect to API. Check your internet").signal).toBe('network-block');
  });

  test('network-block: credit balance', () => {
    expect(scanPtyBuffer("Credit balance is too low").signal).toBe('network-block');
  });

  test('model-error: bad model', () => {
    expect(scanPtyBuffer("There's an issue with the selected model (claude-foo)").signal).toBe('model-error');
  });

  test('dev-prompt: existing', () => {
    expect(scanPtyBuffer("I am using this for local development").signal).toBe('dev-prompt');
  });

  test('clean buffer returns null', () => {
    expect(scanPtyBuffer("normal claude output").signal).toBeNull();
  });

  test('empty buffer returns null', () => {
    expect(scanPtyBuffer("").signal).toBeNull();
  });

  test('legacy "rate-limit-options" no longer matches', () => {
    expect(scanPtyBuffer("rate-limit-options").signal).toBeNull();
  });
});

describe('scanPtyBuffer — tail-slice defense', () => {
  test('only scans last 4000 chars', () => {
    const padding = 'x'.repeat(5000);
    const buf = "You've hit your weekly limit\n" + padding;
    // The rate-limit text is in the first 30 chars; tail-slice should miss it
    expect(scanPtyBuffer(buf).signal).toBeNull();
  });

  test('catches signal in last 4000 chars', () => {
    const padding = 'x'.repeat(3000);
    const buf = padding + "\nYou've hit your weekly limit · resets 1pm";
    expect(scanPtyBuffer(buf).signal).toBe('rate-limit');
  });

  test('priority order: auth beats context-overflow', () => {
    const buf = "Prompt is too long\nPlease run /login";
    expect(scanPtyBuffer(buf).signal).toBe('auth-required');
  });
});
