import fs from 'fs';
import path from 'path';

import type { ContainerConfig } from './container-config.js';

const SHARED_SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');

function resolveDesiredSkills(config: ContainerConfig): string[] {
  if (config.skills !== 'all') return config.skills;
  if (!fs.existsSync(SHARED_SKILLS_DIR)) return [];
  return fs.readdirSync(SHARED_SKILLS_DIR).filter((e) => {
    try {
      return fs.statSync(path.join(SHARED_SKILLS_DIR, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Sync skill symlinks to match the container config selection.
 * `targetFor` returns the symlink target for a given skill name —
 * container mode uses `/app/skills/<name>` (dangling on host),
 * host-agent mode uses the real host path.
 */
export function syncSkillSymlinks(
  skillsDir: string,
  config: ContainerConfig,
  targetFor: (skill: string) => string,
): void {
  fs.mkdirSync(skillsDir, { recursive: true });

  const desired = resolveDesiredSkills(config);
  const desiredSet = new Set(desired);

  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink() && !desiredSet.has(entry)) {
        fs.unlinkSync(entryPath);
      }
    } catch {
      continue;
    }
  }

  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    try {
      fs.lstatSync(linkPath);
    } catch {
      fs.symlinkSync(targetFor(skill), linkPath);
    }
  }
}
