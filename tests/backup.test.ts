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

  test('handles nonexistent database source gracefully', () => {
    const result = createDatabaseBackup({
      dbPath: path.join(testDir, 'nonexistent.db'),
      backupDir: testBackupDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
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
