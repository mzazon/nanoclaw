import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// LOCAL-010: Configurable home directory symlinks for host-agent mode
export const migration018: Migration = {
  version: 18,
  name: 'host-symlinks',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN host_symlinks TEXT NOT NULL DEFAULT '[]'").run();
  },
};
