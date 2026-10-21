/**
 * Dedicated, scraper-independent local SQLite backup process.
 *
 * Uses the same verified VACUUM INTO snapshots as maintenance and /backup.
 * Run as a separate Docker Compose service, with only the data bind mount.
 * No scraper, Telegram or API credentials are required.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseBackup, DEFAULT_DB_PATH } from './backup';
import type { BackupResult } from './backup';

export const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const BACKUP_RETRY_MS = 30 * 60 * 1000;
export const BACKUP_HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const BACKUP_NAME_PATTERN = /^homeasy_backup_\d{4}-\d{2}-\d{2}_\d{6}(?:_[\da-f-]+)?\.db$/;

export function localBackupDir(dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/**
 * Health checks require a non-empty published snapshot younger than 24 hours.
 * Incomplete `.partial` files are never considered valid recovery points.
 * Each published `.db` was checked by createDatabaseBackup before its rename.
 */
export function inspectRecentBackup(
  backupDir: string,
  nowMs = Date.now(),
  maxAgeMs = BACKUP_HEALTH_MAX_AGE_MS,
): { healthy: boolean; filename?: string; ageMs?: number; reason?: string } {
  if (!fs.existsSync(backupDir)) {
    return { healthy: false, reason: 'Backup directory does not exist' };
  }

  let latest: { filename: string; mtimeMs: number } | undefined;
  for (const filename of fs.readdirSync(backupDir)) {
    if (!BACKUP_NAME_PATTERN.test(filename)) continue;
    const stats = fs.statSync(path.join(backupDir, filename));
    // Filesystem mtimes may have sub-millisecond precision while Date.now()
    // returns an integer; permit a small forward skew, not arbitrary future files.
    if (!stats.isFile() || stats.size <= 0 || stats.mtimeMs > nowMs + 60_000) continue;
    if (!latest || stats.mtimeMs > latest.mtimeMs) {
      latest = { filename, mtimeMs: stats.mtimeMs };
    }
  }

  if (!latest) return { healthy: false, reason: 'No published backup snapshots found' };
  const ageMs = Math.max(0, nowMs - latest.mtimeMs);
  if (ageMs > maxAgeMs) {
    return { healthy: false, filename: latest.filename, ageMs, reason: 'Latest backup is too old' };
  }
  return { healthy: true, filename: latest.filename, ageMs };
}

/**
 * Shared schedule for the live worker and accelerated offline rehearsals.
 * The wait function is injectable so tests can advance time without waiting
 * 12 hours or touching the running Docker backup worker.
 */
export async function runBackupSchedule(
  backup: () => BackupResult,
  wait: (ms: number) => Promise<void>,
  isRunning: () => boolean,
  report: (result: BackupResult) => void,
): Promise<void> {
  while (isRunning()) {
    const result = backup();
    report(result);
    if (isRunning()) await wait(result.success ? BACKUP_INTERVAL_MS : BACKUP_RETRY_MS);
  }
}

async function runBackupWorker(): Promise<void> {
  let running = true;
  let pendingTimer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;

  const stop = () => {
    running = false;
    if (pendingTimer) clearTimeout(pendingTimer);
    wake?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    wake = resolve;
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      wake = undefined;
      resolve();
    }, ms);
  });

  console.log('[Backup] Local backup worker started (every 12h; retry failures after 30m).');
  await runBackupSchedule(createDatabaseBackup, sleep, () => running, (result) => {
    if (result.success) {
      console.log(`[Backup] Verified ${result.filename} (${result.sizeBytes} bytes, ${result.retainedCount} retained).`);
    } else {
      console.error(`[Backup] Snapshot failed: ${result.error}`);
    }
  });
  console.log('[Backup] Worker stopped.');
}

if (require.main === module) {
  if (process.argv.includes('--health')) {
    try {
      const result = inspectRecentBackup(localBackupDir());
      if (!result.healthy) {
        console.error(`[Backup] UNHEALTHY: ${result.reason}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error('[Backup] UNHEALTHY:', error);
      process.exitCode = 1;
    }
  } else {
    void runBackupWorker().catch((error: unknown) => {
      console.error('[Backup] Worker fatal error:', error);
      process.exitCode = 1;
    });
  }
}
