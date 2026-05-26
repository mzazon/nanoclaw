import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkStuckSession, clearStuckLatches } from './alert.js';

vi.mock('./log.js', () => ({ log: { warn: vi.fn() } }));

beforeEach(() => {
  clearStuckLatches();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.NANOCLAW_ALERT_WEBHOOK;
});

describe('checkStuckSession', () => {
  test('does not alert before 15 min threshold', () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    process.env.NANOCLAW_ALERT_WEBHOOK = 'http://test.hook';

    checkStuckSession('sess-1', 'rate-limit-schedule');
    vi.advanceTimersByTime(10 * 60_000);
    checkStuckSession('sess-1', 'rate-limit-schedule');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('alerts after 15 min threshold when action persists', () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    process.env.NANOCLAW_ALERT_WEBHOOK = 'http://test.hook';

    checkStuckSession('sess-1', 'rate-limit-schedule');
    vi.advanceTimersByTime(16 * 60_000);
    checkStuckSession('sess-1', 'rate-limit-schedule');

    expect(spy).toHaveBeenCalledTimes(1);
    const body = spy.mock.calls[0][1]?.body as string;
    expect(body).toContain('stuck');
    expect(body).toContain('sess-1');
    spy.mockRestore();
  });

  test('does not re-alert same session within 6h', () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    process.env.NANOCLAW_ALERT_WEBHOOK = 'http://test.hook';

    checkStuckSession('sess-1', 'kill-respawn');
    vi.advanceTimersByTime(16 * 60_000);
    checkStuckSession('sess-1', 'kill-respawn'); // alerts
    vi.advanceTimersByTime(30 * 60_000);
    checkStuckSession('sess-1', 'kill-respawn'); // should NOT re-alert

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('sends recovery alert on action=ok after stuck alert', () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    process.env.NANOCLAW_ALERT_WEBHOOK = 'http://test.hook';

    checkStuckSession('sess-1', 'kill-respawn');
    vi.advanceTimersByTime(16 * 60_000);
    checkStuckSession('sess-1', 'kill-respawn'); // alerts
    checkStuckSession('sess-1', 'ok'); // recovery

    expect(spy).toHaveBeenCalledTimes(2);
    const recoveryBody = spy.mock.calls[1][1]?.body as string;
    expect(recoveryBody).toContain('recovered');
    spy.mockRestore();
  });

  test('no-ops when webhook URL not configured', () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    // NANOCLAW_ALERT_WEBHOOK not set

    checkStuckSession('sess-1', 'rate-limit-schedule');
    vi.advanceTimersByTime(16 * 60_000);
    checkStuckSession('sess-1', 'rate-limit-schedule');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
