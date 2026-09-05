/**
 * HomEasy Database Backup Service
 *
 * Provides safe, online, point-in-time snapshots of the SQLite database:
 *  - Forces a WAL checkpoint to flush uncommitted WAL pages to the main DB.
 *  - Uses SQLite's `VACUUM INTO` command to generate an ultra-clean, defragmented backup copy.
 *  - Verifies the integrity of the newly created backup with `PRAGMA quick_check`.
 *  - Automatically rotates backups, keeping the last N snapshots (default: 7).
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

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
export const DEFAULT_MAX_RETAINED = 7;

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
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED;

  try {
    // 1. Ensure source database exists
    if (!fs.existsSync(dbPath)) {
      return { success: false, error: `Source database not found at: ${dbPath}` };
    }

    // 2. Ensure backup directory exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // 3. Open connection to flush WAL and execute VACUUM INTO
    const filename = `homeasy_backup_${getTimestampString()}.db`;
    const targetPath = path.join(backupDir, filename);

    // If a backup file already exists with this exact second, append a short random token
    const finalTargetPath = fs.existsSync(targetPath)
      ? path.join(backupDir, `homeasy_backup_${getTimestampString()}_${Math.random().toString(36).slice(2, 6)}.db`)
      : targetPath;
    const finalFilename = path.basename(finalTargetPath);

    const sourceDb = new DatabaseSync(dbPath);

    try {
      // Force WAL checkpoint to flush all uncommitted journal frames
      sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');

      // Use VACUUM INTO for a non-blocking, safe online snapshot
      // Escape single quotes in path if any
      const escapedPath = finalTargetPath.replace(/'/g, "''");
      sourceDb.exec(`VACUUM INTO '${escapedPath}';`);
    } finally {
      sourceDb.close();
    }

    // 4. Verify the backup file exists and has content
    if (!fs.existsSync(finalTargetPath)) {
      return { success: false, error: `Backup file was not created at ${finalTargetPath}` };
    }

    const stat = fs.statSync(finalTargetPath);
    if (stat.size === 0) {
      fs.unlinkSync(finalTargetPath);
      return { success: false, error: 'Backup file was created with 0 bytes' };
    }

    // 5. Verify backup database integrity
    const backupDb = new DatabaseSync(finalTargetPath);
    try {
      const checkRow = backupDb.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
      const integrityOk = checkRow?.quick_check === 'ok';
      if (!integrityOk) {
        backupDb.close();
        fs.unlinkSync(finalTargetPath);
        return { success: false, error: `Backup file failed integrity check: ${checkRow?.quick_check}` };
      }
    } finally {
      backupDb.close();
    }

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
    return { success: false, error: `Failed to create database backup: ${msg}` };
  }
}

/**
 * Keeps the most recent `maxRetained` backups in `backupDir` and deletes the rest.
 */
export function pruneOldBackups(backupDir: string, maxRetained = DEFAULT_MAX_RETAINED): { retained: number; pruned: number } {
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

