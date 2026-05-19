import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'fresh-context',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN fresh_context TEXT DEFAULT NULL').run();
  },
};
