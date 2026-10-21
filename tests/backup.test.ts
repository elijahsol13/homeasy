import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { createDatabaseBackup, pruneOldBackups } from '../src/database/backup';

describe('Database Backup Service', () => {
  const testDir = path.join(process.cwd(), 'scratch', 'test_backups');
  const testDbPath = path.join(testDir, 'test_source.db');
  const testBackupDir = path.join(testDir, 'backup_store');

  beforeAll(() => {
    // Setup test directory and dummy SQLite database with a table
    fs.mkdirSync(testDir, { recursive: true });
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testBackupDir)) fs.rmSync(testBackupDir, { recursive: true, force: true });

    const db = new DatabaseSync(testDbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO test_items (name) VALUES ('Item A'), ('Item B'), ('Item C');
    `);
    db.close();
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  test('creates verified database backup snapshot with positive size', () => {
    const result = createDatabaseBackup({
      dbPath: testDbPath,
      backupDir: testBackupDir,
      maxRetained: 3,
    });

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(result.filename).toMatch(/^homeasy_backup_\d{4}-\d{2}-\d{2}_\d{6}.*\.db$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(result.backupPath!)).toBe(true);

    // Verify backup database content matches source
    const backupDb = new DatabaseSync(result.backupPath!);
    const countRow = backupDb.prepare('SELECT COUNT(*) as count FROM test_items').get() as { count: number };
    expect(countRow.count).toBe(3);
    backupDb.close();
  });

  test('restores a verified snapshot to a separate writable SQLite database', () => {
    const snapshot = createDatabaseBackup({
      dbPath: testDbPath,
      backupDir: testBackupDir,
      maxRetained: 3,
    });
    expect(snapshot.success).toBe(true);

    const restoredPath = path.join(testDir, 'restored.db');
    fs.copyFileSync(snapshot.backupPath!, restoredPath);
    const restored = new DatabaseSync(restoredPath);
    try {
      expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(restored.prepare('SELECT name FROM test_items ORDER BY id').all()).toEqual([
        { name: 'Item A' }, { name: 'Item B' }, { name: 'Item C' },
      ]);
      restored.prepare('INSERT INTO test_items(name) VALUES(?)').run('Restore is writable');
      expect(restored.prepare('SELECT COUNT(*) AS count FROM test_items').get()).toEqual({ count: 4 });
    } finally {
      restored.close();
    }

    const original = new DatabaseSync(testDbPath, { readOnly: true });
    try {
      expect(original.prepare('SELECT COUNT(*) AS count FROM test_items').get()).toEqual({ count: 3 });
    } finally {
      original.close();
    }
  });

  test('backs up committed data while another connection has an open WAL write transaction', () => {
    const writer = new DatabaseSync(testDbPath);
    writer.exec('BEGIN IMMEDIATE');
    try {
      writer.prepare("INSERT INTO test_items(name) VALUES('Uncommitted')").run();
      const result = createDatabaseBackup({ dbPath: testDbPath, backupDir: testBackupDir, maxRetained: 3 });
      expect(result.success).toBe(true);

      const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
      try {
        expect(backup.prepare('SELECT COUNT(*) AS count FROM test_items').get()).toEqual({ count: 3 });
      } finally {
        backup.close();
      }
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  test('rejects a snapshot containing foreign key violations', () => {
    const invalidDbPath = path.join(testDir, 'invalid_foreign_keys.db');
    const invalid = new DatabaseSync(invalidDbPath);
    invalid.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents(id INTEGER PRIMARY KEY);
      CREATE TABLE children(parent_id INTEGER REFERENCES parents(id));
      INSERT INTO children(parent_id) VALUES (100);
    `);
    invalid.close();

    const result = createDatabaseBackup({ dbPath: invalidDbPath, backupDir: testBackupDir, maxRetained: 3 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('foreign key violation');
    expect(result.backupPath).toBeUndefined();
    expect(fs.readdirSync(testBackupDir).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  test('never publishes a corrupt source or leaves an incomplete snapshot after failure', () => {
    const brokenPath = path.join(testDir, 'corrupt_source.db');
    const isolatedDir = path.join(testDir, 'broken_backups');
    fs.writeFileSync(brokenPath, 'not a sqlite database');
    const result = createDatabaseBackup({ dbPath: brokenPath, backupDir: isolatedDir });
    expect(result.success).toBe(false);
    expect(fs.readdirSync(isolatedDir)).toEqual([]);
  });

  test('publishes distinct verified snapshots even within one second', () => {
    const isolatedDir = path.join(testDir, 'rapid_backups');
    const first = createDatabaseBackup({ dbPath: testDbPath, backupDir: isolatedDir });
    const second = createDatabaseBackup({ dbPath: testDbPath, backupDir: isolatedDir });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(fs.readdirSync(isolatedDir).sort()).toEqual([first.filename!, second.filename!].sort());
  });

  test('handles nonexistent database source gracefully', () => {
    const result = createDatabaseBackup({
      dbPath: path.join(testDir, 'nonexistent.db'),
      backupDir: testBackupDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('uses the deployed DATABASE_PATH and adjacent backup folder by default', () => {
    const previous = process.env.DATABASE_PATH;
    const separateDb = path.join(testDir, 'configured', 'configured.db');
    fs.mkdirSync(path.dirname(separateDb), { recursive: true });
    const db = new DatabaseSync(separateDb);
    try {
      db.exec("CREATE TABLE data_source (name TEXT); INSERT INTO data_source VALUES ('configured');");
    } finally {
      db.close();
    }

    try {
      process.env.DATABASE_PATH = separateDb;
      const result = createDatabaseBackup();
      expect(result.success).toBe(true);
      expect(path.dirname(result.backupPath!)).toBe(path.join(testDir, 'configured', 'backups'));
      const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
      try {
        expect(backup.prepare('SELECT name FROM data_source').get()).toEqual({ name: 'configured' });
      } finally {
        backup.close();
      }
    } finally {
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  });

  test('rejects retention zero before publishing or pruning a snapshot', () => {
    const isolatedDir = path.join(testDir, 'invalid_retention');
    const result = createDatabaseBackup({ dbPath: testDbPath, backupDir: isolatedDir, maxRetained: 0 });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('maxRetained') });
    expect(fs.existsSync(isolatedDir)).toBe(false);
    expect(() => pruneOldBackups(testBackupDir, 0)).toThrow('maxRetained');
  });

  test('prunes older backups when exceeding maxRetained', () => {
    // Reset testBackupDir for isolation
    fs.rmSync(testBackupDir, { recursive: true, force: true });
    fs.mkdirSync(testBackupDir, { recursive: true });
    const now = Date.now();

    for (let i = 1; i <= 5; i++) {
      const dummyPath = path.join(testBackupDir, `homeasy_backup_2026-09-0${i}_120000.db`);
      fs.writeFileSync(dummyPath, `dummy-backup-${i}`);
      // Set modification times so 05 is newest, 01 is oldest
      const fileTime = new Date(now + i * 10000);
      fs.utimesSync(dummyPath, fileTime, fileTime);
    }

    const { retained, pruned } = pruneOldBackups(testBackupDir, 3);
    expect(retained).toBe(3);
    expect(pruned).toBe(2);

    const remainingFiles = fs.readdirSync(testBackupDir).filter((f) => f.startsWith('homeasy_backup_') && f.endsWith('.db'));
    expect(remainingFiles.length).toBe(3);
  });
});
