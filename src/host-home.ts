/**
 * Host-home composer — LOCAL-010.
 *
 * Builds a synthetic HOME directory for host-agent groups so the Claude
 * Agent SDK sees NanoClaw-composed .claude/ state instead of the operator's
 * personal config. Only used when runtime='host' && host_home=false.
 *
 * When host_home=true, the spawn inherits the real HOME and this module
 * is not invoked.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { DATA_DIR } from './config.js';
import type { ContainerConfig } from './container-config.js';
import { log } from './log.js';
import { syncSkillSymlinks } from './skill-symlinks.js';

/**
 * Compose a synthetic HOME for a host-agent group. Returns the path.
 * Idempotent — safe to call every spawn.
 */
export function composeHostHome(agentGroupId: string, config: ContainerConfig): string {
  const homeDir = path.join(DATA_DIR, '.host-home', agentGroupId);
  const claudeDir = path.join(homeDir, '.claude');

  fs.mkdirSync(claudeDir, { recursive: true });

  const settings: Record<string, unknown> = {
    env: { TZ: process.env.TZ || 'America/New_York' },
    model: config.model || 'sonnet',
  };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');

  // Symlink selected plugins from the host's real ~/.claude/plugins/
  const hostPluginDir = path.join(os.homedir(), '.claude', 'plugins');
  const hostPluginCacheDir = path.join(hostPluginDir, 'cache');
  if (config.hostPlugins && config.hostPlugins.length > 0 && fs.existsSync(hostPluginCacheDir)) {
    const pluginCacheDir = path.join(claudeDir, 'plugins', 'cache');
    fs.mkdirSync(pluginCacheDir, { recursive: true });

    for (const pluginName of config.hostPlugins) {
      const targetLink = path.join(pluginCacheDir, pluginName);
      const hostSource = path.join(hostPluginCacheDir, pluginName);
      if (!fs.existsSync(hostSource)) {
        log.warn('Host plugin not found, skipping', { plugin: pluginName, expected: hostSource });
        continue;
      }
      // Remove stale symlink, create fresh
      try { fs.unlinkSync(targetLink); } catch { /* not exists */ }
      fs.symlinkSync(hostSource, targetLink);
    }
    log.debug('Host plugins symlinked', { plugins: config.hostPlugins });
  }

  const realHome = os.homedir();
  const DEFAULT_SYMLINKS = ['vault', 'home-infra', 'litellm-stack', '.ssh'];
  const symlinks = config.hostSymlinks && config.hostSymlinks.length > 0 ? config.hostSymlinks : DEFAULT_SYMLINKS;
  for (const name of symlinks) {
    const target = path.join(realHome, name);
    const link = path.join(homeDir, name);
    if (!fs.existsSync(target)) continue;
    try { fs.lstatSync(link); } catch {
      fs.symlinkSync(target, link);
    }
  }

  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  syncSkillSymlinks(path.join(claudeDir, 'skills'), config, (s) => path.join(sharedSkillsDir, s));

  return homeDir;
}
