/**
 * Detached SQLite WAL crash/rollback rehearsal using a protected backup.
 * All mutable files live in a NEW OS temp directory. Never operates on the
 * production database, Compose volumes, or existing account state.
 *
 * Usage: npx ts-node scripts/recovery-wal-rollback-rehearsal.ts \
 *   data/backups/verified-checkpoints/<snapshot>.db \
 *   [--docker] [--report reports/<new-report>.json]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type SnapshotMetrics = { integrity: string; foreignKeyViolations: number; tables: number; counts: Record<string, number> };

function sha256(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const block = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes: number;
    while ((bytes = fs.readSync(fd, block, 0, block.length, null)) > 0) hash.update(block.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function metrics(db: DatabaseSync): SnapshotMetrics {
  const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((row) => row.name);
  const counts: Record<string, number> = {};
  for (const table of ['users', 'properties', 'source_items', 'canonical_listings']) {
    if (names.includes(table)) {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    }
  }
  return { integrity, foreignKeyViolations, tables: names.length, counts };
}

const suffixes = ['', '-wal', '-shm'] as const;
const markerTable = '__homeasy_wal_incident_probe';

function copyTriplet(from: string, to: string): void {
  for (const suffix of suffixes) {
    assert.ok(fs.existsSync(from + suffix), `Missing pre-restore artifact: ${suffix || '.db'}`);
    fs.copyFileSync(from + suffix, to + suffix, fs.constants.COPYFILE_EXCL);
  }
}

const dockerProbe = String.raw`
set -eu
mode="$1"
cp /recovery/source.db /tmp/restored.db
node dist/api.js > /tmp/restored-api.log 2>&1 &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true' EXIT INT TERM
if ! node -e '
const assert = require("node:assert/strict");
const mode = process.argv[1];
const base = "http://127.0.0.1:37999";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(endpoint, status = 200) {
  const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, status, endpoint + ": unexpected HTTP status " + response.status);
  return response.json();
}
(async () => {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await get("/health")).status === "ok") { ready = true; break; } }
    catch { await sleep(250); }
  }
  assert.ok(ready, "Restored API did not become ready");
  const list = await get("/api/v1/properties?limit=5");
  assert.ok(list.total > 0 && list.items.length > 0);
  const first = list.items[0];
  const id = mode === "canonical" ? first.publicRef : String(first.id);
  const detail = await get("/api/v1/properties/" + id);
  assert.equal(detail.id, first.id);
  const map = await get("/api/v1/properties/map");
  assert.equal(map.count, map.markers.length);
  await get("/api/v1/properties/invalid-id", 400);
  await get("/api/v1/properties/lst_00000000000000000000000000000000", 404);
  console.log(JSON.stringify({ mode, status: "pass", total: list.total, map: map.count, detail: "ok" }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
' "$mode"; then
  cat /tmp/restored-api.log >&2
  exit 1
fi
`;

function checkDocker(restored: string, image: string): Record<string, unknown>[] {
  const checks: Record<string, unknown>[] = [];
  for (const mode of ['legacy', 'canonical']) {
    const args = [
      'run', '--rm', '--interactive', '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,size=192m', '--memory', '350m', '--pids-limit', '100',
      '--volume', `${restored}:/recovery/source.db:ro`,
      '--env', 'BOT_TOKEN=1234567890:OfflineRestorationDummyTokenOnly',
      '--env', 'BOT_DELIVERY_MODE=polling', '--env', 'CANONICAL_ALERTS_ENABLED=false',
      '--env', 'CANONICAL_READ_CANARY_TELEGRAM_IDS=', '--env', 'SHADOW_INGESTION=false',
      '--env', 'LISTING_READ_SHADOW=false', '--env', `LISTING_READ_PATH=${mode}`,
      '--env', 'POSTHOG_API_KEY=', '--env', 'NODE_ENV=test',
      '--env', 'DATABASE_PATH=/tmp/restored.db', '--env', 'API_HOST=127.0.0.1',
      '--env', 'API_PORT=37999', '--entrypoint', '/bin/sh', image, '-s', '--', mode,
    ];
    const run = spawnSync('docker', args, { input: dockerProbe, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`Detached Docker ${mode} API failed (exit ${run.status}): ${run.error?.message ?? run.stderr ?? run.stdout}`);
    const record = run.stdout.split('\n').find((line) => line.includes('"status":"pass"'));
    assert.ok(record, `No Docker ${mode} success response: ${run.stdout}`);
    checks.push(JSON.parse(record) as Record<string, unknown>);
  }
  return checks;
}

/** Keep the scratch directory as operator-inspectable incident evidence. */
export function rehearseWalRollback(source: string, docker = false, image = 'homeasy-backup') {
  const sourceHash = sha256(source);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-wal-rehearsal-'));
  const active = path.join(scratch, 'active.db');
  const incident = path.join(scratch, 'incident');
  const replay = path.join(scratch, 'wal-replay');
  const volume = path.join(scratch, 'simulated-volume');
  const preserved = path.join(scratch, 'preserved-before-rollback');
  for (const dir of [incident, replay, volume, preserved]) fs.mkdirSync(dir);
  const incidentBase = path.join(incident, 'database.db');
  const replayBase = path.join(replay, 'database.db');
  const volumeBase = path.join(volume, 'database.db');
  const savedBase = path.join(preserved, 'database.db');

  fs.copyFileSync(source, active, fs.constants.COPYFILE_EXCL);
  assert.equal(sha256(active), sourceHash);
  const writer = new DatabaseSync(active);
  let incidentSizes: Record<string, number> = {};
  let replayMetrics: SnapshotMetrics;
  let baseline: SnapshotMetrics;
  try {
    baseline = metrics(writer);
    assert.equal(baseline.integrity, 'ok');
    assert.equal(baseline.foreignKeyViolations, 0);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0;');
    // A TRUNCATE checkpoint can itself acquire a table lock under node:sqlite;
    // no checkpoint is needed because this is a fresh, isolated snapshot copy.
    // All writes are committed but intentionally remain in the WAL while this
    // connection stays open. No network, production DB or application table is used.
    assert.ok(!writer.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(markerTable), 'Unexpected fixture marker collision');
    writer.exec(`BEGIN IMMEDIATE; CREATE TABLE ${markerTable} (value TEXT NOT NULL); INSERT INTO ${markerTable} VALUES ('committed-in-wal'); COMMIT;`);
    const walBytes = fs.statSync(active + '-wal').size;
    assert.ok(walBytes > 32, 'Expected committed uncheckpointed WAL frames');
    assert.ok(fs.statSync(active + '-shm').size > 0, 'Expected WAL shared-memory index');

    copyTriplet(active, incidentBase);
    for (const suffix of suffixes) incidentSizes[suffix || '.db'] = fs.statSync(incidentBase + suffix).size;
    // Stronger than WAL size alone: a copy of the main file without its WAL
    // cannot see the committed mutation, while the preserved triplet can.
    const mainOnlyPath = path.join(scratch, 'main-file-without-wal.db');
    fs.copyFileSync(active, mainOnlyPath, fs.constants.COPYFILE_EXCL);
    const mainOnly = new DatabaseSync(mainOnlyPath);
    try {
      assert.ok(!mainOnly.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(markerTable),
        'Mutation was checkpointed into the main file; WAL rehearsal invalid');
    } finally {
      mainOnly.close();
    }
    copyTriplet(incidentBase, replayBase);
    const replayReader = new DatabaseSync(replayBase);
    try {
      const marker = replayReader.prepare(`SELECT value FROM ${markerTable}`).get() as { value: string } | undefined;
      assert.equal(marker?.value, 'committed-in-wal', 'Committed WAL change did not survive triplet replay');
      replayMetrics = metrics(replayReader);
      assert.equal(replayMetrics.integrity, 'ok');
      assert.equal(replayMetrics.foreignKeyViolations, 0);
      assert.deepEqual(replayMetrics.counts, baseline.counts);
    } finally {
      replayReader.close();
    }
  } finally {
    writer.close();
  }

  // Simulate a stopped Compose volume. Move its complete pre-restore triplet
  // into a different incident location *before* installing the backup. Old
  // WAL/SHM are deliberately never carried into the restored SQLite path.
  copyTriplet(incidentBase, volumeBase);
  const incidentHashes: Record<string, string> = {};
  for (const suffix of suffixes) {
    incidentHashes[suffix || '.db'] = sha256(incidentBase + suffix);
    fs.renameSync(volumeBase + suffix, savedBase + suffix);
    assert.equal(sha256(savedBase + suffix), incidentHashes[suffix || '.db']);
    assert.ok(!fs.existsSync(volumeBase + suffix));
  }
  fs.copyFileSync(source, volumeBase, fs.constants.COPYFILE_EXCL);
  assert.equal(sha256(volumeBase), sourceHash);
  assert.ok(!fs.existsSync(volumeBase + '-wal') && !fs.existsSync(volumeBase + '-shm'));

  const restored = new DatabaseSync(volumeBase);
  let restoredMetrics: SnapshotMetrics;
  try {
    restoredMetrics = metrics(restored);
    assert.deepEqual(restoredMetrics, baseline, 'Restored schema/counts or integrity differ from snapshot');
    assert.ok(!restored.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(markerTable), 'Stale WAL marker leaked into restore');
    restored.exec('BEGIN; CREATE TABLE __homeasy_restore_write_probe (value TEXT); INSERT INTO __homeasy_restore_write_probe VALUES (\'write-ok\'); COMMIT;');
    assert.equal((restored.prepare('SELECT value FROM __homeasy_restore_write_probe').get() as { value: string }).value, 'write-ok');
    restored.exec('DROP TABLE __homeasy_restore_write_probe');
  } finally {
    restored.close();
  }
  assert.ok(!fs.existsSync(volumeBase + '-wal') && !fs.existsSync(volumeBase + '-shm'), 'Restore must be checkpointed before mounting into Docker');
  const restoredHash = sha256(volumeBase);
  const dockerChecks = docker ? checkDocker(volumeBase, image) : [];
  assert.equal(sha256(volumeBase), restoredHash, 'Docker probe unexpectedly modified restored source');
  assert.equal(sha256(source), sourceHash, 'Protected checkpoint was modified');

  return {
    status: 'pass', source: path.relative(process.cwd(), source), sourceHash,
    scratch, incidentTriplet: incidentSizes, incidentHashes, walReplay: {
      mainFileAloneExcludesCommittedMutation: true, committedMutationVisible: true,
      integrity: replayMetrics!.integrity,
      foreignKeyViolations: replayMetrics!.foreignKeyViolations,
    },
    restore: { protectedTripletBeforeOverwrite: true, staleWalShmExcluded: true,
      incidentMutationAbsent: true, writable: true, integrity: restoredMetrics.integrity,
      foreignKeyViolations: restoredMetrics.foreignKeyViolations, counts: restoredMetrics.counts },
    docker: docker ? { network: 'none', realListeningApi: true, checks: dockerChecks } : { executed: false },
    productionDbAccess: false, productionComposeActions: 0, remoteRequests: 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assert.ok(args.length > 0 && args.length <= 4, 'Usage: <protected checkpoint.db> [--docker] [--report reports/<new-name>.json]');
  assert.ok(args.filter((a) => a === '--docker').length <= 1);
  const docker = args.includes('--docker');
  const reportIndex = args.indexOf('--report');
  const report = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
  if (reportIndex >= 0) assert.ok(report && reportIndex === args.length - 2, '--report requires the final path');
  const sourceArg = args[0]!;
  assert.ok(!sourceArg.startsWith('--'), 'First argument must be checkpoint');
  const expected = fs.realpathSync(path.resolve('data/backups/verified-checkpoints'));
  assert.ok(!fs.lstatSync(sourceArg).isSymbolicLink(), 'Symbolic link checkpoint rejected');
  const source = fs.realpathSync(sourceArg);
  assert.equal(path.dirname(source), expected, 'Only protected checkpoints can be used as recovery sources');
  assert.match(source, /\.db$/);
  const out = report ? path.resolve(report) : undefined;
  if (out) {
    assert.equal(path.dirname(out), path.resolve('reports'), 'Report path must be in reports/');
    assert.ok(!fs.existsSync(out), 'Refusing to overwrite a report');
  }
  const result = rehearseWalRollback(source, docker);
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((error) => { console.error('Detached WAL rollback FAILED:', error); process.exitCode = 1; });
