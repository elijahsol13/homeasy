import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabaseBackup, DEFAULT_MAX_RETAINED } from '../src/database/backup';
import {
  BACKUP_HEALTH_MAX_AGE_MS,
  BACKUP_INTERVAL_MS,
  BACKUP_RETRY_MS,
  inspectRecentBackup,
  localBackupDir,
  runBackupSchedule,
} from '../src/database/backup-worker';

describe('Independent local backup worker health', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-backup-worker-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('publishes a verified local snapshot and recognizes a fresh recovery point', () => {
    const dbPath = path.join(tempDir, 'database.db');
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE persisted (name TEXT); INSERT INTO persisted VALUES ('safe');");
    db.close();

    const backupDir = localBackupDir(dbPath);
    const result = createDatabaseBackup({ dbPath, backupDir });
    expect(result.success).toBe(true);
    expect(DEFAULT_MAX_RETAINED).toBeGreaterThanOrEqual(14);
    expect(BACKUP_INTERVAL_MS).toBeLessThan(BACKUP_HEALTH_MAX_AGE_MS);

    expect(inspectRecentBackup(backupDir)).toMatchObject({ healthy: true, filename: result.filename });
    const restored = new DatabaseSync(result.backupPath!, { readOnly: true });
    try {
      expect(restored.prepare('SELECT name FROM persisted').get()).toEqual({ name: 'safe' });
    } finally {
      restored.close();
    }
  });

  test('fails health checks on missing, incomplete or stale backups', () => {
    const backupDir = path.join(tempDir, 'backups');
    expect(inspectRecentBackup(backupDir)).toMatchObject({ healthy: false });
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, '.homeasy_backup_2026-10-14_120000.partial'), 'partial');
    expect(inspectRecentBackup(backupDir)).toMatchObject({ healthy: false });

    const oldSnapshot = path.join(backupDir, 'homeasy_backup_2026-10-12_120000.db');
    fs.writeFileSync(oldSnapshot, 'published snapshot');
    const oldDate = new Date(Date.now() - BACKUP_HEALTH_MAX_AGE_MS - 60_000);
    fs.utimesSync(oldSnapshot, oldDate, oldDate);
    expect(inspectRecentBackup(backupDir)).toMatchObject({
      healthy: false,
      reason: 'Latest backup is too old',
    });

    const freshSnapshot = path.join(backupDir, 'homeasy_backup_2026-10-14_120000.db');
    fs.writeFileSync(freshSnapshot, 'published snapshot');
    expect(inspectRecentBackup(backupDir)).toMatchObject({
      healthy: true,
      filename: path.basename(freshSnapshot),
    });
  });

  test('simulates 12h snapshots, 30m failure retry, and shutdown on an isolated SQLite fixture', async () => {
    const dbPath = path.join(tempDir, 'fixture.db');
    const backupDir = localBackupDir(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE persisted (name TEXT NOT NULL); INSERT INTO persisted VALUES ('safe');");
    db.close();

    const attempts: { atMs: number; success: boolean }[] = [];
    const waits: number[] = [];
    let clockMs = 0;

    await runBackupSchedule(
      () => {
        // Attempt 2 uses a missing source, exercising the real backup failure path.
        const source = attempts.length === 1 ? path.join(tempDir, 'missing.db') : dbPath;
        return createDatabaseBackup({ dbPath: source, backupDir });
      },
      async (ms) => { waits.push(ms); clockMs += ms; },
      () => attempts.length < 4,
      (result) => { attempts.push({ atMs: clockMs, success: result.success }); },
    );

    expect(attempts).toEqual([
      { atMs: 0, success: true },
      { atMs: BACKUP_INTERVAL_MS, success: false },
      { atMs: BACKUP_INTERVAL_MS + BACKUP_RETRY_MS, success: true },
      { atMs: 2 * BACKUP_INTERVAL_MS + BACKUP_RETRY_MS, success: true },
    ]);
    expect(waits).toEqual([BACKUP_INTERVAL_MS, BACKUP_RETRY_MS, BACKUP_INTERVAL_MS]);

    const published = fs.readdirSync(backupDir).filter((name) => name.endsWith('.db'));
    expect(published).toHaveLength(3);
    for (const name of published) {
      const restored = new DatabaseSync(path.join(backupDir, name), { readOnly: true });
      try {
        expect(restored.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
        expect(restored.prepare('SELECT name FROM persisted').get()).toEqual({ name: 'safe' });
      } finally {
        restored.close();
      }
    }
  });

  test('accelerates actual timer waits without running a real 12-hour interval', async () => {
    jest.useFakeTimers();
    try {
      const startedAt = Date.now();
      const calls: number[] = [];
      const task = runBackupSchedule(
        () => {
          calls.push(Date.now() - startedAt);
          return calls.length === 2 ? { success: false, error: 'simulated outage' } : { success: true };
        },
        (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        () => calls.length < 3,
        () => undefined,
      );

      expect(calls).toEqual([0]);
      await jest.advanceTimersByTimeAsync(BACKUP_INTERVAL_MS - 1);
      expect(calls).toEqual([0]);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([0, BACKUP_INTERVAL_MS]);
      await jest.advanceTimersByTimeAsync(BACKUP_RETRY_MS);
      expect(calls).toEqual([0, BACKUP_INTERVAL_MS, BACKUP_INTERVAL_MS + BACKUP_RETRY_MS]);
      await task;
    } finally {
      jest.useRealTimers();
    }
  });
});
