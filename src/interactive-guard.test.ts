import { describe, test, expect, vi } from 'vitest';
import { scanPtyBuffer, decideAction, executeAction, classifyApiErrorCode } from './interactive-guard.js';
import type { SessionLatches } from './interactive-rate-limit.js';

function freshLatch(): SessionLatches {
  return {
    quotaWarned: { session: new Set(), weekly: new Set(), monthly: new Set(), Opus: new Set() },
    rateLimitScheduled: null,
    lastSignal: null,
    lastSignalAt: 0,
  };
}

function confirmedLatch(signal: string): SessionLatches {
  return { ...freshLatch(), lastSignal: signal, lastSignalAt: Date.now() - 60_000 };
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

  test('HEADLINE matches "monthly spend limit"', () => {
    const r = scanPtyBuffer("You've hit your monthly spend limit.");
    expect(r.signal).toBe('rate-limit');
    expect(r.limitType).toBe('monthly');
  });

  test('MENU matches "Wait for limit to reset"', () => {
    const r = scanPtyBuffer('  Wait for limit to reset                      Resets 8am (America/New_York)');
    expect(r.signal).toBe('rate-limit');
  });

  test('MENU matches "What do you want to do?" picker', () => {
    const r = scanPtyBuffer('What do you want to do?                         Usage credit balance: $31.14');
    expect(r.signal).toBe('rate-limit');
  });

  test('MENU matches "Adjust monthly spend limit"', () => {
    const r = scanPtyBuffer('❯ Adjust monthly spend limit: Unlimited');
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

  test('auth-required → kill (after confirmation)', () => {
    expect(
      decideAction({
        scan: { signal: 'auth-required' },
        latch: confirmedLatch('auth-required'),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill');
  });

  test('model-error → kill (after confirmation)', () => {
    expect(
      decideAction({
        scan: { signal: 'model-error' },
        latch: confirmedLatch('model-error'),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill');
  });

  test('context-overflow → kill-respawn-noContinue (after confirmation)', () => {
    expect(
      decideAction({
        scan: { signal: 'context-overflow' },
        latch: confirmedLatch('context-overflow'),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn-noContinue');
  });

  test('policy-refusal → kill-respawn-noContinue (after confirmation)', () => {
    expect(
      decideAction({
        scan: { signal: 'policy-refusal' },
        latch: confirmedLatch('policy-refusal'),
        heartbeatStaleMs: 0,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn-noContinue');
  });

  test('auto-mode-block below grace → ok (first scan deferred)', () => {
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

  test('auto-mode-block above grace → kill-respawn (after confirmation)', () => {
    expect(
      decideAction({
        scan: { signal: 'auto-mode-block' },
        latch: confirmedLatch('auto-mode-block'),
        heartbeatStaleMs: 3 * 60_000,
        processAlive: true,
        pendingMessages: 0,
      }),
    ).toBe('kill-respawn');
  });

  test('network-block above grace → kill-respawn (after confirmation)', () => {
    expect(
      decideAction({
        scan: { signal: 'network-block' },
        latch: confirmedLatch('network-block'),
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

describe('two-scan confirmation', () => {
  const baseState = { heartbeatStaleMs: 0, processAlive: true, pendingMessages: 0 };

  test('auth-required on first scan → ok (deferred)', () => {
    const latch = freshLatch();
    const action = decideAction({ scan: { signal: 'auth-required' }, latch, ...baseState });
    expect(action).toBe('ok');
    expect(latch.lastSignal).toBe('auth-required');
  });

  test('auth-required on second consecutive scan → kill', () => {
    const latch = freshLatch();
    latch.lastSignal = 'auth-required';
    latch.lastSignalAt = Date.now() - 60_000;
    const action = decideAction({ scan: { signal: 'auth-required' }, latch, ...baseState });
    expect(action).toBe('kill');
  });

  test('context-overflow requires confirmation before kill-respawn-noContinue', () => {
    const latch = freshLatch();
    expect(decideAction({ scan: { signal: 'context-overflow' }, latch, ...baseState })).toBe('ok');
    latch.lastSignalAt = Date.now() - 60_000;
    expect(decideAction({ scan: { signal: 'context-overflow' }, latch, ...baseState })).toBe('kill-respawn-noContinue');
  });

  test('signal change resets confirmation window', () => {
    const latch = freshLatch();
    latch.lastSignal = 'auth-required';
    latch.lastSignalAt = Date.now() - 30_000;
    const action = decideAction({ scan: { signal: 'context-overflow' }, latch, ...baseState });
    expect(action).toBe('ok');
    expect(latch.lastSignal).toBe('context-overflow');
  });

  test('stale confirmation (>120s) resets', () => {
    const latch = freshLatch();
    latch.lastSignal = 'auth-required';
    latch.lastSignalAt = Date.now() - 130_000;
    const action = decideAction({ scan: { signal: 'auth-required' }, latch, ...baseState });
    expect(action).toBe('ok');
  });

  test('rate-limit is exempt from confirmation', () => {
    const latch = freshLatch();
    const action = decideAction({
      scan: { signal: 'rate-limit', limitType: 'session', resetSpec: null },
      latch,
      ...baseState,
    });
    expect(action).toBe('rate-limit-schedule');
  });

  test('dev-prompt is exempt from confirmation', () => {
    const latch = freshLatch();
    const action = decideAction({ scan: { signal: 'dev-prompt' }, latch, ...baseState });
    expect(action).toBe('send-enter');
  });

  test('null signal clears lastSignal', () => {
    const latch = freshLatch();
    latch.lastSignal = 'auth-required';
    latch.lastSignalAt = Date.now() - 30_000;
    decideAction({ scan: { signal: null }, latch, ...baseState });
    expect(latch.lastSignal).toBeNull();
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

  test('rate-limit-schedule uses statusResetAt when PTY reset time is unparseable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T10:00:00Z'));
    const latch = freshLatch();
    const killProcess = vi.fn();

    executeAction('rate-limit-schedule', { signal: 'rate-limit', limitType: 'session', resetSpec: null }, latch, {
      sessionId: 's1',
      sessionEpoch: 's1:1',
      ptyWrite: () => {},
      killProcess,
      notify: () => {},
      getEntry: () => ({ sessionEpoch: 's1:1' }),
      statusResetAt: 1748170800,
    });

    expect(latch.rateLimitScheduled).not.toBeNull();
    expect(latch.rateLimitScheduled!.resetAt).toBe(1748170800000);

    vi.useRealTimers();
    clearTimeout(latch.rateLimitScheduled!.timeoutHandle);
  });
});

// ---- LOCAL-018: api-error detection + classification ----
describe('scanPtyBuffer — api-error (CC "API Error: NNN" framing) [LOCAL-018]', () => {
  test('captures a 500', () => {
    const r = scanPtyBuffer('API Error: 500 Internal server error. This is a server-side issue.');
    expect(r.signal).toBe('api-error');
    expect(r.apiErrorCode).toBe(500);
  });

  test.each([502, 503, 504, 529, 429, 400, 422])('captures %i', (code) => {
    const r = scanPtyBuffer(`Something happened\nAPI Error: ${code} some body text`);
    expect(r.signal).toBe('api-error');
    expect(r.apiErrorCode).toBe(code);
  });

  test('subscription rate-limit wins over API Error: 429', () => {
    const r = scanPtyBuffer("You've hit your weekly limit · resets 1pm\nAPI Error: 429 rate_limit");
    expect(r.signal).toBe('rate-limit');
  });

  test('context-overflow text wins over a bare 400', () => {
    const r = scanPtyBuffer('Prompt is too long');
    expect(r.signal).toBe('context-overflow');
  });
});

describe('classifyApiErrorCode [LOCAL-018]', () => {
  test.each([500, 502, 503, 504, 529, 429])('%i is transient', (c) =>
    expect(classifyApiErrorCode(c)).toBe('transient'));
  test.each([400, 401, 403, 422])('%i is bad-request', (c) =>
    expect(classifyApiErrorCode(c)).toBe('bad-request'));
});
