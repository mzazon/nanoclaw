// LOCAL-012: Bridge unresponsiveness detector with atomic marker write.
import fs from 'fs';

const CHECK_INTERVAL_MS = 60_000;
const OUTBOUND_IDLE_THRESHOLD_MS = 180_000;

export interface UnresponsivenessState {
  markerPath: string;
  notificationsSent: number;
  notificationsAtLastCheck: number;
  outboundSeqAtLastCheck: number;
  lastOutboundWriteMs: number;
  lastCheckMs: number;
}

export function createUnresponsivenessState(markerPath: string): UnresponsivenessState {
  return {
    markerPath,
    notificationsSent: 0,
    notificationsAtLastCheck: 0,
    outboundSeqAtLastCheck: 0,
    lastOutboundWriteMs: 0,
    lastCheckMs: 0,
  };
}

export function checkUnresponsiveness(
  state: UnresponsivenessState,
  outboundSeqNow: number,
  now: number,
): void {
  if (now - state.lastCheckMs < CHECK_INTERVAL_MS) return;

  const sentDelta = state.notificationsSent - state.notificationsAtLastCheck;
  const writeDelta = outboundSeqNow - state.outboundSeqAtLastCheck;
  const outboundIdleMs = state.lastOutboundWriteMs === 0
    ? Infinity
    : now - state.lastOutboundWriteMs;

  const stuck = sentDelta >= 1 && writeDelta === 0 && outboundIdleMs > OUTBOUND_IDLE_THRESHOLD_MS;

  if (stuck) {
    const tmpPath = `${state.markerPath}.tmp`;
    // JSON.stringify(Infinity) is `null` — coerce to a serializable large number
    // so downstream readers can still see "idle for a long time".
    const idleForMarker = Number.isFinite(outboundIdleMs) ? outboundIdleMs : Number.MAX_SAFE_INTEGER;
    fs.writeFileSync(tmpPath, JSON.stringify({
      detectedAt: now,
      sentDelta,
      outboundIdleMs: idleForMarker,
      bridgePid: process.pid,
    }));
    fs.renameSync(tmpPath, state.markerPath);
    // Keep notificationsAtLastCheck unchanged while stuck so the next window
    // still observes sentDelta >= 1 and re-asserts the marker if needed.
    state.outboundSeqAtLastCheck = outboundSeqNow;
    state.lastCheckMs = now;
    return;
  }

  fs.rmSync(state.markerPath, { force: true });
  state.notificationsAtLastCheck = state.notificationsSent;
  state.outboundSeqAtLastCheck = outboundSeqNow;
  state.lastCheckMs = now;
}
