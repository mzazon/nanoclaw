import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  createUnresponsivenessState,
  checkUnresponsiveness,
} from './unresponsiveness';

const TMP = `/tmp/nanoclaw-bridge-unresp-${process.pid}`;
const MARKER = path.join(TMP, '.cc-unresponsive');

beforeEach(() => fs.mkdirSync(TMP, { recursive: true }));
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('checkUnresponsiveness', () => {
  it('writes marker when notifications-sent and no outbound writes for >3min', () => {
    const state = createUnresponsivenessState(MARKER);
    state.notificationsSent = 5;
    state.lastOutboundWriteMs = 0;  // never written

    checkUnresponsiveness(state, 0, 4 * 60_000);
    expect(fs.existsSync(MARKER)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    expect(parsed.outboundIdleMs).toBeGreaterThan(180_000);
  });

  it('clears marker when outbound writes resume', () => {
    const state = createUnresponsivenessState(MARKER);
    fs.writeFileSync(MARKER, '{}');
    state.notificationsSent = 5;
    state.lastOutboundWriteMs = Date.now();

    checkUnresponsiveness(state, 1, Date.now() + 60_000);
    expect(fs.existsSync(MARKER)).toBe(false);
  });

  it('throttles checks to 60s', () => {
    const state = createUnresponsivenessState(MARKER);
    state.notificationsSent = 5;
    state.lastOutboundWriteMs = 0;

    const t0 = Date.now();
    checkUnresponsiveness(state, 0, t0);
    fs.rmSync(MARKER, { force: true });

    // 30s later — should be no-op
    checkUnresponsiveness(state, 0, t0 + 30_000);
    expect(fs.existsSync(MARKER)).toBe(false);

    // 65s later — should fire
    checkUnresponsiveness(state, 0, t0 + 65_000);
    expect(fs.existsSync(MARKER)).toBe(true);
  });

  it('uses atomic tmp+rename for marker write', () => {
    const state = createUnresponsivenessState(MARKER);
    state.notificationsSent = 1;
    state.lastOutboundWriteMs = 0;
    checkUnresponsiveness(state, 0, 4 * 60_000);
    expect(fs.existsSync(`${MARKER}.tmp`)).toBe(false);
    expect(fs.existsSync(MARKER)).toBe(true);
  });

  it('no marker when sentDelta is 0 (no new notifications)', () => {
    const state = createUnresponsivenessState(MARKER);
    state.notificationsSent = 0;  // never sent
    state.lastOutboundWriteMs = 0;
    checkUnresponsiveness(state, 0, 5 * 60_000);
    expect(fs.existsSync(MARKER)).toBe(false);
  });

  it('no marker when writeDelta > 0 (outbound progressed)', () => {
    const state = createUnresponsivenessState(MARKER);
    state.notificationsSent = 5;
    state.lastOutboundWriteMs = 0;
    state.outboundSeqAtLastCheck = 5;
    // outboundSeqNow > previous → writeDelta > 0
    checkUnresponsiveness(state, 7, 4 * 60_000);
    expect(fs.existsSync(MARKER)).toBe(false);
  });
});
