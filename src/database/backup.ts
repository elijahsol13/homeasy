/**
 * HomEasy Database Backup Service
 *
 * Provides safe, online, point-in-time snapshots of the SQLite database:
 *  - Uses SQLite's `VACUUM INTO` command to create a consistent snapshot without
 *    forcing a checkpoint on other database connections.
 *  - Verifies the snapshot with `PRAGMA quick_check` and `PRAGMA foreign_key_check`.
 *  - Automatically rotates backups, keeping the last N snapshots (default: 21).
 */

import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';

export interface BackupOptions {
  dbPath?: string;
  backupDir?: string;
  maxRetained?: number;
}

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  filename?: string;
  sizeBytes?: number;
  retainedCount?: number;
  prunedCount?: number;
  error?: string;
}

export const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'homeasy.db');
export const DEFAULT_BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
// Dedicated 12-hour snapshots coexist with the daily pre-maintenance backup
// and occasional manual snapshots. Keep about a week of recovery points.
export const DEFAULT_MAX_RETAINED = 21;

/**
 * Creates a formatted timestamp string: YYYY-MM-DD_HHmmss
 */
function getTimestampString(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day}_${hours}${minutes}${seconds}`;
}

/**
 * Creates a verified point-in-time backup snapshot of the SQLite database.
 */
export function createDatabaseBackup(options: BackupOptions = {}): BackupResult {
  // The worker, bot and API all use DATABASE_PATH; backing up a hard-coded
  // default here could silently snapshot a different database after migration.
  const dbPath = options.dbPath ?? process.env.DATABASE_PATH ?? DEFAULT_DB_PATH;
  const backupDir = options.backupDir ?? path.join(path.dirname(path.resolve(dbPath)), 'backups');
  const maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED;
  let pendingPath: string | undefined;

  try {
    if (!Number.isSafeInteger(maxRetained) || maxRetained < 1) {
      return { success: false, error: 'maxRetained must be a positive safe integer' };
    }
    // 1. Ensure source database exists
    if (!fs.existsSync(dbPath)) {
      return { success: false, error: `Source database not found at: ${dbPath}` };
    }

    // 2. Ensure backup directory exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // 3. Create a snapshot. VACUUM INTO reads a consistent transaction view in
    // WAL mode; forcing a WAL checkpoint first is unnecessary and may block
    // ongoing writers or readers.
    // Write to a unique, non-rotatable name. Only publish a .db after verification;
    // a failed VACUUM or process crash must never look like a usable backup.
    const finalFilename = `homeasy_backup_${getTimestampString()}_${randomUUID()}.db`;
    const finalTargetPath = path.join(backupDir, finalFilename);
    pendingPath = path.join(backupDir, `.${finalFilename}.partial`);

    const sourceDb = new DatabaseSync(dbPath);

    try {
      sourceDb.exec('PRAGMA busy_timeout = 5000');
      // Use VACUUM INTO for an online, consistent snapshot.
      // Escape single quotes in path if any
      const escapedPath = pendingPath.replace(/'/g, "''");
      sourceDb.exec(`VACUUM INTO '${escapedPath}';`);
    } finally {
      sourceDb.close();
    }

    // 4. Verify the backup file exists and has content
    if (!fs.existsSync(pendingPath)) {
      throw new Error(`Backup file was not created at ${pendingPath}`);
    }

    const stat = fs.statSync(pendingPath);
    if (stat.size === 0) {
      throw new Error('Backup file was created with 0 bytes');
    }

    // 5. Verify both physical consistency and referential integrity.
    const backupDb = new DatabaseSync(pendingPath, { readOnly: true });
    let verificationError: string | null = null;
    try {
      const checkRow = backupDb.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
      if (checkRow?.quick_check !== 'ok') {
        verificationError = `Backup file failed integrity check: ${checkRow?.quick_check}`;
      } else {
        const violations = backupDb.prepare('PRAGMA foreign_key_check;').all();
        if (violations.length > 0) {
          verificationError = `Backup file contains ${violations.length} foreign key violation(s)`;
        }
      }
    } finally {
      backupDb.close();
    }
    if (verificationError) {
      throw new Error(verificationError);
    }

    // Same-directory rename publishes a complete, verified recovery point.
    fs.renameSync(pendingPath, finalTargetPath);
    pendingPath = undefined;

    // 6. Prune older backups keeping maxRetained
    const { retained, pruned } = pruneOldBackups(backupDir, maxRetained);

    return {
      success: true,
      backupPath: finalTargetPath,
      filename: finalFilename,
      sizeBytes: stat.size,
      retainedCount: retained,
      prunedCount: pruned,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (pendingPath) {
      try {
        fs.rmSync(pendingPath, { force: true });
      } catch (cleanupError: unknown) {
        const cleanupMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        return { success: false, error: `Failed to create database backup: ${msg}; incomplete snapshot cleanup failed: ${cleanupMsg}` };
      }
    }
    return { success: false, error: `Failed to create database backup: ${msg}` };
  }
}

/**
 * Keeps the most recent `maxRetained` backups in `backupDir` and deletes the rest.
 */
export function pruneOldBackups(backupDir: string, maxRetained = DEFAULT_MAX_RETAINED): { retained: number; pruned: number } {
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 1) {
    throw new Error('maxRetained must be a positive safe integer');
  }
  if (!fs.existsSync(backupDir)) return { retained: 0, pruned: 0 };

  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('homeasy_backup_') && f.endsWith('.db'))
    .map((name) => {
      const fullPath = path.join(backupDir, name);
      const stat = fs.statSync(fullPath);
      return { name, path: fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  let pruned = 0;
  if (files.length > maxRetained) {
    const toDelete = files.slice(maxRetained);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(f.path);
        pruned++;
      } catch {
        // Ignore deletion errors
      }
    }
  }

  const retained = Math.min(files.length, maxRetained);
  return { retained, pruned };
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('📦 Starting database backup...');
  const result = createDatabaseBackup();
  if (result.success) {
    const sizeKb = Math.round((result.sizeBytes ?? 0) / 1024);
    console.log(`✅ Backup created successfully!`);
    console.log(`   📁 File:     ${result.filename}`);
    console.log(`   ⚖️  Size:     ${sizeKb} KB`);
    console.log(`   📚 Retained: ${result.retainedCount} (pruned ${result.prunedCount} older snapshot(s))`);
  } else {
    console.error(`❌ Backup failed: ${result.error}`);
    process.exit(1);
  }
}

