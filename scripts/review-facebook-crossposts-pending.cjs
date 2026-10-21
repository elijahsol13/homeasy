/**
 * One-time, source-scoped release of eight corroborated Facebook repost holds.
 * Run against a detached SQLite checkpoint first. Live writes require an
 * explicit --apply --live from the API container after a verified checkpoint.
 * No network, scraper, or AI calls. No personal/source text is printed.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { reviewDefaultPending, MODERATION_POLICY_VERSION } = require(
  path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));

const TARGETS = [8558, 8569, 8609, 8690, 8955, 8958, 8963, 13785];
const expectedPolicy = 'source-corroborated-crossposts-v7';
assert.equal(MODERATION_POLICY_VERSION, expectedPolicy, 'Deployed code does not have the v7 policy');

const dbPath = process.env.HOMEASY_CROSSPOST_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'Set HOMEASY_CROSSPOST_DB to an absolute DB path');
const apply = process.argv.includes('--apply');
const live = process.argv.includes('--live');
const prodPath = '/app/data/homeasy.db';
assert.ok(!live || (apply && path.resolve(dbPath) === prodPath), '--live is allowed only with --apply in API container');
assert.ok(!apply || path.resolve(dbPath) !== prodPath || live,
  'Live database changes require --apply --live inside the API container');
assert.ok(!apply || live || path.resolve(dbPath).startsWith('/private/tmp/')
  || path.resolve(dbPath).startsWith('/tmp/'), 'Detached --apply must target /private/tmp or /tmp');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);

function counts() {
  const statuses = Object.fromEntries(all(`SELECT review_status,COUNT(*) AS n
    FROM canonical_listing_moderation GROUP BY review_status`).map(r => [r.review_status, r.n]));
  return {
    canonical: one('SELECT COUNT(*) n FROM canonical_listings').n,
    sources: one('SELECT COUNT(*) n FROM source_items').n,
    approved: statuses.approved || 0,
    pending: statuses.pending || 0,
    rejected: statuses.rejected || 0,
  };
}

function verifyTargets(approvedAlready) {
  for (const id of TARGETS) {
    const r = one(`SELECT l.id,l.status,m.review_status,m.review_reason,
      m.decision_origin,m.decision_actor,m.policy_version,m.decision_evidence_json,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences o
        WHERE o.listing_id=l.id AND o.is_current=1) source_count
      FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
      WHERE l.id=?`, id);
    assert.ok(r, `Listing ${id} disappeared`);
    assert.equal(r.status, 'active', `${id} listing is no longer active`);
    assert.ok(r.source_count >= 2, `${id} lost a source`);
    if (approvedAlready) {
      assert.equal(r.review_status, 'approved', `${id} should already be approved`);
      assert.equal(r.policy_version, expectedPolicy, `${id} changed policy`);
      assert.equal(r.decision_origin, 'INGESTION_VALIDATED_V1');
      assert.equal(r.decision_actor, 'AUTO_POLICY');
      assert.equal(r.review_reason, null);
      const evidence = JSON.parse(r.decision_evidence_json ?? '{}');
      assert.equal(evidence.verifiedSourceItemIds?.length, r.source_count,
        `${id} source evidence count changed`);
    } else {
      assert.equal(r.review_status, 'pending', `${id} received a separate decision`);
      assert.equal(r.decision_origin, 'DEFAULT_PENDING', `${id} has a prior hold`);
      assert.equal(r.review_reason, null, `${id} has a human review reason`);
    }
  }
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = counts();
    assert.equal(before.canonical, 228, 'Canonical inventory changed; re-evaluate v7');
    assert.equal(before.sources, 1139, 'Source inventory changed; re-evaluate v7');
    assert.equal(before.rejected, 7, 'Moderation decisions changed');
    const already = before.pending === 51 && before.approved === 170;
    if (!already) {
      assert.deepEqual([before.approved, before.pending], [162, 59],
        'Pending/Approved inventory changed; re-evaluate targets');
    }
    verifyTargets(already);
    let approved = 0;
    if (!already) {
      const result = reviewDefaultPending(db, TARGETS);
      assert.deepEqual(result, { approved: TARGETS.length, held: 0 },
        'Policy did not independently verify all selected sources');
      approved = result.approved;
      verifyTargets(true);
    }
    const after = counts();
    assert.deepEqual(after, {
      ...before, approved: before.approved + approved, pending: before.pending - approved,
    }, 'Unexpected database side effect');
    assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
    assert.equal(all('PRAGMA foreign_key_check').length, 0);
    if (apply) db.exec('COMMIT');
    else db.exec('ROLLBACK');
    console.log(JSON.stringify({policy: expectedPolicy,mode:apply ? 'applied' : 'rehearsal-rolled-back',
      before,expectedAfter:after,alreadyApplied:already,approved:apply && !already ? TARGETS : [],
      eligible:already ? [] : TARGETS,integrity:'ok',foreignKeyViolations:0}));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
} finally { db.close(); }
