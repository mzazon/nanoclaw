import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// LOCAL-010: Host-agent runtime support
export const migration017: Migration = {
  version: 17,
  name: 'host-agent-runtime',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'docker'").run();
    db.prepare('ALTER TABLE container_configs ADD COLUMN host_home INTEGER NOT NULL DEFAULT 0').run();
    db.prepare("ALTER TABLE container_configs ADD COLUMN host_plugins TEXT NOT NULL DEFAULT '[]'").run();
  },
};
