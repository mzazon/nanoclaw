import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { buildCcContainerMcpJson, buildCcContainerEnv, injectCcCommand } from './cc-container-runner.js';
import type { AgentGroup } from './types.js';
import type { ProviderContainerContribution } from './providers/provider-container-registry.js';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('./group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('./claude-md-compose.js', () => ({ composeGroupClaudeMd: vi.fn() }));
vi.mock('./session-manager.js', () => ({ sessionDir: (_ag: string, sid: string) => `/tmp/sess/${sid}` }));
vi.mock('./log.js', () => ({ log: { warn: vi.fn() } }));

describe('buildCcContainerMcpJson', () => {
  it('uses generic server key', () => {
    const json = JSON.parse(buildCcContainerMcpJson('/app/bridge/server.ts', {}));
    expect(json.mcpServers.bridge).toBeDefined();
    expect(json.mcpServers.bridge.command).toBe('bun');
    expect(json.mcpServers.bridge.args).toEqual(['run', '/app/bridge/server.ts']);
  });

  it('merges additional MCP servers', () => {
    const json = JSON.parse(
      buildCcContainerMcpJson('/app/bridge/server.ts', {
        'vault-search': { command: 'node', args: ['server.js'] },
      }),
    );
    expect(json.mcpServers.bridge).toBeDefined();
    expect(json.mcpServers['vault-search']).toBeDefined();
  });

  it('does not include nanoclaw in any key or value', () => {
    const raw = buildCcContainerMcpJson('/app/bridge/server.ts', {});
    expect(raw.toLowerCase()).not.toContain('nanoclaw');
  });
});

describe('buildCcContainerMounts', () => {
  it('includes .claude-projects mount for continuation persistence', async () => {
    const { buildCcContainerMounts } = await import('./cc-container-runner.js');
    const group: AgentGroup = { id: 'ag-cc', name: 'CC', folder: 'cc', agent_provider: null, created_at: '2026-01-01' };
    const session = { id: 'sess-1', agent_group_id: 'ag-cc', messaging_group_id: 'mg-1', thread_id: null };
    const mounts = buildCcContainerMounts(
      group,
      session as any,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
      {},
    );
    const projectsMount = mounts.find((m) => m.containerPath === '/home/node/.claude/projects');
    expect(projectsMount).toBeDefined();
    expect(projectsMount!.hostPath).toBe('/tmp/sess/sess-1/.claude-projects');
    expect(projectsMount!.readonly).toBe(false);
  });

  it('includes mcp-servers mount', async () => {
    const { buildCcContainerMounts } = await import('./cc-container-runner.js');
    const group: AgentGroup = { id: 'ag-cc', name: 'CC', folder: 'cc', agent_provider: null, created_at: '2026-01-01' };
    const session = { id: 'sess-1', agent_group_id: 'ag-cc', messaging_group_id: 'mg-1', thread_id: null };
    const mounts = buildCcContainerMounts(
      group,
      session as any,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
      {},
    );
    const mcpMount = mounts.find((m) => m.containerPath === '/app/mcp-servers');
    expect(mcpMount).toBeDefined();
    expect(mcpMount!.readonly).toBe(true);
  });
});

describe('buildCcContainerEnv', () => {
  const group: AgentGroup = {
    id: 'ag-test',
    name: 'TestBot',
    folder: 'test',
    agent_provider: null,
    created_at: '2026-01-01',
  };

  it('includes session dir and agent group id', () => {
    const pairs = buildCcContainerEnv(
      group,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('NANOCLAW_SESSION_DIR=/workspaces/.nanoclaw');
    expect(flat).toContain('NANOCLAW_AGENT_GROUP_ID=ag-test');
  });

  it('disables scheduling and NCL by default', () => {
    const pairs = buildCcContainerEnv(
      group,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('NANOCLAW_BRIDGE_SCHEDULING=0');
    expect(flat).toContain('NANOCLAW_BRIDGE_NCL=0');
  });

  it('includes model when set', () => {
    const pairs = buildCcContainerEnv(
      group,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', model: 'opus' },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('NANOCLAW_MODEL=opus');
  });

  it('includes provider env vars', () => {
    const contribution: ProviderContainerContribution = { env: { CUSTOM: 'val' } };
    const pairs = buildCcContainerEnv(
      group,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
      contribution,
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('CUSTOM=val');
  });

  it('sets auto-compact to 50 for opus models', () => {
    const pairs = buildCcContainerEnv(
      group,
      {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        model: 'claude-opus-4-6[1m]',
      },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50');
  });

  it('sets auto-compact to 80 for non-opus models', () => {
    const pairs = buildCcContainerEnv(
      group,
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', model: 'sonnet' },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80');
  });

  it('sets max context to 1000000 for 1m models', () => {
    const pairs = buildCcContainerEnv(
      group,
      {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        model: 'claude-opus-4-6[1m]',
      },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('NANOCLAW_MAX_CONTEXT=1000000');
  });

  it('sets max context to 200000 for standard models', () => {
    const pairs = buildCcContainerEnv(
      group,
      {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        model: 'claude-sonnet-4-6',
      },
      {},
    );
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('NANOCLAW_MAX_CONTEXT=200000');
  });
});

describe('injectCcCommand', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(execSync).mockReset();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends immediately when PTY shows idle prompt', async () => {
    const ptyBuffer = { data: 'some output\n❯ ' };
    const promise = injectCcCommand('test-ctr', '/compact', ptyBuffer);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    const calls = vi.mocked(execSync).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toContain('-- "/compact"');
    expect(calls[1][0]).toContain('Enter');
  });

  it('polls until idle prompt appears', async () => {
    const ptyBuffer = { data: 'processing...' };
    const promise = injectCcCommand('test-ctr', '/compact', ptyBuffer, { pollMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();

    ptyBuffer.data = 'done\n❯ ';
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(2);
  });

  it('sends on timeout with false return', async () => {
    const ptyBuffer = { data: 'stuck processing' };
    const promise = injectCcCommand('test-ctr', '/compact', ptyBuffer, {
      timeoutMs: 1000,
      pollMs: 100,
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(false);
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(2);
  });

  it('detects > as idle prompt', async () => {
    const ptyBuffer = { data: 'output\n> ' };
    const promise = injectCcCommand('test-ctr', '/status', ptyBuffer);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(2);
  });
});
