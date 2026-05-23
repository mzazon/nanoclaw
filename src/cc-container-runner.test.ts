import { describe, it, expect } from 'vitest';
import { buildCcContainerMcpJson, buildCcContainerEnv } from './cc-container-runner.js';
import type { AgentGroup } from './types.js';
import type { ProviderContainerContribution } from './providers/provider-container-registry.js';

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

describe('buildCcContainerEnv', () => {
  const group: AgentGroup = {
    id: 'ag-test',
    name: 'TestBot',
    folder: 'test',
    agent_provider: null,
    created_at: '2026-01-01',
  };

  it('includes session dir and agent group id', () => {
    const pairs = buildCcContainerEnv(group, { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, {});
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('NANOCLAW_SESSION_DIR=/workspaces/.nanoclaw');
    expect(flat).toContain('NANOCLAW_AGENT_GROUP_ID=ag-test');
  });

  it('disables scheduling and NCL by default', () => {
    const pairs = buildCcContainerEnv(group, { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, {});
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
    const pairs = buildCcContainerEnv(group, { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, contribution);
    const flat = pairs.map((p) => p[1]);
    expect(flat).toContain('CUSTOM=val');
  });
});
