import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rehearseWalRollback } from '../scripts/recovery-wal-rollback-rehearsal';

test('preserves uncheckpointed WAL and SHM, then restores a snapshot without replaying stale writes', () => {
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-wal-input-test-'));
  const source = path.join(inputDir, 'snapshot.db');
  let scratch: string | undefined;
  try {
    const seed = new DatabaseSync(source);
    try {
      seed.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);');
      seed.exec('CREATE TABLE properties (id INTEGER PRIMARY KEY); INSERT INTO properties VALUES (2);');
    } finally {
      seed.close();
    }
    const originalHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const result = rehearseWalRollback(source);
    scratch = result.scratch;

    assert.equal(result.status, 'pass');
    expect(result.walReplay).toEqual({ mainFileAloneExcludesCommittedMutation: true,
      committedMutationVisible: true, integrity: 'ok', foreignKeyViolations: 0 });
    expect(result.restore).toMatchObject({ protectedTripletBeforeOverwrite: true,
      staleWalShmExcluded: true, incidentMutationAbsent: true, writable: true,
      counts: { users: 1, properties: 1 } });
    expect(result.incidentTriplet['-wal']).toBeGreaterThan(32);
    expect(result.incidentTriplet['-shm']).toBeGreaterThan(0);
    for (const suffix of ['', '-wal', '-shm']) {
      const saved = path.join(scratch, 'preserved-before-rollback', 'database.db' + suffix);
      expect(fs.existsSync(saved)).toBe(true);
      const digest = createHash('sha256').update(fs.readFileSync(saved)).digest('hex');
      expect(digest).toBe(result.incidentHashes[suffix || '.db']);
    }

    const restored = path.join(scratch, 'simulated-volume', 'database.db');
    const connection = new DatabaseSync(restored, { readOnly: true });
    try {
      expect(connection.prepare("SELECT 1 FROM sqlite_master WHERE name='__homeasy_wal_incident_probe'").get()).toBeUndefined();
      expect(connection.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    } finally {
      connection.close();
    }
    expect(createHash('sha256').update(fs.readFileSync(source)).digest('hex')).toEqual(originalHash);
    expect(result.docker).toEqual({ executed: false });
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});
