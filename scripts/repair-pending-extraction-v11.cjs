/**
 * Source-backed correction for five legacy extraction holds reviewed on 2026-10-20.
 * Rehearse on a detached SQLite copy first. Live writes require --apply --live
 * from the API container after a protected VACUUM INTO checkpoint.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { evaluateCorroboratedCrossposts, evaluateModerationCandidate,
  MODERATION_POLICY_VERSION, reviewDefaultPending } = require(
  path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));
const { sanitizeListingFacts } = require(
  path.join(process.cwd(), 'dist/modules/parser/listing-extraction.js'));
const { sourceRoomCounts } = require(
  path.join(process.cwd(), 'dist/modules/parser/source-room-counts.js'));
const { sourceMonthlyPrices } = require(
  path.join(process.cwd(), 'dist/modules/parser/source-price.js'));

const expectedPolicy = 'source-corroborated-crossposts-v11';
const TARGETS = new Map([
  [60, { sourceCount: 1, price: 300, bedrooms: null, bathrooms: null }],
  [110, { sourceCount: 4, price: 450, bedrooms: 2, bathrooms: 2 }],
  [138, { sourceCount: 4, price: 380, bedrooms: 2, bathrooms: 3 }],
  [250, { sourceCount: 4, price: 600, bedrooms: 2, bathrooms: 2 }],
  [412, { sourceCount: 6, price: 550, bedrooms: 2, bathrooms: 2 }],
]);

assert.equal(MODERATION_POLICY_VERSION, expectedPolicy,
  'Expected v11 policy in the compiled runtime');
const dbPath = process.env.HOMEASY_EXTRACTION_REPAIR_DB;
assert.ok(dbPath && path.isAbsolute(dbPath),
  'Set HOMEASY_EXTRACTION_REPAIR_DB to an absolute SQLite path');
const apply = process.argv.includes('--apply');
const live = process.argv.includes('--live');
const productionPath = '/app/data/homeasy.db';
assert.ok(!live || (apply && path.resolve(dbPath) === productionPath),
  '--live requires --apply against /app/data/homeasy.db');
assert.ok(!apply || path.resolve(dbPath) !== productionPath || live,
  'Live database changes require --apply --live inside the API container');
assert.ok(!apply || live || path.resolve(dbPath).startsWith('/private/tmp/')
  || path.resolve(dbPath).startsWith('/tmp/'),
  'Detached apply must target /private/tmp or /tmp');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);

function counts() {
  const statuses = Object.fromEntries(all(`SELECT review_status,COUNT(*) n
    FROM canonical_listing_moderation GROUP BY review_status`)
    .map((row) => [row.review_status, row.n]));
  return { approved: statuses.approved || 0, pending: statuses.pending || 0,
    rejected: statuses.rejected || 0 };
}

function factsFor(row, sources) {
  const sourceFacts = sources.map((source) => {
    let payload = {};
    try { payload = JSON.parse(source.raw_payload_json ?? '{}'); } catch { /* evaluator holds malformed payloads */ }
    const listing = payload.listing ?? payload.listingFacts ?? payload.listingExtraction ?? {};
    const sourceTitle = typeof listing.source_title === 'string' ? listing.source_title : '';
    const raw = `${sourceTitle}\n${source.raw_text ?? ''}`;
    return { source, listing, raw, rooms: sourceRoomCounts(raw), prices: sourceMonthlyPrices(source.raw_text ?? '') };
  });
  return sourceFacts;
}

function verifySourceEvidence(row, expected, sources) {
  assert.equal(row.status, 'active', `Listing ${row.id} is not active`);
  assert.equal(row.review_status, 'pending', `Listing ${row.id} is no longer Pending`);
  assert.equal(row.decision_origin, 'INGESTION_VALIDATED_V1', `Listing ${row.id} has a non-system decision`);
  assert.match(row.review_reason ?? '', /^INGESTION_VALIDATED_V1: held for manual review \(/,
    `Listing ${row.id} has a human or unrecognized review reason`);
  assert.equal(row.alias_count, 0, `Listing ${row.id} has a legacy identity alias`);
  assert.equal(sources.length, expected.sourceCount, `Listing ${row.id} source count changed`);
  const facts = factsFor(row, sources);
  for (const fact of facts) {
    assert.equal(fact.source.source_type, 'FACEBOOK_GROUP', `Listing ${row.id} changed source type`);
    assert.ok(fact.source.source_url?.startsWith('https://'), `Listing ${row.id} has an unverified source URL`);
    assert.ok(fact.source.raw_text?.trim(), `Listing ${row.id} has no retained source text`);
    assert.deepEqual(fact.prices, [expected.price], `Listing ${row.id} source rent changed or conflicts`);
    assert.equal(fact.rooms.conflictingBedrooms, false, `Listing ${row.id} has conflicting source bedrooms`);
    assert.equal(fact.rooms.conflictingBathrooms, false, `Listing ${row.id} has conflicting source bathrooms`);
    assert.equal(fact.rooms.bedrooms, expected.bedrooms, `Listing ${row.id} source bedrooms changed`);
    assert.equal(fact.rooms.bathrooms, expected.bathrooms, `Listing ${row.id} source bathrooms changed`);
  }
  assert.equal(row.price, expected.price * 100, `Listing ${row.id} canonical rent changed`);
  return facts;
}

function listingRow(id) {
  return one(`SELECT l.id,l.status,l.title,l.description,l.price,l.bedrooms,l.bathrooms,
      m.review_status,m.review_reason,m.decision_origin,m.policy_version,
      (SELECT COUNT(*) FROM canonical_listing_aliases a
        WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') alias_count
    FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
    WHERE l.id=?`, id);
}

function currentSources(id) {
  return all(`SELECT o.id occurrence_id,o.source_item_id,COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,s.source_type,
      s.raw_text,s.raw_payload_json
    FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
    WHERE o.listing_id=? AND o.is_current=1 ORDER BY o.id`, id);
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = counts();
    const prepared = [];
    for (const [id, expected] of TARGETS) {
      const row = listingRow(id);
      assert.ok(row, `Listing ${id} disappeared`);
      const sources = currentSources(id);
      const evidence = verifySourceEvidence(row, expected, sources);
      const primary = evidence.find((item) => item.source.occurrence_id === one(
        'SELECT primary_source_occurrence_id FROM canonical_listings WHERE id=?', id,
      ).primary_source_occurrence_id);
      assert.ok(primary, `Listing ${id} primary source changed`);
      const sanitized = sanitizeListingFacts({ title_en: row.title, description_en: row.description }, primary.raw);
      assert.ok(sanitized, `Listing ${id} title could not be sanitized`);
      const title = sanitized.title_en || row.title;
      const canonicalRooms = sourceRoomCounts(`${title}\n${row.description}`);
      if (expected.bedrooms === null) {
        assert.equal(canonicalRooms.bedrooms, null, `Listing ${id} retains an unsupported title/description bedroom claim`);
      } else {
        assert.equal(canonicalRooms.bedrooms, expected.bedrooms, `Listing ${id} title/description room claim was not corrected`);
      }
      prepared.push({ id, expected, row, sources, title });
    }

    const update = db.prepare(`UPDATE canonical_listings SET title=?,bedrooms=?,bathrooms=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='active'`);
    for (const item of prepared) {
      const result = update.run(item.title, item.expected.bedrooms, item.expected.bathrooms, item.id);
      assert.equal(result.changes, 1, `Listing ${item.id} changed during the repair`);
    }

    const review = reviewDefaultPending(db, [...TARGETS.keys()]);
    assert.deepEqual(review, { approved: TARGETS.size, held: 0 },
      'The v11 policy did not independently verify every source-corrected listing');
    for (const item of prepared) {
      const after = listingRow(item.id);
      assert.equal(after.review_status, 'approved', `Listing ${item.id} was not approved by v11`);
      assert.equal(after.decision_origin, 'INGESTION_VALIDATED_V1');
      assert.equal(after.policy_version, expectedPolicy);
    }
    const afterCounts = counts();
    assert.deepEqual(afterCounts, { ...before,
      approved: before.approved + TARGETS.size, pending: before.pending - TARGETS.size,
    }, 'Unexpected moderation-count change');
    assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
    assert.equal(all('PRAGMA foreign_key_check').length, 0);
    if (apply) db.exec('COMMIT'); else db.exec('ROLLBACK');
    console.log(JSON.stringify({ policy: expectedPolicy, mode: apply ? 'applied' : 'rolled-back',
      before, expectedAfter: afterCounts,
      corrected: prepared.map(({ id, expected, row, title }) => ({ id,
        price: row.price / 100, from: [row.bedrooms, row.bathrooms],
        to: [expected.bedrooms, expected.bathrooms], titleChanged: title !== row.title,
      })), approved: apply ? [...TARGETS.keys()] : [], integrity: 'ok', foreignKeyViolations: 0 }));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
} finally {
  db.close();
}
