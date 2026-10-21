/**
 * Source-backed room-fact cleanup for legacy Pending records reviewed 2026-10-20.
 * Rehearse on a detached SQLite copy first. This script never changes review status.
 * Live writes require --apply --live from the API container after a fresh checkpoint.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { evaluateCorroboratedCrossposts, MODERATION_POLICY_VERSION,
  reviewDefaultPending } = require(path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));
const { sanitizeListingFacts } = require(path.join(process.cwd(), 'dist/modules/parser/listing-extraction.js'));
const { sourceRoomCounts } = require(path.join(process.cwd(), 'dist/modules/parser/source-room-counts.js'));

const POLICY = 'source-corroborated-crossposts-v11';
const COMMERCIAL_HOLD = 'Review required: verify whether this business-use shophouse is a residential rental; source also mixes rent and sale.';
const TARGETS = new Map([
  [172, { sourceCount: 3, sourceType: 'FACEBOOK_GROUP', before: [5, null], after: [null, null], rooms: [null, null],
    beforeReviewOrigin: 'INGESTION_VALIDATED_V1',
    beforeReviewReason: 'INGESTION_VALIDATED_V1: held for manual review (MIXED_RENT_SALE_REQUIRES_REVIEW)' }],
  [241, { sourceCount: 7, sourceType: 'FACEBOOK_GROUP', before: [1, null], after: [null, null], rooms: [null, null] }],
  [299, { sourceCount: 1, sourceType: 'FACEBOOK_GROUP', before: [4, 5], after: [null, 5], rooms: [null, 5], conflictingBedrooms: true }],
  [373, { sourceCount: 1, sourceType: 'FACEBOOK_GROUP', before: [1, null], after: [null, null], rooms: [null, null] }],
  [2016, { sourceCount: 1, sourceType: 'KHMER24', before: [null, null], after: [null, 6], rooms: [null, 6] }],
  [2067, { sourceCount: 1, sourceType: 'KHMER24', before: [null, null], after: [3, 4], rooms: [3, 4] }],
  [2726, { sourceCount: 1, sourceType: 'KHMER24', before: [null, null], after: [5, 6], rooms: [5, 6] }],
  [2956, { sourceCount: 1, sourceType: 'KHMER24', before: [null, null], after: [5, 7], rooms: [5, 7] }],
  [2968, { sourceCount: 1, sourceType: 'KHMER24', before: [null, null], after: [8, null], rooms: [8, null] }],
  [5889, { sourceCount: 1, sourceType: 'KHMER24', before: [null, null], after: [null, 4], rooms: [null, 4], conflictingBedrooms: true }],
  [8749, { sourceCount: 1, sourceType: 'FACEBOOK_GROUP', before: [1, 1], after: [null, 1], rooms: [null, 1] }],
  [8769, { sourceCount: 2, sourceType: 'FACEBOOK_GROUP', before: [2, 1], after: [2, null], rooms: [2, null] }],
  [8875, { sourceCount: 1, sourceType: 'FACEBOOK_GROUP', before: [7, 7], after: [7, null], rooms: [7, null] }],
  [9036, { sourceCount: 1, sourceType: 'FACEBOOK_GROUP', before: [null, 1], after: [0, 1], rooms: [0, 1] }],
]);

assert.equal(MODERATION_POLICY_VERSION, POLICY, 'Expected v11 policy in the compiled runtime');
const dbPath = process.env.HOMEASY_ROOM_FACT_REPAIR_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'Set HOMEASY_ROOM_FACT_REPAIR_DB to an absolute SQLite path');
const apply = process.argv.includes('--apply');
const live = process.argv.includes('--live');
const productionPath = '/app/data/homeasy.db';
assert.ok(!live || (apply && path.resolve(dbPath) === productionPath),
  '--live requires --apply against /app/data/homeasy.db');
assert.ok(!apply || path.resolve(dbPath) !== productionPath || live,
  'Live database changes require --apply --live inside the API container');
assert.ok(!apply || live || path.resolve(dbPath).startsWith('/private/tmp/')
  || path.resolve(dbPath).startsWith('/tmp/'), 'Detached apply must target /private/tmp or /tmp');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);

function counts() {
  const values = Object.fromEntries(all(`SELECT review_status,COUNT(*) n
    FROM canonical_listing_moderation GROUP BY review_status`).map((row) => [row.review_status, row.n]));
  return { approved: values.approved || 0, pending: values.pending || 0, rejected: values.rejected || 0 };
}

function rowFor(id) {
  return one(`SELECT l.id,l.status,l.title,l.description,l.bedrooms,l.bathrooms,
      m.review_status,m.review_reason,m.decision_origin,
      (SELECT COUNT(*) FROM canonical_listing_aliases a
        WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') alias_count
    FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
    WHERE l.id=?`, id);
}

function sourcesFor(id) {
  return all(`SELECT o.id occurrence_id,o.source_item_id,COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,
      s.source_type,s.raw_text,s.raw_payload_json
    FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
    WHERE o.listing_id=? AND o.is_current=1 ORDER BY o.id`, id);
}

function validateFacts(id, target, row, sources) {
  assert.equal(row.status, 'active', `Listing ${id} is no longer active`);
  assert.equal(row.review_status, 'pending', `Listing ${id} is no longer Pending`);
  assert.deepEqual([row.bedrooms, row.bathrooms], target.before, `Listing ${id} facts changed after audit`);
  if (target.beforeReviewOrigin) assert.equal(row.decision_origin, target.beforeReviewOrigin,
    `Listing ${id} review origin changed after audit`);
  if (target.beforeReviewReason) assert.equal(row.review_reason, target.beforeReviewReason,
    `Listing ${id} review reason changed after audit`);
  assert.equal(sources.length, target.sourceCount, `Listing ${id} source count changed`);
  for (const source of sources) {
    assert.equal(source.source_type, target.sourceType, `Listing ${id} source type changed`);
    assert.ok(source.source_url?.startsWith('https://'), `Listing ${id} has an unverified source URL`);
    assert.ok(source.raw_text?.trim(), `Listing ${id} has no retained source text`);
    let payload = {};
    try { payload = JSON.parse(source.raw_payload_json ?? '{}'); } catch { /* source facts below will fail closed */ }
    const listing = payload.listing ?? payload.listingFacts ?? payload.listingExtraction ?? {};
    const sourceTitle = typeof listing.source_title === 'string' ? listing.source_title : '';
    const facts = sourceRoomCounts(`${sourceTitle}\n${source.raw_text}`);
    assert.deepEqual([facts.bedrooms, facts.bathrooms], target.rooms,
      `Listing ${id} original room facts changed`);
    assert.equal(facts.conflictingBedrooms, Boolean(target.conflictingBedrooms),
      `Listing ${id} bedroom conflict state changed`);
    if (!target.conflictingBedrooms) assert.equal(facts.conflictingBathrooms, false,
      `Listing ${id} bathroom source is conflicting`);
  }
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    const beforeCounts = counts();
    const prepared = [];
    for (const [id, target] of TARGETS) {
      const row = rowFor(id);
      assert.ok(row, `Listing ${id} disappeared`);
      const sources = sourcesFor(id);
      validateFacts(id, target, row, sources);
      const primaryId = one('SELECT primary_source_occurrence_id FROM canonical_listings WHERE id=?', id)
        .primary_source_occurrence_id;
      const primary = sources.find((source) => source.occurrence_id === primaryId);
      assert.ok(primary, `Listing ${id} primary source changed`);
      let payload = {};
      try { payload = JSON.parse(primary.raw_payload_json ?? '{}'); } catch { /* held by source checks */ }
      const listing = payload.listing ?? payload.listingFacts ?? payload.listingExtraction ?? {};
      const sourceTitle = typeof listing.source_title === 'string' ? listing.source_title : '';
      const raw = `${sourceTitle}\n${primary.raw_text}`;
      const sanitized = sanitizeListingFacts({ title_en: row.title, description_en: row.description }, raw);
      assert.ok(sanitized, `Listing ${id} title could not be source-sanitized`);
      const title = sanitized.title_en || row.title;
      const oldDescriptionRooms = sourceRoomCounts(row.description ?? '');
      const descriptionNeedsRoomCorrection = oldDescriptionRooms.conflictingBedrooms
        || oldDescriptionRooms.conflictingBathrooms
        || (oldDescriptionRooms.bedrooms !== null && oldDescriptionRooms.bedrooms !== target.rooms[0])
        || (oldDescriptionRooms.bathrooms !== null && oldDescriptionRooms.bathrooms !== target.rooms[1]);
      const description = descriptionNeedsRoomCorrection ? sanitized.description_en : row.description;
      const finalRooms = sourceRoomCounts(`${title}\n${description ?? ''}`);
      if (target.after[0] === null) assert.equal(finalRooms.bedrooms, null,
        `Listing ${id} keeps an unsupported canonical bedroom claim`);
      else if (finalRooms.bedrooms !== null) assert.equal(finalRooms.bedrooms, target.after[0],
        `Listing ${id} canonical bedroom claim conflicts after sanitation`);
      if (target.after[1] === null) assert.equal(finalRooms.bathrooms, null,
        `Listing ${id} keeps an unsupported canonical bathroom claim`);
      else if (finalRooms.bathrooms !== null) assert.equal(finalRooms.bathrooms, target.after[1],
        `Listing ${id} canonical bathroom claim conflicts after sanitation`);
      prepared.push({ id, target, row, title, description });
    }

    const update = db.prepare(`UPDATE canonical_listings SET title=?,description=?,bedrooms=?,bathrooms=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='active'`);
    for (const item of prepared) {
      const result = update.run(item.title, item.description, item.target.after[0], item.target.after[1], item.id);
      assert.equal(result.changes, 1, `Listing ${item.id} changed during repair`);
    }
    const reasonUpdate = db.prepare(`UPDATE canonical_listing_moderation SET review_reason=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE listing_id=? AND review_status='pending'`);
    assert.equal(reasonUpdate.run(COMMERCIAL_HOLD, 172).changes, 1,
      'Listing 172 could not receive the source-classification review reason');

    // Any newly eligible machine hold aborts the whole repair. No status change is intended here.
    const machineTargets = [...TARGETS.keys()].filter((id) => id !== 172);
    const review = reviewDefaultPending(db, machineTargets);
    assert.equal(review.approved, 0,
      'Room-fact repair unexpectedly made a Pending listing eligible');
    assert.ok(review.held <= machineTargets.length,
      'Moderation policy evaluated more records than the requested target set');
    for (const [id] of TARGETS) assert.equal(rowFor(id).review_status, 'pending',
      `Listing ${id} moderation status changed unexpectedly`);
    assert.equal(rowFor(172).review_reason, COMMERCIAL_HOLD);
    assert.deepEqual(counts(), beforeCounts, 'Moderation counts changed');
    assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
    assert.equal(all('PRAGMA foreign_key_check').length, 0);
    if (apply) db.exec('COMMIT'); else db.exec('ROLLBACK');
    console.log(JSON.stringify({ policy: POLICY, mode: apply ? 'applied' : 'rolled-back',
      beforeCounts, afterCounts: beforeCounts, corrected: prepared.map((item) => ({ id: item.id,
        from: item.target.before, to: item.target.after, titleChanged: item.title !== item.row.title,
        descriptionChanged: item.description !== item.row.description })),
      policyRecheck: review, reviewStatusChanges: 0, changedReviewReason: [172],
      integrity: 'ok', foreignKeyViolations: 0 }));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
} finally {
  db.close();
}
