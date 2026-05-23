import { describe, test, expect } from 'vitest';
import { buildInteractiveEnv, buildMcpJson, resolveClaudeBin, buildSpawnArgs } from './interactive-runner.js';
import { getLatches, onSessionDestroyed } from './interactive-rate-limit.js';

describe('interactive-runner', () => {
  describe('buildInteractiveEnv', () => {
    test('includes real HOME and session vars', () => {
      const env = buildInteractiveEnv({
        baseEnv: { HOME: '/home/test', PATH: '/usr/bin' },
        sessionDir: '/data/sessions/abc/123',
        agentGroupId: 'group-1',
        assistantName: 'TestBot',
        timezone: 'America/New_York',
      });
      expect(env.HOME).toBe('/home/test');
      expect(env.NANOCLAW_SESSION_DIR).toBe('/data/sessions/abc/123');
      expect(env.NANOCLAW_AGENT_GROUP_ID).toBe('group-1');
      expect(env.NANOCLAW_ASSISTANT_NAME).toBe('TestBot');
      expect(env.TZ).toBe('America/New_York');
    });

    test('preserves base env vars', () => {
      const env = buildInteractiveEnv({
        baseEnv: { HOME: '/home/x', PATH: '/usr/bin', CUSTOM: 'value' },
        sessionDir: '/tmp/s',
        agentGroupId: 'g1',
        timezone: 'UTC',
      });
      expect(env.CUSTOM).toBe('value');
      expect(env.PATH).toBe('/usr/bin');
    });

    test('omits NANOCLAW_ASSISTANT_NAME when not provided', () => {
      const env = buildInteractiveEnv({
        baseEnv: { HOME: '/home/x' },
        sessionDir: '/tmp/s',
        agentGroupId: 'g1',
        timezone: 'UTC',
      });
      expect(env.NANOCLAW_ASSISTANT_NAME).toBeUndefined();
    });
  });

  describe('buildMcpJson', () => {
    test('generates correct server config', () => {
      const json = buildMcpJson('/app/bridge/server.ts');
      const parsed = JSON.parse(json);
      expect(parsed.mcpServers['bridge']).toBeDefined();
      expect(parsed.mcpServers['bridge'].command).toMatch(/bun$/);
      expect(parsed.mcpServers['bridge'].args).toContain('/app/bridge/server.ts');
    });

    test('produces valid JSON', () => {
      const json = buildMcpJson('/some/path.ts');
      expect(() => JSON.parse(json)).not.toThrow();
    });
  });

  describe('resolveClaudeBin', () => {
    test('returns a string', () => {
      const bin = resolveClaudeBin();
      expect(typeof bin).toBe('string');
      expect(bin.length).toBeGreaterThan(0);
    });
  });

  describe('buildSpawnArgs', () => {
    test('includes development channels flag', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: [] });
      expect(args).toContain('--dangerously-load-development-channels');
      expect(args).toContain('server:bridge');
    });

    test('includes dangerously-skip-permissions', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: [] });
      expect(args).toContain('--dangerously-skip-permissions');
    });

    test('includes --continue when requested', () => {
      const args = buildSpawnArgs({ continueSession: true, extraFlags: [] });
      expect(args).toContain('--continue');
    });

    test('omits --continue when not requested', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: [] });
      expect(args).not.toContain('--continue');
    });

    test('includes model flag', () => {
      const args = buildSpawnArgs({ model: 'opus', continueSession: false, extraFlags: [] });
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(args[modelIdx + 1]).toBe('opus');
    });

    test('omits model when not provided', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: [] });
      expect(args).not.toContain('--model');
    });

    test('includes --add-dir for group CLAUDE.md', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: [], groupDir: '/home/user/groups/otto' });
      const idx = args.indexOf('--add-dir');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('/home/user/groups/otto');
    });

    test('omits --add-dir when groupDir not provided', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: [] });
      expect(args).not.toContain('--add-dir');
    });

    test('includes extra flags', () => {
      const args = buildSpawnArgs({ continueSession: false, extraFlags: ['--max-turns', '5'] });
      expect(args).toContain('--max-turns');
      expect(args).toContain('5');
    });
  });
});

describe('child exit triggers onSessionDestroyed', () => {
  test('after onSessionDestroyed, getLatches returns a fresh entry with rateLimitScheduled null', () => {
    const latch = getLatches('test-sess-1');
    const fakeHandle = setTimeout(() => {}, 999_999);
    latch.rateLimitScheduled = {
      resetAt: Date.now() + 1000,
      timeoutHandle: fakeHandle,
      sessionEpoch: 'test-sess-1:0',
    };

    onSessionDestroyed('test-sess-1');

    const fresh = getLatches('test-sess-1');
    expect(fresh.rateLimitScheduled).toBeNull();
  });
});
