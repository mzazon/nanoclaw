import { describe, test, expect, vi } from 'vitest';
import { scanPtyBuffer, decideAction, executeAction } from './interactive-guard.js';
import type { SessionLatches } from './interactive-rate-limit.js';

function freshLatch(): SessionLatches {
  return {
    quotaWarned: { session: new Set(), weekly: new Set(), Opus: new Set() },
    rateLimitScheduled: null,
  };
}

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
    const r = scanPtyBuffer('You’ve hit your weekly limit · resets 1pm');
    expect(r.signal).toBe('rate-limit');
  });

  test('HEADLINE matches elided form (v2.1.123)', () => {
    const r = scanPtyBuffer("You've hit your limit · resets 9:40pm (Europe/Madrid)");
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('unknown');
  });

  test('MENU layer matches even without headline', () => {
    const r = scanPtyBuffer('❯ 1. Stop and wait for limit to reset');
    expect(r.signal).toBe('rate-limit');
  });

  test('MENU "Upgrade your plan" matches', () => {
    const r = scanPtyBuffer('  2. Upgrade your plan');
    expect(r.signal).toBe('rate-limit');
  });

  test('LEGACY wording matches', () => {
    const r = scanPtyBuffer('Claude usage limit reached. Your limit will reset at Oct 7, 1am.');
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
    expect(scanPtyBuffer('Not logged in · Please run /login').signal).toBe('auth-required');
  });

  test('auth-required: OAuth revoked', () => {
    expect(scanPtyBuffer('OAuth token revoked · Please run /login').signal).toBe('auth-required');
  });

  test('context-overflow: prompt too long', () => {
    expect(scanPtyBuffer('Prompt is too long').signal).toBe('context-overflow');
  });

  test('context-overflow: compaction error', () => {
    expect(scanPtyBuffer('Error during compaction: Conversation too long').signal).toBe('context-overflow');
  });

  test('policy-refusal', () => {
    expect(scanPtyBuffer('violate our Usage Policy').signal).toBe('policy-refusal');
  });

  test('auto-mode-block', () => {
    expect(scanPtyBuffer('auto mode cannot determine the safety of Bash right now').signal).toBe('auto-mode-block');
  });

  test('network-block: unable to connect', () => {
    expect(scanPtyBuffer('Unable to connect to API. Check your internet').signal).toBe('network-block');
  });

  test('network-block: credit balance', () => {
    expect(scanPtyBuffer('Credit balance is too low').signal).toBe('network-block');
  });

  test('model-error: bad model', () => {
    expect(scanPtyBuffer("There's an issue with the selected model (claude-foo)").signal).toBe('model-error');
  });

  test('dev-prompt: existing', () => {
    expect(scanPtyBuffer('I am using this for local development').signal).toBe('dev-prompt');
  });

  test('clean buffer returns null', () => {
    expect(scanPtyBuffer('normal claude output').signal).toBeNull();
  });

  test('empty buffer returns null', () => {
    expect(scanPtyBuffer('').signal).toBeNull();
  });

  test('legacy "rate-limit-options" no longer matches', () => {
    expect(scanPtyBuffer('rate-limit-options').signal).toBeNull();
  });
});

describe('scanPtyBuffer — ANSI escape sequence handling (real PTY output)', () => {
  test('matches headline interleaved with cursor-positioning codes', () => {
    // Real PTY capture: CC writes each word with absolute column positioning
    const buf =
      "You've\x1b[13Ghit\x1b[17Gyour\x1b[22Gweekly\x1b[29Glimit\x1b[35G·\x1b[37Gresets\x1b[44G1pm\x1b[48G(America/New_York)";
    const r = scanPtyBuffer(buf);
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('weekly');
    expect(r.resetSpec).toEqual({ weekday: undefined, time: '1pm', tz: 'America/New_York' });
  });

  test('matches menu option with ANSI color codes', () => {
    const buf = '\x1b[32m❯ 1. Stop and wait for limit to reset\x1b[0m';
    expect(scanPtyBuffer(buf).signal).toBe('rate-limit');
  });

  test('matches quota-warning with cursor codes', () => {
    const buf = "You've\x1b[13Gused\x1b[18G98%\x1b[22Gof\x1b[25Gyour\x1b[30Gweekly\x1b[37Glimit";
    const r = scanPtyBuffer(buf);
    expect(r.signal).toBe('quota-warning');
    expect(r.percent).toBe(98);
    expect(r.limitType).toBe('weekly');
  });

  test('strips OSC window-title escape', () => {
    const buf = "\x1b]0;Claude Code\x07You've hit your weekly limit · resets 1pm";
    expect(scanPtyBuffer(buf).signal).toBe('rate-limit');
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
    const buf = 'Prompt is too long\nPlease run /login';
    expect(scanPtyBuffer(buf).signal).toBe('auth-required');
  });
});

describe('scanPtyBuffer — context-overflow regex tightening', () => {
  test('context-overflow: NOT triggered by bare "Conversation too long" in agent prose', () => {
    expect(scanPtyBuffer('the conversation was too long for me to summarize quickly').signal).toBeNull();
  });

  test('context-overflow: still catches "Error during compaction" canonical framing', () => {
    expect(scanPtyBuffer('Error during compaction: this got too big').signal).toBe('context-overflow');
  });
});

describe('decideAction', () => {
  test('rate-limit + no latch → schedule', () => {
    const action = decideAction({
      scan: { signal: 'rate-limit', limitType: 'weekly', resetSpec: { time: '1pm' } },
      latch: freshLatch(),
      heartbeatStaleMs: 0,
      processAlive: true,
      pendingMessages: 0,
    });
    expect(action).toBe('rate-limit-schedule');
  });

  test('rate-limit + existing latch → ok', () => {
    const latch = freshLatch();
    latch.rateLimitScheduled = {
      resetAt: Date.now() + 1000,
      timeoutHandle: setTimeout(() => {}, 9999),
      sessionEpoch: 's:1',
    };
    const action = decideAction({
      scan: { signal: 'rate-limit', limitType: 'weekly' },
      latch,
      heartbeatStaleMs: 0,
      processAlive: true,
      pendingMessages: 0,
    });
    expect(action).toBe('ok');
    clearTimeout(latch.rateLimitScheduled!.timeoutHandle);
  });

  test('null signal + rate-limit latch armed → ok (suppression)', () => {
    const latch = freshLatch();
    latch.rateLimitScheduled = {
      resetAt: Date.now() + 1000,
      timeoutHandle: setTimeout(() => {}, 9999),
      sessionEpoch: 's:1',
    };
    const action = decideAction({
      scan: { signal: null },
      latch,
      heartbeatStaleMs: 10 * 60 * 1000,
      processAlive: true,
      pendingMessages: 5,
    });
    expect(action).toBe('ok');
    clearTimeout(latch.rateLimitScheduled!.timeoutHandle);
  });

  test('quota-warning unwarned bucket → notify', () => {
    const action = decideAction({
      scan: { signal: 'quota-warning', limitType: 'weekly', percent: 98 },
      latch: freshLatch(),
      heartbeatStaleMs: 0,
      processAlive: true,
      pendingMessages: 0,
    });
    expect(action).toBe('quota-warning-notify');
  });

  test('quota-warning already-warned bucket → ok', () => {
    const latch = freshLatch();
    latch.quotaWarned.weekly.add(95);
    const action = decideAction({
      scan: { signal: 'quota-warning', limitType: 'weekly', percent: 98 },
      latch,
      heartbeatStaleMs: 0,
      processAlive: true,
      pendingMessages: 0,
    });
    expect(action).toBe('ok');
  });

  test('dev-prompt → send-enter', () => {
    expect(
      decideAction({
        scan: { signal: 'dev-prompt' },
        latch: freshLatch(),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('send-enter');
  });

  test('auth-required → kill', () => {
    expect(
      decideAction({
        scan: { signal: 'auth-required' },
        latch: freshLatch(),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill');
  });

  test('model-error → kill', () => {
    expect(
      decideAction({
        scan: { signal: 'model-error' },
        latch: freshLatch(),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill');
  });

  test('context-overflow → kill-respawn-noContinue', () => {
    expect(
      decideAction({
        scan: { signal: 'context-overflow' },
        latch: freshLatch(),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn-noContinue');
  });

  test('policy-refusal → kill-respawn-noContinue', () => {
    expect(
      decideAction({
        scan: { signal: 'policy-refusal' },
        latch: freshLatch(),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn-noContinue');
  });

  test('auto-mode-block below grace → ok', () => {
    expect(
      decideAction({
        scan: { signal: 'auto-mode-block' },
        latch: freshLatch(),
        heartbeatStaleMs: 60_000,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('ok');
  });

  test('auto-mode-block above grace → kill-respawn', () => {
    expect(
      decideAction({
        scan: { signal: 'auto-mode-block' },
        latch: freshLatch(),
        heartbeatStaleMs: 3 * 60_000,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn');
  });

  test('network-block above grace → kill-respawn', () => {
    expect(
      decideAction({
        scan: { signal: 'network-block' },
        latch: freshLatch(),
        heartbeatStaleMs: 6 * 60_000,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn');
  });

  test('null signal + stale heartbeat + pending → kill-respawn', () => {
    expect(
      decideAction({
        scan: { signal: null },
        latch: freshLatch(),
        heartbeatStaleMs: 6 * 60_000,
        processAlive: true,
        pendingMessages: 3,
      }),
    ).toBe('kill-respawn');
  });
});

describe('executeAction', () => {
  test('rate-limit-schedule arms timer and stores in latch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T17:00:00Z'));
    const latch = freshLatch();
    const notify = vi.fn();
    const ptyWrite = vi.fn();
    const killProcess = vi.fn();

    executeAction(
      'rate-limit-schedule',
      { signal: 'rate-limit', limitType: 'weekly', resetSpec: { time: '2pm', tz: 'America/New_York' } },
      latch,
      {
        sessionId: 's1',
        sessionEpoch: 's1:1',
        ptyWrite,
        killProcess,
        notify,
        getEntry: () => ({ sessionEpoch: 's1:1' }),
      },
    );

    expect(ptyWrite).toHaveBeenCalledWith('\r');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Rate limited (weekly)'));
    expect(latch.rateLimitScheduled).not.toBeNull();
    expect(latch.rateLimitScheduled!.sessionEpoch).toBe('s1:1');

    vi.useRealTimers();
    clearTimeout(latch.rateLimitScheduled!.timeoutHandle);
  });

  test('rate-limit timer skips kill if sessionEpoch changed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T17:00:00Z'));
    const latch = freshLatch();
    const killProcess = vi.fn();
    let currentEpoch = 's1:1';

    executeAction(
      'rate-limit-schedule',
      { signal: 'rate-limit', resetSpec: { time: '1:01pm', tz: 'America/New_York' } },
      latch,
      {
        sessionId: 's1',
        sessionEpoch: 's1:1',
        ptyWrite: () => {},
        killProcess,
        notify: () => {},
        getEntry: () => ({ sessionEpoch: currentEpoch }),
      },
    );

    currentEpoch = 's1:2';
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(killProcess).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test('quota-warning-notify adds bucket to latch and notifies', () => {
    const latch = freshLatch();
    const notify = vi.fn();
    executeAction(
      'quota-warning-notify',
      { signal: 'quota-warning', limitType: 'weekly', percent: 99, resetSpec: { time: '1pm' } },
      latch,
      { sessionId: 's1', sessionEpoch: 's1:1', notify },
    );
    expect(latch.quotaWarned.weekly.has(99)).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('99%'));
  });

  test('kill-respawn-noContinue passes noContinue flag', () => {
    const killProcess = vi.fn();
    executeAction('kill-respawn-noContinue', { signal: 'context-overflow' }, freshLatch(), {
      sessionId: 's1',
      sessionEpoch: 's1:1',
      killProcess,
      notify: () => {},
    });
    expect(killProcess).toHaveBeenCalledWith({ noContinue: true });
  });

  test('kill-respawn default → no flags', () => {
    const killProcess = vi.fn();
    executeAction('kill-respawn', { signal: 'network-block' }, freshLatch(), {
      sessionId: 's1',
      sessionEpoch: 's1:1',
      killProcess,
    });
    expect(killProcess).toHaveBeenCalledWith();
  });

  test('kill with auth-required notifies operator before killing', () => {
    const notify = vi.fn();
    const killProcess = vi.fn();
    executeAction('kill', { signal: 'auth-required' }, freshLatch(), {
      sessionId: 's1',
      sessionEpoch: 's1:1',
      notify,
      killProcess,
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Auth error'));
    expect(killProcess).toHaveBeenCalledWith();
  });

  test('kill with model-error notifies operator before killing', () => {
    const notify = vi.fn();
    const killProcess = vi.fn();
    executeAction('kill', { signal: 'model-error' }, freshLatch(), {
      sessionId: 's1',
      sessionEpoch: 's1:1',
      notify,
      killProcess,
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Model config error'));
    expect(killProcess).toHaveBeenCalledWith();
  });
});
