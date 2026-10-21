/**
 * Offline API recovery rehearsal against a protected, consistent SQLite backup.
 * Usage: npm run recovery:api-smoke -- data/backups/verified-checkpoints/<snapshot>.db
 * Never opens the production database, listens on a port, or calls remote APIs.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sha256(filename: string): string {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function main(): Promise<void> {
  assert.ok(process.argv.length === 3 || (process.argv.length === 5 && process.argv[3] === '--report'),
    'Usage: <protected snapshot.db> [--report reports/restore-smoke.json]');
  const source = fs.realpathSync(process.argv[2]!);
  const checkpoints = fs.realpathSync(path.resolve('data/backups/verified-checkpoints'));
  assert.equal(path.dirname(source), checkpoints, 'Snapshot must be in verified-checkpoints/');
  assert.match(source, /\.db$/, 'Snapshot must be a SQLite .db file');
  assert.ok(fs.statSync(source).size > 4096, 'Snapshot must not be empty');
  const sourceHash = sha256(source);
  const reportPath = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
  if (reportPath) {
    assert.equal(path.dirname(reportPath), path.resolve('reports'), 'Reports must stay in reports/');
    assert.notEqual(reportPath, source);
  }

  // Config is imported only after overriding sensitive/production settings.
  process.env.BOT_TOKEN = '1234567890:OfflineRestorationDummyTokenOnly';
  process.env.BOT_DELIVERY_MODE = 'polling';
  process.env.CANONICAL_ALERTS_ENABLED = 'false';
  process.env.CANONICAL_READ_CANARY_TELEGRAM_IDS = '';
  process.env.LISTING_READ_SHADOW = 'false';
  process.env.SHADOW_INGESTION = 'false';
  process.env.LISTING_READ_PATH = 'legacy';
  process.env.NODE_ENV = 'test';

  const [{ env }, { createDatabase }, { runMigrations }, { createContainer }, { buildApiServer }] = await Promise.all([
    import('../src/config/env'),
    import('../src/database/db'),
    import('../src/database/migrate'),
    import('../src/container'),
    import('../src/modules/api/server'),
  ]);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-api-restore-'));
  const restored = path.join(tempDir, 'restored.db');
  let db: ReturnType<typeof createDatabase> | undefined;
  let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;
  try {
    fs.copyFileSync(source, restored, fs.constants.COPYFILE_EXCL);
    assert.equal(sha256(restored), sourceHash, 'Detached copy mismatch');
    db = createDatabase(restored);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    runMigrations(db); // Only the disposable copy may be migrated.
    db.exec('CREATE TABLE temp.recovery_probe (value TEXT NOT NULL)');
    db.prepare('INSERT INTO temp.recovery_probe (value) VALUES (?)').run('write-ok');
    assert.equal(db.prepare('SELECT value FROM temp.recovery_probe').get()?.value, 'write-ok');
    db.exec('DROP TABLE temp.recovery_probe');

    const container = createContainer({ db });
    app = await buildApiServer({ container, logger: false });
    await app.ready();

    const get = async (url: string, status = 200, headers?: Record<string, string>) => {
      const response = await app!.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, status, `${url}: ${response.body.slice(0, 300)}`);
      return response.json() as Record<string, any>;
    };

    const health = await get('/health');
    assert.equal(health.status, 'ok');
    assert.ok(health.stats.properties > 0);

    const checks = [];
    let canonicalRef = '';
    for (const mode of ['legacy', 'canonical'] as const) {
      env.LISTING_READ_PATH = mode;
      const listing = await get('/api/v1/properties?limit=20');
      assert.ok(listing.total > 0 && listing.items.length > 0, `${mode}: empty catalog`);
      const first = listing.items[0];
      const detailId = mode === 'canonical' ? first.publicRef : String(first.id);
      if (mode === 'canonical') {
        assert.match(detailId, /^lst_[a-f0-9]{32}$/);
        canonicalRef = detailId;
      }
      const detail = await get(`/api/v1/properties/${detailId}`);
      assert.equal(detail.id, first.id);
      assert.equal(detail.title, first.title);
      const map = await get('/api/v1/properties/map');
      assert.equal(map.count, map.markers.length);
      const filters = await get('/api/v1/filters/metadata');
      assert.equal(filters.currentCity, 'siem_reap');
      assert.ok(Array.isArray(filters.categories) && Array.isArray(filters.locations));
      const sorted = await get('/api/v1/properties?sort=price_asc&limit=10');
      assert.ok(sorted.items.length > 0);
      await get('/api/v1/properties/invalid-id', 400);
      await get('/api/v1/properties/lst_00000000000000000000000000000000', 404);
      checks.push({ mode, total: listing.total, pageItems: listing.items.length,
        firstId: mode === 'canonical' ? first.publicRef : first.id,
        mapMarkers: map.count, locations: filters.locations.length, sortedItems: sorted.items.length,
        detail: 'ok', invalidId: 400, missingPublicRef: 404 });
    }
    env.LISTING_READ_PATH = 'legacy';
    await get(`/api/v1/properties/${canonicalRef}`, 404); // No cross-namespace leak.

    // Verify production-style signed Telegram identity and a one-user canary.
    // Both identities are disposable test IDs; they only exist in the restored copy.
    const canaryId = 900000001;
    const controlId = 900000002;
    const signedHeaders = (id: number): Record<string, string> => {
      const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id, first_name: 'RestoreSmoke' }) });
      const sorted = [...p.keys()].sort().map((key) => `${key}=${p.get(key)}`).join('\n');
      const key = createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
      p.set('hash', createHmac('sha256', key).update(sorted).digest('hex'));
      return { authorization: `tma ${p.toString()}` };
    };
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];
    const canaryHeaders = signedHeaders(canaryId);
    const controlHeaders = signedHeaders(controlId);
    assert.equal((await get('/api/v1/me', 200, canaryHeaders)).authenticated, true);
    assert.equal((await get('/api/v1/properties', 200, canaryHeaders)).total, checks[1]!.total);
    assert.equal((await get('/api/v1/properties', 200, controlHeaders)).total, checks[0]!.total);
    assert.equal((await get('/api/v1/properties', 200)).total, checks[0]!.total);
    assert.equal((await get('/api/v1/favorites', 200, canaryHeaders)).total, 0);

    const toggle = async (payload: Record<string, unknown>, status = 200) => {
      const response = await app!.inject({ method: 'POST', url: '/api/v1/favorites/toggle',
        headers: canaryHeaders, payload });
      assert.equal(response.statusCode, status, `toggle: ${response.body.slice(0, 300)}`);
      return response.json() as Record<string, any>;
    };
    await toggle({ propertyId: 390 }, 400); // Canary must use opaque references.
    assert.equal((await toggle({ publicRef: canonicalRef })).isFavorite, true);
    const saved = await get('/api/v1/favorites', 200, canaryHeaders);
    assert.ok(saved.items.some((item: { publicRef?: string }) => item.publicRef === canonicalRef));
    assert.equal((await toggle({ publicRef: canonicalRef })).isFavorite, false);
    assert.equal((await get('/api/v1/favorites', 200, canaryHeaders)).total, 0);
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
    assert.equal((await get('/api/v1/properties', 200, canaryHeaders)).total, checks[0]!.total);
    assert.equal((await get('/api/v1/favorites', 200, canaryHeaders)).total, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

    const result = { status: 'pass', snapshot: path.relative(process.cwd(), source),
      snapshotSha256: sourceHash, health: health.stats, checks,
      canonicalRefInLegacy: 404, scratchRestore: 'write-ok',
      signedCanary: { catalog: 'canonical', control: 'legacy', anonymous: 'legacy',
        favoriteAddReadRemove: 'pass', numericIdRejected: 400, fallbackAfterDisable: 'legacy' },
      remoteRequestsInvoked: 0, productionWrites: 0 };
    if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (app) await app.close();
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.equal(sha256(source), sourceHash, 'Protected source snapshot was modified');
  }
}

main().catch((error: unknown) => {
  console.error('Offline API recovery smoke FAILED:', error);
  process.exitCode = 1;
});
