/**
 * Operator-invoked, network-blocked Khmer24 freshness rehearsal.
 * npm run freshness:canary -- data/backups/verified-checkpoints/<snapshot>.db [--limit 10] [--execute 10]
 * All migrations, staging, execution and rollback probes happen on a disposable SQLite copy.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { stageCanonicalKhmer24Freshness } from '../src/modules/parser/canonical-freshness-stager';
import { CanonicalFreshnessExecutor } from '../src/modules/parser/canonical-freshness-executor';
import { runSupervisedFreshnessBatch } from '../src/modules/parser/canonical-freshness-supervisor';
import type { SupervisedOptions } from '../src/modules/parser/canonical-freshness-supervisor';
import type { LinkCheckResult } from '../src/services/link-verifier.service';

const ROOT = path.resolve(__dirname, '..');
const MAX_BATCH = 25;

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Trust only an ordinary, standalone checkpoint file within the project's protected directory. */
export function validateCanarySnapshot(input: string, root = ROOT): string {
  const base = path.resolve(root, 'data/backups/verified-checkpoints');
  const source = path.resolve(root, input);
  assert.equal(path.dirname(source), base, 'Snapshot must be directly inside verified-checkpoints/');
  assert.match(path.basename(source), /^[\w-]+\.db$/, 'Snapshot must be an ordinary .db checkpoint');
  const canonicalBase = fs.realpathSync(base);
  assert.equal(canonicalBase, base, 'Checkpoint directory must not be a symlink');
  assert.equal(fs.realpathSync(source), source, 'Snapshot path must not traverse a symlink');
  const stat = fs.lstatSync(source);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 4096,
    'Snapshot must be a standalone regular SQLite file');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.ok(!fs.existsSync(source + suffix), `Snapshot must have no sidecar ${suffix}`);
  }
  const live = path.join(path.resolve(root, 'data'), 'homeasy.db');
  if (fs.existsSync(live)) {
    const liveStat = fs.statSync(live);
    assert.ok(liveStat.dev !== stat.dev || liveStat.ino !== stat.ino,
      'Refusing a hardlink to production SQLite');
  }
  return source;
}

/** Fail closed if any imported code accidentally tries to use a Node network transport. */
function blockNetwork(): { getAttempts: () => number; restore: () => void } {
  let attempts = 0;
  const restore: Array<() => void> = [];
  const forbid = (): never => { attempts++; throw new Error('Offline canary: network access prohibited'); };
  const override = (obj: object, name: string): void => {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    assert.ok(desc && (desc.configurable || desc.writable), `Cannot secure network entry point ${name}`);
    Object.defineProperty(obj, name, { configurable: true, enumerable: desc.enumerable, writable: true, value: forbid });
    restore.push(() => { Object.defineProperty(obj, name, desc); });
  };
  try {
    const http = require('node:http') as typeof import('node:http');
    const https = require('node:https') as typeof import('node:https');
    const net = require('node:net') as typeof import('node:net');
    const tls = require('node:tls') as typeof import('node:tls');
    const dgram = require('node:dgram') as typeof import('node:dgram');
    const http2 = require('node:http2') as typeof import('node:http2');
    for (const name of ['get', 'request']) { override(http, name); override(https, name); }
    for (const name of ['connect', 'createConnection']) override(net, name);
    override(net.Socket.prototype, 'connect');
    override(tls, 'connect');
    override(dgram, 'createSocket');
    override(http2, 'connect');
    override(globalThis, 'fetch');
    if ('WebSocket' in globalThis) override(globalThis, 'WebSocket');
    return { getAttempts: () => attempts, restore: () => { for (const fn of restore.reverse()) fn(); } };
  } catch (error) {
    for (const fn of restore.reverse()) fn();
    throw error;
  }
}

function assertDbHealthy(db: DatabaseSync): void {
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok', 'SQLite integrity failed');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'SQLite foreign keys failed');
}

interface Metrics {
  statuses: Record<string, number>;
  jobs: number;
  attempts: number;
  observations: number;
  availabilityChecks: number;
  externalUsageRows: number;
  externalUsageRecords: number;
  externalEstimatedCost: number;
  externalActualCost: number;
  jobEstimatedRecords: number;
  jobEstimatedCost: number;
  jobActualCost: number;
}

function metrics(db: DatabaseSync): Metrics {
  const statuses = Object.fromEntries((db.prepare('SELECT status,COUNT(*) n FROM freshness_jobs GROUP BY status').all() as
    Array<{ status: string; n: number }>).map((row) => [row.status, row.n]));
  const jobs = db.prepare(`SELECT COUNT(*) jobs,COALESCE(SUM(attempts),0) attempts,
    COUNT(observation_id) observations,COALESCE(SUM(estimated_records),0) estimatedRecords,
    COALESCE(SUM(estimated_cost),0) estimatedCost,COALESCE(SUM(actual_cost),0) actualCost
    FROM freshness_jobs`).get() as Record<string, number>;
  const usage = db.prepare(`SELECT COUNT(*) rows,COALESCE(SUM(records),0) records,
    COALESCE(SUM(estimated_cost),0) estimatedCost,COALESCE(SUM(actual_cost),0) actualCost
    FROM external_provider_usage`).get() as Record<string, number>;
  const checks = db.prepare('SELECT COUNT(*) n FROM availability_checks').get() as { n: number };
  return { statuses, jobs: jobs.jobs, attempts: jobs.attempts, observations: jobs.observations,
    availabilityChecks: checks.n, externalUsageRows: usage.rows, externalUsageRecords: usage.records,
    externalEstimatedCost: usage.estimatedCost, externalActualCost: usage.actualCost,
    jobEstimatedRecords: jobs.estimatedRecords, jobEstimatedCost: jobs.estimatedCost,
    jobActualCost: jobs.actualCost };
}

function verifyRollback(db: DatabaseSync, eligible: Array<{ listingId: number }>,
  config: Parameters<typeof stageCanonicalKhmer24Freshness>[1]): boolean {
  const before = metrics(db);
  if (eligible.length > 0) {
    // Abort at the last candidate: when there are several, preceding inserts must also roll back.
    const target = eligible[eligible.length - 1]!.listingId;
    db.exec(`CREATE TEMP TRIGGER canary_reject_staging BEFORE INSERT ON freshness_jobs
      WHEN NEW.listing_id=${target} BEGIN SELECT RAISE(ABORT, 'canary rollback injection'); END`);
    try {
      assert.throws(() => stageCanonicalKhmer24Freshness(db, config, { apply: true, limit: MAX_BATCH }),
        /canary rollback injection/);
    } finally {
      db.exec('DROP TRIGGER temp.canary_reject_staging');
    }
  } else {
    // A genuinely empty queue must still prove that SQLite rolls back a real write.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE canary_rollback_probe (value TEXT)');
      db.exec("INSERT INTO canary_rollback_probe VALUES ('written')");
      throw new Error('canary rollback injection');
    } catch (error) {
      assert.match(String(error), /canary rollback injection/);
      db.exec('ROLLBACK');
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='canary_rollback_probe'").get()?.n, 0);
  }
  assert.equal(db.isTransaction, false);
  assert.deepEqual(metrics(db), before, 'Rollback left partially changed freshness data');
  return true;
}

export interface CanaryOptions {
  snapshotPath: string;
  limit?: number;
  execute?: number;
  /** Only used by isolated test fixtures; the CLI always uses the repository root. */
  projectRoot?: string;
  now?: Date;
  onScratchReady?: (db: DatabaseSync, scratchPath: string) => void;
  /** Offline operator rehearsal. All responses/byte counts are simulated. */
  operator?: {
    maxReceivedBytes?: number;
    minIntervalMs?: number;
    mockResponses?: readonly LinkCheckResult[];
    signal?: AbortSignal;
    monotonicMs?: SupervisedOptions['monotonicMs'];
    wait?: SupervisedOptions['wait'];
    onProbe?: SupervisedOptions['onProbe'];
  };
}

export async function runOfflineCanary(options: CanaryOptions) {
  const limit = options.limit ?? 10;
  const execute = options.execute ?? limit;
  assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_BATCH, 'limit must be 1-25');
  assert.ok(Number.isSafeInteger(execute) && execute >= 0 && execute <= limit, 'execute must be 0..limit');
  if (options.operator) {
    assert.ok(limit <= 3 && execute >= 1 && execute <= 3, 'operator rehearsal requires 1..3 checks');
  }
  const now = options.now ?? new Date();
  assert.ok(Number.isFinite(now.getTime()), 'Invalid canary clock');
  const source = validateCanarySnapshot(options.snapshotPath, options.projectRoot ?? ROOT);
  const sourceHash = sha256(source);
  const started = Date.now();
  const network = blockNetwork();
  let scratchDir: string | undefined;
  let db: DatabaseSync | undefined;
  let output: Record<string, unknown> | undefined;
  try {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-freshness-canary-'));
    const target = path.join(scratchDir, 'scratch.db');
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    assert.equal(sha256(target), sourceHash, 'Disposable copy differs from checkpoint');
    db = new DatabaseSync(target);
    db.exec('PRAGMA foreign_keys=ON');
    assertDbHealthy(db);
    runMigrations(db);
    assertDbHealthy(db);
    options.onScratchReady?.(db, scratchDir);
    const config = { monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0, now };
    const before = metrics(db);
    const inheritedJobRows = db.prepare(`SELECT id,status,attempts,result,observation_id,actual_cost
      FROM freshness_jobs ORDER BY id`).all();
    const preview = stageCanonicalKhmer24Freshness(db, config, { limit });
    assert.equal(preview.mode, 'DRY_RUN');
    assert.equal(preview.stagedIds.length, 0);
    assert.deepEqual(metrics(db), before, 'Preview modified SQLite data');
    const rollbackVerified = verifyRollback(db, preview.eligible, config);
    const staged = stageCanonicalKhmer24Freshness(db, config, { apply: true, limit });
    const allowed = staged.stagedIds;
    assert.deepEqual(staged.eligible.map((item) => item.listingId),
      preview.eligible.map((item) => item.listingId), 'Preview/staging mismatch');
    assert.ok(allowed.length <= limit, 'Staging exceeded limit');
    const stagedRows = db.prepare(`SELECT id,provider,check_type,estimated_records,estimated_cost
      FROM freshness_jobs WHERE id IN (${allowed.map(() => '?').join(',') || 'NULL'})`).all(...allowed) as
      Array<{ id: number; provider: string; check_type: string; estimated_records: number; estimated_cost: number }>;
    assert.equal(stagedRows.length, allowed.length);
    assert.ok(stagedRows.every((job) => job.provider === 'KHMER24' && job.check_type === 'SOURCE_RECHECK' &&
      job.estimated_records === 0 && job.estimated_cost === 0));
    let mockFetcherCalls = 0;
    let operatorReport: Awaited<ReturnType<typeof runSupervisedFreshnessBatch>> | undefined;
    const executions: Awaited<ReturnType<CanonicalFreshnessExecutor['runOne']>>[] = [];
    if (options.operator) {
      operatorReport = await runSupervisedFreshnessBatch(db, {
        onlyJobIds: allowed.slice(0, execute), maxChecks: execute,
        maxReceivedBytes: options.operator.maxReceivedBytes ?? 256 * 1024,
        minIntervalMs: options.operator.minIntervalMs ?? 1000,
        now: () => now, signal: options.operator.signal,
        monotonicMs: options.operator.monotonicMs, wait: options.operator.wait,
        onProbe: options.operator.onProbe,
        fetcher: async () => {
          const response = options.operator!.mockResponses?.[mockFetcherCalls] ??
            { outcome: 'ALIVE' as const, statusCode: 200, bytesRead: 512 };
          mockFetcherCalls++;
          return response;
        },
      });
      executions.push(...operatorReport.executions.filter((result) => result.status !== 'idle'));
    } else {
      const executor = new CanonicalFreshnessExecutor(db, { enabled: true, onlyJobIds: allowed,
        fetcher: async () => { mockFetcherCalls++; return { outcome: 'ALIVE' as const }; }, now: () => now });
      for (let i = 0; i < Math.min(execute, allowed.length); i++) {
        const result = await executor.runOne();
        executions.push(result);
      }
    }
    assert.ok(executions.every((result) => 'jobId' in result && allowed.includes(result.jobId!)),
      'Executor touched an inherited job');
    if (!options.operator) assert.ok(executions.every((result) => result.status === 'completed'), 'Mock execution failed');
    assert.equal(mockFetcherCalls, executions.length, 'Unexpected or repeated mock fetch');
    const after = metrics(db);
    const inheritedWhere = allowed.length ? `WHERE id NOT IN (${allowed.map(() => '?').join(',')})` : '';
    const inheritedAfter = db.prepare(`SELECT id,status,attempts,result,observation_id,actual_cost
      FROM freshness_jobs ${inheritedWhere} ORDER BY id`).all(...allowed);
    assert.deepEqual(inheritedAfter, inheritedJobRows, 'Inherited freshness jobs changed');
    const paidDelta = {
      usageRows: after.externalUsageRows - before.externalUsageRows,
      providerRecords: after.externalUsageRecords - before.externalUsageRecords,
      providerEstimatedCost: after.externalEstimatedCost - before.externalEstimatedCost,
      providerActualCost: after.externalActualCost - before.externalActualCost,
      jobEstimatedRecords: after.jobEstimatedRecords - before.jobEstimatedRecords,
      jobEstimatedCost: after.jobEstimatedCost - before.jobEstimatedCost,
      jobActualCost: after.jobActualCost - before.jobActualCost,
    };
    assert.ok(Object.values(paidDelta).every((value) => value === 0), 'Paid usage changed');
    assert.equal(after.jobs - before.jobs, allowed.length);
    assert.equal(after.attempts - before.attempts, executions.length);
    const completed = executions.filter((result) => result.status === 'completed').length;
    assert.equal(after.observations - before.observations, completed);
    assert.equal(after.availabilityChecks - before.availabilityChecks, completed);
    assertDbHealthy(db);
    assert.equal(network.getAttempts(), 0, 'A network transport was invoked');
    output = { status: 'pass', snapshot: path.relative(options.projectRoot ?? ROOT, source),
      snapshotSha256: sourceHash, sourceUnchanged: true, scratchRemoved: false,
      migrations: 'scratch only', integrity: 'ok', foreignKeyViolations: 0,
      preview: { considered: preview.considered, deferred: preview.deferred,
        eligible: preview.eligible.length, skipped: preview.skipped },
      staging: { count: allowed.length, jobIds: allowed },
      executions, mockFetcherCalls, rollbackVerified, before, after, paidDelta,
      ...(operatorReport ? { operatorReport, trafficMeasurement: 'simulated received body bytes only' } : {}),
      networkAttempts: network.getAttempts(), productionWrites: 0,
      durationMs: Date.now() - started };
  } finally {
    try { db?.close(); } finally {
      if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
      network.restore();
      assert.equal(sha256(source), sourceHash, 'Protected source snapshot was modified');
      if (output) output.scratchRemoved = scratchDir ? !fs.existsSync(scratchDir) : true;
    }
  }
  return output!;
}

async function main(argv: string[]): Promise<void> {
  assert.ok(argv.length >= 1 && argv[0] && !argv[0].startsWith('--'),
    'Usage: freshness:canary -- <protected snapshot.db> [--limit 1..25] [--execute 0..limit] [--operator]');
  const operator = argv.includes('--operator');
  const args = argv.filter((value) => value !== '--operator');
  assert.ok(args.length <= 5 && argv.filter((value) => value === '--operator').length <= 1,
    'Unexpected/duplicate operator flag');
  let limit = operator ? 3 : 10;
  let execute: number | undefined;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    assert.ok((key === '--limit' || key === '--execute') && !seen.has(key), 'Unexpected/duplicate argument');
    seen.add(key);
    assert.match(args[i + 1] ?? '', /^\d+$/, 'Expected non-negative integer');
    if (key === '--limit') limit = Number(args[i + 1]);
    else execute = Number(args[i + 1]);
  }
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort();
  if (operator) { process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); }
  // Migration diagnostics must not corrupt the operator's machine-readable JSON stdout.
  const originalLog = console.log;
  if (operator) console.log = (...message: unknown[]): void => { console.error(...message); };
  try {
    const report = await runOfflineCanary({ snapshotPath: args[0]!, limit, execute,
      ...(operator ? { operator: { signal: abortController.signal,
        onProbe: (probe: { jobId: number; latencyMs: number; receivedBytes: number; outcome: string | null }) =>
          process.stderr.write(`[OFFLINE MOCK] job=${probe.jobId} outcome=${probe.outcome} ` +
            `bodyBytes=${probe.receivedBytes} latencyMs=${probe.latencyMs.toFixed(1)}\n`),
      } } : {}) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (abortController.signal.aborted) process.exitCode = 130;
  } finally {
    console.log = originalLog;
    if (operator) { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error('Offline freshness canary FAILED:', error);
    process.exitCode = 1;
  });
}
