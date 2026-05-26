import { log } from './log.js';

export async function sendAlert(text: string): Promise<void> {
  const webhook = process.env.NANOCLAW_ALERT_WEBHOOK;
  if (!webhook) return;
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) log.warn('Alert webhook failed', { status: res.status });
  } catch (err) {
    log.warn('Alert webhook error', { err });
  }
}

const stuckLatches = new Map<string, { since: number; alerted: boolean }>();

export function checkStuckSession(sessionId: string, action: string): void {
  const now = Date.now();
  const latch = stuckLatches.get(sessionId);

  if (action === 'ok') {
    if (latch?.alerted) {
      sendAlert(`✅ Session \`${sessionId}\` recovered (was stuck for ${Math.round((now - latch.since) / 60_000)} min)`);
    }
    stuckLatches.delete(sessionId);
    return;
  }

  if (!latch) {
    stuckLatches.set(sessionId, { since: now, alerted: false });
    return;
  }

  const stuckMs = now - latch.since;
  const THRESHOLD = 15 * 60_000;
  const RE_ALERT_INTERVAL = 6 * 60 * 60_000;

  if (stuckMs >= THRESHOLD && !latch.alerted) {
    sendAlert(`🔴 Session \`${sessionId}\` stuck in \`${action}\` for ${Math.round(stuckMs / 60_000)} min`);
    latch.alerted = true;
  } else if (latch.alerted && stuckMs >= RE_ALERT_INTERVAL) {
    latch.since = now;
    latch.alerted = false;
  }
}

export function clearStuckLatches(): void {
  stuckLatches.clear();
}
