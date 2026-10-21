/**
 * One-time, evidence-scoped re-evaluation of six historical AUTO_POLICY holds.
 * Original raw source remains private and is evaluated locally by compiled v4.
 *
 * HOMEASY_RECOVERY_DB=/absolute/detached.db node scripts/review-historical-source-pending.cjs
 * HOMEASY_RECOVERY_DB=/absolute/detached.db node scripts/review-historical-source-pending.cjs --apply
 * For /app/data/homeasy.db: run only INSIDE the API container with --apply --live.
 * The script itself never invokes an LLM, scraper or network API.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluateModerationCandidate, MODERATION_POLICY_VERSION } = require(
  path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));
const { sourceRoomCounts } = require(
  path.join(process.cwd(), 'dist/modules/parser/source-room-counts.js'));

const TARGETS = [
  { id: 257, source: 92, reason: 'BEDROOMS_CONTRADICT_SOURCE', price: 38000, beds: 2, baths: 3 },
  { id: 262, source: 212, reason: 'PRICE_NOT_EXPLICITLY_SUPPORTED', price: 35000, beds: 2, baths: 3 },
  { id: 2653, source: 4287, reason: 'MIXED_RENT_SALE_REQUIRES_REVIEW', price: 150000, beds: 2, baths: 3, repair: true },
  { id: 2785, source: 4284, reason: 'MIXED_RENT_SALE_REQUIRES_REVIEW', price: 70000, beds: 4, baths: 3, repair: true },
  { id: 2947, source: 4285, reason: 'MIXED_RENT_SALE_REQUIRES_REVIEW', price: 35000, beds: 2, baths: 3, repair: true },
  { id: 2978, source: 4289, reason: 'MIXED_RENT_SALE_REQUIRES_REVIEW', price: 110000, beds: 3, baths: 3, repair: true },
];

const dbPath = process.env.HOMEASY_RECOVERY_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'HOMEASY_RECOVERY_DB must be an absolute path');
const apply = process.argv.includes('--apply');
assert.ok(path.resolve(dbPath) !== '/app/data/homeasy.db' || !apply || process.argv.includes('--live'),
  'Live database modifications require explicit --live inside the running API container');
const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
const one = (sql, ...values) => db.prepare(sql).get(...values);
const all = (sql, ...values) => db.prepare(sql).all(...values);
const run = (sql, ...values) => db.prepare(sql).run(...values);

// Keep the same source identity, publication age and geographical evidence
// requirements as reviewDefaultPending(), including all occurrence bindings.
const rowSql = `SELECT l.id,l.status,l.availability_status,l.title,l.description,l.price,l.bedrooms,l.bathrooms,
    l.city,l.category,l.property_type,l.property_id,l.listing_facts_json,
    p.bedrooms property_bedrooms,p.bathrooms property_bathrooms,
    m.review_reason,m.review_status,m.decision_origin,m.decision_actor,m.policy_version,m.decision_evidence_json,
    s.id source_item_id,s.source_type,o.is_current,
    COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,s.raw_text,s.raw_payload_json,
    (SELECT COALESCE(h.posted_at,t.published_at) FROM canonical_listing_source_occurrences h
      JOIN source_items t ON t.id=h.source_item_id WHERE h.listing_id=l.id
      AND COALESCE(julianday(h.posted_at),julianday(t.published_at)) IS NOT NULL
      ORDER BY COALESCE(julianday(h.posted_at),julianday(t.published_at)),h.id LIMIT 1) original_published_at,
    (SELECT h.first_seen_at FROM canonical_listing_source_occurrences h WHERE h.listing_id=l.id
      ORDER BY julianday(h.first_seen_at),h.id LIMIT 1) first_source_seen_at,
    (SELECT COUNT(*) FROM canonical_listings other WHERE other.id<>l.id AND other.status='active'
      AND lower(trim(other.title))=lower(trim(l.title)) AND other.price=l.price
      AND COALESCE(other.city,'')=COALESCE(l.city,'')
      AND COALESCE(other.bedrooms,-1)=COALESCE(l.bedrooms,-1)) matching_active_listings,
    (SELECT COUNT(*) FROM canonical_listing_source_occurrences x WHERE x.listing_id=l.id AND x.is_current=1) current_count,
    EXISTS(SELECT 1 FROM canonical_listing_source_occurrences x JOIN canonical_listing_source_occurrences y
      ON y.source_url=x.source_url AND y.listing_id<>x.listing_id AND y.is_current=1
      WHERE x.listing_id=l.id AND x.is_current=1 AND x.source_url IS NOT NULL) conflicting_url,
    (SELECT COUNT(*) FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') legacy_aliases,
    (SELECT COUNT(*) FROM canonical_listings v WHERE v.property_id=l.property_id) property_links
  FROM canonical_listings l JOIN canonical_properties p ON p.id=l.property_id
  JOIN canonical_listing_moderation m ON m.listing_id=l.id
  JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
  JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?`;

function check(target) {
  const row = one(rowSql, target.id);
  assert.ok(row, `Missing listing ${target.id}`);
  assert.equal(row.source_item_id, target.source, `${target.id} changed primary source`);
  assert.equal(row.property_id, target.id, `${target.id} property binding changed`);
  assert.equal(row.property_links, 1, `${target.id} shared canonical property`);
  assert.equal(row.is_current, 1, `${target.id} primary source not current`);
  assert.equal(row.status, 'active', `${target.id} is no longer active`);
  assert.equal(row.price, target.price, `${target.id} price has changed`);
  assert.equal(row.decision_origin, 'INGESTION_VALIDATED_V1', `${target.id} was manually processed`);
  assert.equal(row.decision_actor, 'AUTO_POLICY', `${target.id} has human decision`);
  const evidence = row.decision_evidence_json ? JSON.parse(row.decision_evidence_json) : null;
  if (row.review_status === 'approved' && ['source-confirmed-rent-v4', MODERATION_POLICY_VERSION].includes(row.policy_version) &&
      evidence?.historicalPendingReevaluation === true) {
    assert.equal(row.review_reason, null, `${target.id} reapproved with reason`);
    return { id: target.id, alreadyApplied: true };
  }
  assert.equal(row.review_status, 'pending', `${target.id} moderation status changed`);
  assert.equal(row.review_reason, `INGESTION_VALIDATED_V1: held for manual review (${target.reason})`,
    `${target.id} protected prior reason changed`);
  const sourceTitle = JSON.parse(row.raw_payload_json ?? '{}').listing?.source_title ?? '';
  const counts = sourceRoomCounts(`${sourceTitle}\n${row.raw_text ?? ''}`);
  assert.deepEqual(counts, { bedrooms: target.beds, bathrooms: target.baths,
    conflictingBedrooms: false, conflictingBathrooms: false }, `${target.id} original room evidence differs`);
  const facts = JSON.parse(row.listing_facts_json || '{}');
  assert.ok(facts && typeof facts === 'object' && !Array.isArray(facts), `${target.id} malformed canonical facts`);
  if (target.repair) {
    for (const value of [row.bedrooms,row.bathrooms,row.property_bedrooms,row.property_bathrooms,
      facts.bedrooms,facts.bathrooms]) {
      assert.ok(value == null, `${target.id} has changed room facts`);
    }
  } else {
    assert.equal(row.bedrooms, target.beds, `${target.id} canonical bedroom differs`);
    assert.equal(row.bathrooms, target.baths, `${target.id} canonical bathroom differs`);
    assert.equal(row.property_bedrooms, target.beds, `${target.id} property bedroom differs`);
    assert.equal(row.property_bathrooms, target.baths, `${target.id} property bathroom differs`);
  }
  const decision = evaluateModerationCandidate({ ...row, review_reason: null,
    bedrooms: target.repair ? target.beds : row.bedrooms,
    bathrooms: target.repair ? target.baths : row.bathrooms });
  assert.deepEqual(decision, { approved: true, reasons: [] }, `${target.id} still needs review`);
  return { id: target.id, row, target, facts, priorEvidence: evidence, alreadyApplied: false };
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  if (apply) db.exec('BEGIN IMMEDIATE');
  try {
    const plans = TARGETS.map(check);
    const newlyApproved = plans.filter(p => !p.alreadyApplied);
    if (apply) {
      for (const p of newlyApproved) {
        if (p.target.repair) {
          assert.equal(run(`UPDATE canonical_listings SET bedrooms=?,bathrooms=?,listing_facts_json=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL AND bathrooms IS NULL`,
          p.target.beds,p.target.baths,JSON.stringify({ ...p.facts, bedrooms:p.target.beds,bathrooms:p.target.baths }),p.id).changes, 1);
          assert.equal(run(`UPDATE canonical_properties SET bedrooms=?,bathrooms=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL AND bathrooms IS NULL`,
          p.target.beds,p.target.baths,p.id).changes, 1);
        }
        assert.equal(run(`UPDATE canonical_listing_moderation SET review_status='approved',review_reason=NULL,
          decision_origin='INGESTION_VALIDATED_V1',policy_version=?,decision_evidence_json=?,
          previous_review_status='pending',decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
          decision_actor='AUTO_POLICY',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE listing_id=? AND review_status='pending' AND decision_origin='INGESTION_VALIDATED_V1'
          AND decision_actor='AUTO_POLICY' AND review_reason=?`,
          MODERATION_POLICY_VERSION,JSON.stringify({historicalPendingReevaluation:true,
            previousReason:p.row.review_reason,previousEvidence:p.priorEvidence,
            confirmedSourceItemId:p.target.source,confirmedPriceCents:p.target.price,
            confirmedRooms:{bedrooms:p.target.beds,bathrooms:p.target.baths},
            policy:MODERATION_POLICY_VERSION}),p.id,p.row.review_reason).changes,1);
      }
      assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok');
      assert.equal(all('PRAGMA foreign_key_check').length, 0);
      db.exec('COMMIT');
    }
    console.log(JSON.stringify({dbPath,applied:apply,policy:MODERATION_POLICY_VERSION,
      candidates:plans.map(p=>p.id),alreadyApplied:plans.filter(p=>p.alreadyApplied).map(p=>p.id),
      approved:apply?newlyApproved.map(p=>p.id):[],
      roomRepair:plans.filter(p=>!p.alreadyApplied&&p.target.repair).map(p=>p.id),
      integrity:'ok',foreignKeyViolations:0}));
  } catch (error) { if (apply) db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }
