import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { buildHostProcessEnv, resolveBunBin, _resetBunBinCache } from './host-runner.js';

describe('buildHostProcessEnv', () => {
  it('rewrites host.docker.internal to Docker bridge IP', () => {
    const env = buildHostProcessEnv({
      baseEnv: {},
      onecliEnv: {
        HTTPS_PROXY: 'https://host.docker.internal:10254',
        OTHER: 'https://host.docker.internal:9999/path',
      },
      home: '/tmp/test-home',
      sessDir: '/tmp/sess',
      groupDir: '/tmp/group',
      projectRoot: '/tmp/project',
    });
    expect(env.HTTPS_PROXY).toBe('https://172.17.0.1:10254');
    expect(env.OTHER).toBe('https://172.17.0.1:9999/path');
  });

  it('sets NANOCLAW_HOST_MODE', () => {
    const env = buildHostProcessEnv({
      baseEnv: {},
      onecliEnv: {},
      home: '/tmp/home',
      sessDir: '/tmp/sess',
      groupDir: '/tmp/group',
      projectRoot: '/tmp/project',
    });
    expect(env.NANOCLAW_HOST_MODE).toBe('true');
  });

  it('sets workspace and agent dir from args', () => {
    const env = buildHostProcessEnv({
      baseEnv: {},
      onecliEnv: {},
      home: '/tmp/home',
      sessDir: '/data/sessions/abc',
      groupDir: '/groups/sentinel',
      projectRoot: '/repos/nanoclaw',
    });
    expect(env.NANOCLAW_WORKSPACE).toBe('/data/sessions/abc');
    expect(env.NANOCLAW_AGENT_DIR).toBe('/groups/sentinel');
    expect(env.NANOCLAW_EXTRA_DIR).toBe('/groups/sentinel/.host-extra');
    expect(env.NANOCLAW_SKILLS_DIR).toBe('/repos/nanoclaw/container/skills');
  });

  it('overrides HOME from baseEnv', () => {
    const env = buildHostProcessEnv({
      baseEnv: { HOME: '/real/home', PATH: '/usr/bin' },
      onecliEnv: {},
      home: '/synthetic/home',
      sessDir: '/tmp/sess',
      groupDir: '/tmp/group',
      projectRoot: '/tmp/project',
    });
    expect(env.HOME).toBe('/synthetic/home');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('sets NO_PROXY for localhost only (not host.docker.internal)', () => {
    const env = buildHostProcessEnv({
      baseEnv: {},
      onecliEnv: {},
      home: '/tmp/home',
      sessDir: '/tmp/sess',
      groupDir: '/tmp/group',
      projectRoot: '/tmp/project',
    });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1');
  });

  it('preserves non-string onecli values without rewrite', () => {
    const env = buildHostProcessEnv({
      baseEnv: {},
      onecliEnv: { NORMAL_KEY: 'no-docker-host-here' },
      home: '/tmp/home',
      sessDir: '/tmp/sess',
      groupDir: '/tmp/group',
      projectRoot: '/tmp/project',
    });
    expect(env.NORMAL_KEY).toBe('no-docker-host-here');
  });
});

describe('resolveBunBin', () => {
  beforeEach(() => _resetBunBinCache());
  afterEach(() => _resetBunBinCache());

  it('returns "bun" when ~/.bun/bin/bun does not exist', () => {
    const orig = process.env.HOME;
    process.env.HOME = '/nonexistent-path-for-test';
    try {
      const result = resolveBunBin();
      expect(result).toBe('bun');
    } finally {
      process.env.HOME = orig;
    }
  });

  it('caches the result across calls', () => {
    const orig = process.env.HOME;
    process.env.HOME = '/nonexistent-path-for-test';
    try {
      const first = resolveBunBin();
      const second = resolveBunBin();
      expect(first).toBe(second);
    } finally {
      process.env.HOME = orig;
    }
  });

  it('finds real bun binary when it exists', () => {
    const home = os.homedir();
    const candidate = path.join(home, '.bun', 'bin', 'bun');
    if (fs.existsSync(candidate)) {
      expect(resolveBunBin()).toBe(candidate);
    }
  });
});
