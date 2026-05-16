import { describe, test, expect, vi } from 'vitest';
import { scanPtyBuffer, decideAction, executeAction } from './interactive-guard.js';

describe('interactive-guard', () => {
  describe('scanPtyBuffer', () => {
    test('detects rate-limit-options', () => {
      expect(scanPtyBuffer('some TUI output\x1b[32mrate-limit-options\x1b[0m more stuff')).toBe('rate-limit');
    });

    test('detects rate-limit-options without ANSI', () => {
      expect(scanPtyBuffer('rate-limit-options')).toBe('rate-limit');
    });

    test('detects dev channel prompt', () => {
      expect(scanPtyBuffer('I am using this for local development')).toBe('dev-prompt');
    });

    test('returns null for clean buffer', () => {
      expect(scanPtyBuffer('normal claude output here')).toBeNull();
    });

    test('returns null for empty buffer', () => {
      expect(scanPtyBuffer('')).toBeNull();
    });

    test('rate-limit takes priority over dev-prompt if both present', () => {
      expect(scanPtyBuffer('rate-limit-options I am using this for local development')).toBe('rate-limit');
    });
  });

  describe('decideAction', () => {
    test('rate-limit → send-enter', () => {
      expect(
        decideAction({ bufferSignal: 'rate-limit', heartbeatStaleMs: 0, processAlive: true, pendingMessages: 0 }),
      ).toBe('send-enter');
    });

    test('dev-prompt → send-enter', () => {
      expect(
        decideAction({ bufferSignal: 'dev-prompt', heartbeatStaleMs: 0, processAlive: true, pendingMessages: 0 }),
      ).toBe('send-enter');
    });

    test('stale heartbeat + alive + pending → kill-respawn', () => {
      expect(
        decideAction({ bufferSignal: null, heartbeatStaleMs: 6 * 60 * 1000, processAlive: true, pendingMessages: 2 }),
      ).toBe('kill-respawn');
    });

    test('stale heartbeat + alive + no pending → kill-idle (above threshold)', () => {
      expect(
        decideAction({
          bufferSignal: null,
          heartbeatStaleMs: 31 * 60 * 1000,
          processAlive: true,
          pendingMessages: 0,
        }),
      ).toBe('kill-idle');
    });

    test('moderately stale + no pending → ok (below idle threshold)', () => {
      expect(
        decideAction({
          bufferSignal: null,
          heartbeatStaleMs: 10 * 60 * 1000,
          processAlive: true,
          pendingMessages: 0,
        }),
      ).toBe('ok');
    });

    test('healthy session → ok', () => {
      expect(
        decideAction({ bufferSignal: null, heartbeatStaleMs: 10_000, processAlive: true, pendingMessages: 0 }),
      ).toBe('ok');
    });

    test('buffer signal overrides stale heartbeat', () => {
      expect(
        decideAction({
          bufferSignal: 'rate-limit',
          heartbeatStaleMs: 31 * 60 * 1000,
          processAlive: true,
          pendingMessages: 5,
        }),
      ).toBe('send-enter');
    });
  });

  describe('executeAction', () => {
    test('send-enter calls ptyWrite with carriage return', () => {
      const ptyWrite = vi.fn();
      executeAction('send-enter', 'sess-1', ptyWrite);
      expect(ptyWrite).toHaveBeenCalledWith('\r');
    });

    test('kill-respawn calls killProcess', () => {
      const kill = vi.fn();
      executeAction('kill-respawn', 'sess-1', undefined, kill);
      expect(kill).toHaveBeenCalled();
    });

    test('kill-idle calls killProcess', () => {
      const kill = vi.fn();
      executeAction('kill-idle', 'sess-1', undefined, kill);
      expect(kill).toHaveBeenCalled();
    });

    test('ok does nothing', () => {
      const ptyWrite = vi.fn();
      const kill = vi.fn();
      executeAction('ok', 'sess-1', ptyWrite, kill);
      expect(ptyWrite).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    });
  });
});
