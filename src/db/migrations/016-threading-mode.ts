import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'threading-mode',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE messaging_group_agents ADD COLUMN threading_mode TEXT NOT NULL DEFAULT 'flat'").run();
  },
};
