/**
 * Interactive session lifecycle guard — integrated into host-sweep.
 *
 * Scans the PTY output buffer for known prompts (rate-limit, dev-channel)
 * and decides whether to send a keystroke, kill+respawn, or let it ride.
 */
import { log } from './log.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export type BufferSignal = 'rate-limit' | 'dev-prompt' | null;
export type GuardAction = 'send-enter' | 'kill-respawn' | 'kill-idle' | 'ok';

export function scanPtyBuffer(buffer: string): BufferSignal {
  if (buffer.includes('rate-limit-options')) return 'rate-limit';
  if (buffer.includes('I am using this for local development')) return 'dev-prompt';
  return null;
}

export function decideAction(state: {
  bufferSignal: BufferSignal;
  heartbeatStaleMs: number;
  processAlive: boolean;
  pendingMessages: number;
}): GuardAction {
  if (state.bufferSignal === 'rate-limit' || state.bufferSignal === 'dev-prompt') {
    return 'send-enter';
  }
  if (state.heartbeatStaleMs > STUCK_THRESHOLD_MS && state.processAlive && state.pendingMessages > 0) {
    return 'kill-respawn';
  }
  if (state.heartbeatStaleMs > IDLE_THRESHOLD_MS && state.processAlive && state.pendingMessages === 0) {
    return 'kill-idle';
  }
  return 'ok';
}

export function executeAction(
  action: GuardAction,
  sessionId: string,
  ptyWrite?: (data: string) => void,
  killProcess?: () => void,
): void {
  switch (action) {
    case 'send-enter':
      if (ptyWrite) {
        ptyWrite('\r');
        log.info('Interactive guard: sent Enter keystroke', { sessionId });
      }
      break;
    case 'kill-respawn':
      log.info('Interactive guard: killing stuck session for respawn', { sessionId });
      killProcess?.();
      break;
    case 'kill-idle':
      log.info('Interactive guard: killing idle session', { sessionId });
      killProcess?.();
      break;
    case 'ok':
      break;
  }
}
