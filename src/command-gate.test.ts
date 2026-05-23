// LOCAL-016: CC slash command passthrough tests.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => ({ 1: 1 }) }),
  }),
  hasTable: () => true,
}));

import { gateCommand } from './command-gate.js';

describe('gateCommand', () => {
  const owner = 'slack:U123';

  it('passes normal messages', () => {
    expect(gateCommand('{"text":"hello"}', owner, 'ag-1')).toEqual({ action: 'pass' });
  });

  it('filters /help', () => {
    expect(gateCommand('{"text":"/help"}', owner, 'ag-1')).toEqual({ action: 'filter' });
  });

  it('passes /compact on non-interactive runtime', () => {
    expect(gateCommand('{"text":"/compact"}', owner, 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('{"text":"/compact"}', owner, 'ag-1', null)).toEqual({ action: 'pass' });
    expect(gateCommand('{"text":"/compact"}', owner, 'ag-1', 'docker')).toEqual({ action: 'pass' });
  });

  it('injects /compact on interactive runtime', () => {
    const result = gateCommand('{"text":"/compact"}', owner, 'ag-1', 'interactive');
    expect(result).toEqual({ action: 'inject', command: '/compact' });
  });

  it('injects /compact on cc-container runtime', () => {
    const result = gateCommand('{"text":"/compact"}', owner, 'ag-1', 'cc-container');
    expect(result).toEqual({ action: 'inject', command: '/compact' });
  });

  it('injects /model with argument', () => {
    const result = gateCommand('{"text":"/model opus"}', owner, 'ag-1', 'interactive');
    expect(result).toEqual({ action: 'inject', command: '/model opus' });
  });

  it('strips platform noise from injected commands', () => {
    const result = gateCommand('{"text":"/compact Sent using Claude"}', owner, 'ag-1', 'cc-container');
    expect(result).toEqual({ action: 'inject', command: '/compact' });
  });

  it('keeps first arg for /model but strips noise', () => {
    const result = gateCommand('{"text":"/model opus Sent using Claude"}', owner, 'ag-1', 'interactive');
    expect(result).toEqual({ action: 'inject', command: '/model opus' });
  });

  it('injects /context on interactive', () => {
    const result = gateCommand('{"text":"/context"}', owner, 'ag-1', 'cc-container');
    expect(result).toEqual({ action: 'inject', command: '/context' });
  });

  it('denies CC CLI commands from non-admin on interactive', () => {
    vi.mocked(vi.fn()).mockReturnValueOnce(null);
    const result = gateCommand('{"text":"/compact"}', null, 'ag-1', 'interactive');
    expect(result).toEqual({ action: 'deny', command: '/compact' });
  });

  it('passes unknown slash commands through', () => {
    expect(gateCommand('{"text":"/unknown"}', owner, 'ag-1', 'interactive')).toEqual({ action: 'pass' });
  });
});
