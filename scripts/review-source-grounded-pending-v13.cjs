/**
 * Release only the source-verified v13 Pending candidates from the production audit.
 * Rehearsal uses --rehearse against a detached backup; production requires --apply --live.
 * Neither mode runs scraping, AI, or source ingestion.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MODERATION_POLICY_VERSION, reviewDefaultPending } = require(
  '/app/dist/modules/parser/canonical-moderation-policy.js');

const IDS = Object.freeze([
  8964, 8995, 16523, 16529, 16531, 16532, 16534, 16537, 16540, 16551,
  16555, 16559, 16563, 16574, 16578, 16580, 16597, 16598, 16599, 16601,
  16606, 16611, 16623, 16625, 16626, 16628, 16630, 16631, 16641, 16647,
  16648, 16651, 16657, 16658, 16676, 16680, 16693, 16702, 16709, 16721,
]);

assert.equal(MODERATION_POLICY_VERSION, 'source-corroborated-crossposts-v13');
assert.equal(new Set(IDS).size, IDS.length);
const apply = process.argv.includes('--apply');
const rehearse = process.argv.includes('--rehearse');
const live = process.argv.includes('--live');
assert.ok(apply !== rehearse, 'Select either --rehearse or --apply');
assert.ok(!live || apply, '--live requires --apply');
const dbPath = process.env.HOMEASY_MODERATION_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'HOMEASY_MODERATION_DB must be an absolute path');
const prodPath = '/app/data/homeasy.db';
assert.ok(!live || path.resolve(dbPath) === prodPath, '--live requires the production database path');
assert.ok(path.resolve(dbPath) !== prodPath || live, 'Production changes require --apply --live');
assert.ok(live || path.resolve(dbPath).startsWith('/app/data/manual-moderation-backup-v13-'),
  'Rehearsal must use an isolated named backup');
if (live) {
  const backup = process.env.HOMEASY_MODERATION_BACKUP;
  assert.ok(backup && fs.existsSync(backup) && fs.statSync(backup).size > 0,
    'A verified pre-change database backup is required');
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=20000');
const counts = () => Object.fromEntries(db.prepare(
  'SELECT review_status,COUNT(*) n FROM canonical_listing_moderation GROUP BY review_status')
  .all().map(row => [row.review_status, row.n]));
const statuses = () => db.prepare(`SELECT listing_id,review_status,decision_origin,review_reason,
  policy_version FROM canonical_listing_moderation WHERE listing_id IN (${IDS.map(() => '?').join(',')})
  ORDER BY listing_id`).all(...IDS);

try {
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = counts();
    assert.deepEqual(before, { approved: 285, pending: 178, rejected: 7 },
      'The observed production moderation baseline changed: re-audit before modifying');
    const prior = statuses();
    assert.equal(prior.length, IDS.length);
    for (const r of prior) {
      assert.equal(r.review_status, 'pending', `Candidate ${r.listing_id} no longer Pending`);
      assert.ok(r.decision_origin === 'DEFAULT_PENDING'
        || (r.decision_origin === 'INGESTION_VALIDATED_V1'
          && /^INGESTION_VALIDATED_V1: held for manual review \(/.test(r.review_reason || '')),
      `Candidate ${r.listing_id} has an explicit/manual review hold`);
    }

    const result = reviewDefaultPending(db, IDS);
    assert.deepEqual(result, { approved: IDS.length, held: 0 },
      'The source-backed policy did not clear exactly the audited IDs');
    const after = statuses();
    for (const row of after) {
      assert.equal(row.review_status, 'approved', `Candidate ${row.listing_id} not approved`);
      assert.equal(row.policy_version, MODERATION_POLICY_VERSION);
    }
    const totals = counts();
    assert.deepEqual(totals, { approved: 325, pending: 138, rejected: 7 },
      'Unexpected change in moderation totals');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.exec(apply ? 'COMMIT' : 'ROLLBACK');
    if (!apply) assert.deepEqual(counts(), before, 'Rehearsal did not roll back');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'rehearsed-and-rolled-back',
      policy: MODERATION_POLICY_VERSION, changedListingIds: IDS, before, expectedAfter: totals,
      integrity: 'ok', foreignKeyViolations: 0 }, null, 2));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
} finally { db.close(); }
