/**
 * Narrow, source-backed v12 reevaluation of listing 100.
 * Default mode is a transaction rehearsal that always rolls back. A production
 * change requires --apply --live and the exact API-container database path.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  MODERATION_POLICY_VERSION,
  reviewDefaultPending,
} = require(path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));

const dbPath = process.env.HOMEASY_V12_REVIEW_DB;
const apply = process.argv.includes('--apply');
const live = process.argv.includes('--live');
const rehearse = process.argv.includes('--rehearse') || !apply;
const productionPath = '/app/data/homeasy.db';
const expectedCounts = { approved: 180, pending: 45, rejected: 7 };

assert.equal(MODERATION_POLICY_VERSION, 'source-corroborated-crossposts-v12');
assert.ok(dbPath && path.isAbsolute(dbPath), 'Set HOMEASY_V12_REVIEW_DB to an absolute database path');
assert.ok(!live || (apply && path.resolve(dbPath) === productionPath),
  '--live requires --apply against /app/data/homeasy.db');
assert.ok(path.resolve(dbPath) !== productionPath || (apply && live),
  'Any production transaction requires --apply --live inside the API container');
assert.ok(!apply || path.resolve(dbPath) !== productionPath || live,
  'Production writes require --apply --live inside the API container');
assert.ok(!apply || live || path.resolve(dbPath).startsWith('/private/tmp/')
  || path.resolve(dbPath).startsWith('/tmp/'), 'Detached apply must use /private/tmp or /tmp');
assert.ok(!(apply && rehearse), 'Choose either --rehearse or --apply');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);

function counts() {
  const values = all(`SELECT review_status,COUNT(*) n FROM canonical_listing_moderation GROUP BY review_status`);
  return Object.fromEntries(['approved', 'pending', 'rejected'].map(status => [
    status, values.find(row => row.review_status === status)?.n ?? 0,
  ]));
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = counts();
    assert.deepEqual(before, expectedCounts, 'Production moderation baseline changed; stop and re-audit');

    const row = one(`SELECT l.id,l.status,l.city,l.price,m.review_status,m.decision_origin,m.review_reason,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences o WHERE o.listing_id=l.id AND o.is_current=1) current_sources,
      (SELECT COUNT(*) FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') aliases
      FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id WHERE l.id=100`);
    assert.ok(row, 'Listing 100 disappeared');
    assert.equal(row.status, 'active');
    assert.equal(row.city, 'siem_reap');
    assert.equal(row.price, 45000);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.decision_origin, 'INGESTION_VALIDATED_V1');
    assert.match(row.review_reason ?? '', /^INGESTION_VALIDATED_V1: held for manual review \(/);
    assert.equal(row.current_sources, 6);
    assert.equal(row.aliases, 0);

    const sources = all(`SELECT o.id occurrence_id,o.source_item_id,o.group_name,s.source_type,
      COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,s.raw_text,s.raw_payload_json
      FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
      WHERE o.listing_id=100 AND o.is_current=1 ORDER BY o.id`);
    assert.equal(sources.length, 6);
    assert.ok(sources.some(source => /\b(?:rent|rental|lease)\b|ជួល/i.test(source.group_name ?? '')),
      'A current rent-context Facebook group no longer corroborates the post');
    assert.ok(sources.every(source => source.source_type === 'FACEBOOK_GROUP'
      && source.source_url?.startsWith('https://') && source.raw_text?.trim()),
    'A current original source is missing or changed');

    const review = reviewDefaultPending(db, [100]);
    assert.deepEqual(review, { approved: 1, held: 0 }, 'v12 did not approve only the verified target');
    const decided = one(`SELECT review_status,decision_origin,policy_version,decision_actor,decision_evidence_json
      FROM canonical_listing_moderation WHERE listing_id=100`);
    assert.equal(decided.review_status, 'approved');
    assert.equal(decided.decision_origin, 'INGESTION_VALIDATED_V1');
    assert.equal(decided.policy_version, MODERATION_POLICY_VERSION);
    assert.equal(decided.decision_actor, 'AUTO_POLICY');
    const evidence = JSON.parse(decided.decision_evidence_json);
    assert.deepEqual(evidence.verifiedSourceItemIds, sources.map(source => source.source_item_id));
    assert.ok(evidence.checks.includes('monthly_price') && evidence.checks.includes('rent_offer'));

    const after = counts();
    assert.deepEqual(after, { approved: 181, pending: 44, rejected: 7 });
    assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
    assert.equal(all('PRAGMA foreign_key_check').length, 0);

    if (apply) db.exec('COMMIT');
    else db.exec('ROLLBACK');

    if (!apply) {
      assert.deepEqual(counts(), before, 'The detached rehearsal failed to roll back');
      assert.equal(one(`SELECT review_status FROM canonical_listing_moderation WHERE listing_id=100`).review_status,
        'pending', 'The detached rehearsal left listing 100 changed');
    }
    console.log(JSON.stringify({ policy: MODERATION_POLICY_VERSION, mode: apply ? 'applied' : 'rehearsed-and-rolled-back',
      listingId: 100, reviewedSources: sources.map(source => source.source_item_id), before, expectedAfter: after,
      integrity: 'ok', foreignKeyViolations: 0 }));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
} finally {
  db.close();
}
