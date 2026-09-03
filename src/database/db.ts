import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { env } from '../config/env';

/**
 * Creates and initializes a new DatabaseSync connection.
 * DatabaseSync (node:sqlite) is fully synchronous — no promises, no callbacks.
 * Available in Node.js 22.5+ without any native compilation.
 */
export function createDatabase(customPath?: string): DatabaseSync {
  const targetPath = customPath ?? env.DATABASE_PATH;
  const isMemory = targetPath === ':memory:';

  let db: DatabaseSync;
  if (isMemory) {
    db = new DatabaseSync(':memory:');
  } else {
    const dbPath = path.resolve(targetPath);
    const dir = path.dirname(dbPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new DatabaseSync(dbPath);
  }

  // Performance & safety pragmas
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA cache_size = -32000'); // 32 MB page cache
  db.exec('PRAGMA temp_store = MEMORY');

  return db;
}

/** Cleanly closes a database connection. Call on graceful shutdown. */
export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch (err) {
    console.warn('[Database] Error closing database connection:', err);
  }
}
