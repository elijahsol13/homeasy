import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { CanonicalFreshnessExecutor } from '../src/modules/parser/canonical-freshness-executor';
import { runOfflineCanary, validateCanarySnapshot } from '../scripts/canonical-freshness-canary';

const FIXED_NOW = new Date('2026-10-15T08:00:00.000Z');

describe('protected, fully offline freshness canary', () => {
  let root: string;
  let snapshot: string;

  function hash(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  function populate(withDemand = true, withInheritedJob = true): void {
    const db = new DatabaseSync(snapshot);
    try {
      runMigrations(db);
      if (withDemand) {
        db.prepare('INSERT INTO users(telegram_id) VALUES(?)').run(100_001);
        db.prepare(`INSERT INTO search_filters(user_id,type,min_price,max_price,bedrooms,locations,city,is_active)
          VALUES(1,'rent',NULL,90000,NULL,'[]','siem_reap',1)`).run();
      }
      const repo = new SourceIngestionRepository(db);
      for (let i = 0; i < 3; i++) {
        const id = Number(db.prepare(`INSERT INTO canonical_listings
          (public_ref,status,availability_status,price,title,city,first_seen_at,last_seen_at)
          VALUES('lst_'||lower(hex(randomblob(16))),'active','available',50000,'Canary','siem_reap',?,?)`)
          .run('2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z').lastInsertRowid);
        const registry = repo.upsertSource({ sourceType: 'KHMER24', externalSourceId: `canary-${i}`, name: 'Khmer24' });
        const item = repo.upsertSourceItemDetailed(registry, { sourceType: 'KHMER24', externalId: `ad-${i}`,
          rawText: 'Canary property', contentHash: `hash-${i}`, classification: 'HOUSING_SUPPLY' }).id;
        db.prepare(`INSERT INTO canonical_listing_source_occurrences
          (source_item_id,listing_id,source_registry_id,external_id,source_url,first_seen_at,last_seen_at,source_entity_key)
          VALUES(?,?,?,?,?,?,?,'canonical-dedupe-v1')`).run(item, id, registry, `ad-${i}`,
          `https://www.khmer24.com/en/ad-adid-${i + 1}`, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
        if (i === 2 && withInheritedJob) {
          // An inherited queue entry must not be claimed, even when it is due and free.
          db.prepare(`INSERT INTO freshness_jobs
            (listing_id,source_occurrence_id,check_type,provider,scheduled_at,status,estimated_records)
            VALUES(?,(SELECT id FROM canonical_listing_source_occurrences WHERE listing_id=?),
            'SOURCE_RECHECK','KHMER24',?,'QUEUED',0)`).run(id, id, '2026-10-01T00:00:00Z');
        }
      }
      db.prepare(`INSERT INTO external_provider_usage(provider,operation,records,estimated_cost,actual_cost)
        VALUES('BrightData','previous-period',12,1,0.75)`).run();
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { db.close(); }
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-canary-fixture-')));
    const dir = path.join(root, 'data/backups/verified-checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    snapshot = path.join(dir, 'fixture.db');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('requires a supplied, trusted, standalone snapshot (never production SQLite)', () => {
    expect(() => validateCanarySnapshot('', root)).toThrow();
    expect(() => validateCanarySnapshot('../../outside.db', root)).toThrow();
    fs.writeFileSync(snapshot, 'not a database');
    expect(() => validateCanarySnapshot(snapshot, root)).toThrow(/standalone/);
    fs.unlinkSync(snapshot);
    populate();
    expect(validateCanarySnapshot(snapshot, root)).toBe(snapshot);
    expect(() => validateCanarySnapshot(path.join(root, 'data/homeasy.db'), root))
      .toThrow(/verified-checkpoints/);
    const outside = path.join(root, 'data/outside.db');
    fs.copyFileSync(snapshot, outside);
    fs.renameSync(snapshot, path.join(root, 'data/backups/verified-checkpoints', 'original.db'));
    fs.symlinkSync(outside, snapshot);
    expect(() => validateCanarySnapshot(snapshot, root)).toThrow(/symlink/);
  });

  it('rejects hardlinks to the active SQLite inode and dirty checkpoint sidecars', () => {
    populate();
    const live = path.join(root, 'data/homeasy.db');
    fs.linkSync(snapshot, live);
    expect(() => validateCanarySnapshot(snapshot, root)).toThrow(/standalone|hardlink/);
    fs.unlinkSync(live);
    fs.writeFileSync(snapshot + '-wal', 'sidecar');
    expect(() => validateCanarySnapshot(snapshot, root)).toThrow(/sidecar/);
  });

  it('rejects a symlinked checkpoint directory', () => {
    populate();
    const realDir = path.join(root, 'data/backups/real-checkpoints');
    fs.renameSync(path.dirname(snapshot), realDir);
    fs.symlinkSync(realDir, path.dirname(snapshot));
    expect(() => validateCanarySnapshot(snapshot, root)).toThrow(/symlink/);
  });

  it('previews two new jobs, executes only one and preserves an inherited task and paid usage', async () => {
    populate();
    const initialHash = hash(snapshot);
    const result = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 2, execute: 1, now: FIXED_NOW });
    expect(result).toMatchObject({ status: 'pass', sourceUnchanged: true, scratchRemoved: true,
      integrity: 'ok', foreignKeyViolations: 0, rollbackVerified: true, mockFetcherCalls: 1,
      networkAttempts: 0, productionWrites: 0,
      preview: { considered: 2, eligible: 2 }, staging: { count: 2 },
      paidDelta: { usageRows: 0, providerRecords: 0, providerEstimatedCost: 0, providerActualCost: 0,
        jobEstimatedRecords: 0, jobEstimatedCost: 0, jobActualCost: 0 } });
    expect(result.executions).toHaveLength(1);
    expect(result.before).toMatchObject({ jobs: 1, externalUsageRows: 1, externalUsageRecords: 12,
      externalEstimatedCost: 1, externalActualCost: 0.75 });
    expect(result.after).toMatchObject({ jobs: 3, attempts: 1, observations: 1,
      statuses: { QUEUED: 2, DONE: 1 } });
    expect(hash(snapshot)).toBe(initialHash);
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()?.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) n FROM availability_checks').get()?.n).toBe(0);
    } finally { db.close(); }
  });

  it('handles an empty real planning cohort without inventing a listing', async () => {
    populate(false);
    const result = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot, now: FIXED_NOW });
    expect(result).toMatchObject({ rollbackVerified: true, mockFetcherCalls: 0,
      preview: { considered: 0, eligible: 0 }, staging: { count: 0 }, scratchRemoved: true });
    expect(result.executions).toEqual([]);
  });

  it('rejects invalid batch bounds and does not alter the snapshot', async () => {
    populate();
    const before = hash(snapshot);
    await expect(runOfflineCanary({ projectRoot: root, snapshotPath: snapshot, limit: 26 }))
      .rejects.toThrow(/limit must be/);
    await expect(runOfflineCanary({ projectRoot: root, snapshotPath: snapshot, limit: 2, execute: 3 }))
      .rejects.toThrow(/execute must be/);
    expect(hash(snapshot)).toBe(before);
  });

  it('stops accidental HTTP before network I/O, cleans scratch even on failure', async () => {
    populate();
    const before = hash(snapshot);
    let scratch = '';
    await expect(runOfflineCanary({ projectRoot: root, snapshotPath: snapshot, now: FIXED_NOW,
      onScratchReady: (_db, scratchPath) => {
        scratch = scratchPath;
        require('node:http').get('http://127.0.0.1:1234');
      },
    })).rejects.toThrow(/network access prohibited/);
    expect(scratch).not.toBe('');
    expect(fs.existsSync(scratch)).toBe(false);
    expect(hash(snapshot)).toBe(before);
  });

  it('cleans up after a forced failure without writing any source bytes', async () => {
    populate();
    const before = hash(snapshot);
    let scratch = '';
    await expect(runOfflineCanary({ projectRoot: root, snapshotPath: snapshot, now: FIXED_NOW,
      onScratchReady: (_db, dir) => { scratch = dir; throw new Error('fault injection'); },
    })).rejects.toThrow(/fault injection/);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(hash(snapshot)).toBe(before);
  });

  it('cleans the disposable database and restores network entry points after a post-staging failure', async () => {
    populate();
    const before = hash(snapshot);
    const originalHttpGet = require('node:http').get;
    const originalFetch = globalThis.fetch;
    let scratch = '';
    await expect(runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 2, now: FIXED_NOW,
      onScratchReady: (db, dir) => {
        scratch = dir;
        db.exec(`CREATE TEMP TRIGGER fail_after_staging BEFORE UPDATE ON freshness_jobs
          WHEN NEW.status='RUNNING' BEGIN SELECT RAISE(ABORT, 'post-staging fault'); END`);
      },
    })).rejects.toThrow(/post-staging fault/);
    expect(scratch).not.toBe('');
    expect(fs.existsSync(scratch)).toBe(false);
    expect(hash(snapshot)).toBe(before);
    expect(require('node:http').get).toBe(originalHttpGet);
    expect(globalThis.fetch).toBe(originalFetch);
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()?.n).toBe(1);
    } finally { db.close(); }
  });

  it('rejects a corrupt SQLite snapshot and removes its disposable copy', async () => {
    fs.writeFileSync(snapshot, Buffer.alloc(8192, 0x20));
    const before = hash(snapshot);
    await expect(runOfflineCanary({ projectRoot: root, snapshotPath: snapshot, now: FIXED_NOW }))
      .rejects.toThrow();
    expect(hash(snapshot)).toBe(before);
  });

  it('limits execution to allowed job IDs, including an explicitly empty allowlist', async () => {
    populate();
    const db = new DatabaseSync(snapshot);
    try {
      const fetcher = jest.fn(async () => ({ outcome: 'ALIVE' as const }));
      const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher,
        onlyJobIds: [], now: () => FIXED_NOW });
      expect(await executor.runOne()).toEqual({ status: 'idle' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(() => new CanonicalFreshnessExecutor(db, { onlyJobIds: [1, 1] })).toThrow(/onlyJobIds/);
    } finally { db.close(); }
  });

  it('rehearses three paced, measured probes on a disposable clone only', async () => {
    populate(true, false);
    const before = hash(snapshot);
    let clock = 0;
    const pauses: number[] = [];
    const report = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 3, execute: 3, now: FIXED_NOW, operator: {
        minIntervalMs: 250, maxReceivedBytes: 2048,
        monotonicMs: () => clock,
        wait: async (ms) => { pauses.push(ms); clock += ms; },
        mockResponses: [
          { outcome: 'ALIVE', bytesRead: 300, statusCode: 200 },
          { outcome: 'DEAD', bytesRead: 0, statusCode: 404 },
          { outcome: 'ALIVE', bytesRead: 400, statusCode: 200 },
        ],
      } });
    expect(report).toMatchObject({ status: 'pass', scratchRemoved: true,
      networkAttempts: 0, productionWrites: 0, mockFetcherCalls: 3,
      trafficMeasurement: 'simulated received body bytes only',
      operatorReport: { stopReason: 'completed', attempts: 3, receivedBytes: 700 } });
    const probes = (report.operatorReport as { probes: Array<{ outcome: string; receivedBytes: number }> }).probes;
    expect(probes.map((probe) => probe.outcome)).toEqual(['ALIVE', 'DEAD', 'ALIVE']);
    expect(pauses).toEqual([250, 250]);
    expect(hash(snapshot)).toBe(before);
  });

  it('halts the offline operator at an unknown challenge and preserves remaining jobs', async () => {
    populate(true, false);
    const report = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 3, execute: 3, now: FIXED_NOW, operator: {
        minIntervalMs: 0, mockResponses: [{ outcome: 'UNKNOWN', bytesRead: 1000,
          statusCode: 403, reason: 'cloudflare_blocked' }],
      } });
    expect(report).toMatchObject({ mockFetcherCalls: 1, networkAttempts: 0,
      operatorReport: { stopReason: 'unknown', attempts: 1, receivedBytes: 1000 },
      after: { statuses: { DONE: 1, QUEUED: 2 } } });
  });

  it('stops after crossing the aggregate simulated byte budget', async () => {
    populate(true, false);
    const report = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 3, execute: 3, now: FIXED_NOW, operator: {
        minIntervalMs: 0, maxReceivedBytes: 400,
        mockResponses: [{ outcome: 'ALIVE', bytesRead: 500 }],
      } });
    expect(report).toMatchObject({ mockFetcherCalls: 1,
      operatorReport: { stopReason: 'byte_budget', attempts: 1, receivedBytes: 500 } });
  });

  it('cancels during the pacing interval before the next probe', async () => {
    populate(true, false);
    let clock = 0;
    const controller = new AbortController();
    const report = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 3, execute: 3, now: FIXED_NOW, operator: {
        minIntervalMs: 500, signal: controller.signal, monotonicMs: () => clock,
        wait: async (ms) => { clock += ms; controller.abort(); },
      } });
    expect(report).toMatchObject({ mockFetcherCalls: 1, networkAttempts: 0,
      operatorReport: { stopReason: 'cancelled', attempts: 1 } });
  });

  it('fails closed when the transport omits byte measurements', async () => {
    populate(true, false);
    const report = await runOfflineCanary({ projectRoot: root, snapshotPath: snapshot,
      limit: 2, execute: 2, now: FIXED_NOW, operator: {
        minIntervalMs: 0, mockResponses: [{ outcome: 'ALIVE' }],
      } });
    expect(report).toMatchObject({ mockFetcherCalls: 1,
      operatorReport: { stopReason: 'fetch_error', attempts: 1, receivedBytes: 0 },
      after: { attempts: 1 } });
    const batch = report.operatorReport as { probes: Array<{ executionStatus: string; reason: string }> };
    expect(batch.probes[0]).toMatchObject({ executionStatus: 'retry_scheduled',
      reason: 'Probe did not report valid received byte count' });
  });
});
