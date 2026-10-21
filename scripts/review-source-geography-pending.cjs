/**
 * Guarded, one-time recovery of eight source-verified Khmer24 location holds.
 * Checks the current original against the complete v5 policy before approval.
 * The production DB may be written only by the API container with --live.
 * No network, scraper, or AI requests are made.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluateModerationCandidate, MODERATION_POLICY_VERSION } = require(
  path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));
const { sourceRoomCounts } = require(
  path.join(process.cwd(), 'dist/modules/parser/source-room-counts.js'));

const HISTORICAL_HOLD = 'INGESTION_VALIDATED_V1: held for manual review (MIXED_RENT_SALE_REQUIRES_REVIEW)';
const TARGETS = [
  { id: 2659, sourceId: 4286, price: 35000, historical: true, repairRooms: [2, 3] },
  { id: 7746, sourceId: 4472, price: 32000 },
  { id: 7821, sourceId: 4474, price: 25000 },
  { id: 7959, sourceId: 4476, price: 30000 },
  { id: 7992, sourceId: 4473, price: 45000 },
  { id: 8040, sourceId: 4475, price: 20000 },
  { id: 9861, sourceId: 4635, price: 30000 },
  { id: 9899, sourceId: 4631, price: 40000 },
];

assert.equal(MODERATION_POLICY_VERSION, 'source-confirmed-rent-v5');
const dbPath = process.env.HOMEASY_RECOVERY_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'HOMEASY_RECOVERY_DB must be an absolute path');
const apply = process.argv.includes('--apply');
assert.ok(!apply || path.resolve(dbPath) !== '/app/data/homeasy.db' || process.argv.includes('--live'),
  'Production write requires --live inside the API container');
const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

const candidateSql = `SELECT l.id,l.status,l.availability_status,l.title,l.description,l.price,l.bedrooms,l.bathrooms,
  l.city,l.category,l.property_type,l.property_id,l.listing_facts_json,
  p.bedrooms property_bedrooms,p.bathrooms property_bathrooms,
  m.review_status,m.review_reason,m.decision_origin,m.decision_actor,m.policy_version,m.decision_evidence_json,
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

function verify(target) {
  const row = one(candidateSql, target.id);
  assert.ok(row, `Missing listing ${target.id}`);
  assert.equal(row.source_item_id, target.sourceId, `${target.id} source changed`);
  assert.equal(row.property_id, target.id, `${target.id} property changed`);
  assert.equal(row.property_links, 1, `${target.id} property shared`);
  assert.equal(row.is_current, 1, `${target.id} occurrence not current`);
  assert.equal(row.source_type, 'KHMER24');
  assert.equal(row.status, 'active');
  assert.equal(row.city, 'siem_reap');
  assert.equal(row.price, target.price, `${target.id} price changed`);
  const existingEvidence = row.decision_evidence_json ? JSON.parse(row.decision_evidence_json) : null;
  if (row.review_status === 'approved' && row.policy_version === MODERATION_POLICY_VERSION &&
      existingEvidence?.sourceGeoV5Recovery === true) {
    assert.equal(row.review_reason, null);
    assert.equal(row.decision_origin, 'INGESTION_VALIDATED_V1');
    assert.equal(row.decision_actor, 'AUTO_POLICY');
    assert.equal(existingEvidence.originalSourceId, target.sourceId);
    assert.equal(existingEvidence.monthlyPriceCents, target.price);
    if (target.repairRooms) {
      assert.deepEqual([row.bedrooms, row.bathrooms, row.property_bedrooms, row.property_bathrooms],
        [...target.repairRooms, ...target.repairRooms]);
    }
    return { id: target.id, alreadyApplied: true };
  }
  assert.equal(row.decision_origin, target.historical ? 'INGESTION_VALIDATED_V1' : 'DEFAULT_PENDING');
  assert.equal(row.decision_actor, target.historical ? 'AUTO_POLICY' : 'SYSTEM');
  assert.equal(row.review_status, 'pending', `${target.id} has received another decision`);
  assert.equal(row.review_reason, target.historical ? HISTORICAL_HOLD : null,
    `${target.id} prior hold changed`);
  const payload = JSON.parse(row.raw_payload_json ?? '{}');
  const count = sourceRoomCounts(`${payload.listing?.source_title ?? ''}\n${row.raw_text ?? ''}`);
  const facts = JSON.parse(row.listing_facts_json || '{}');
  assert.ok(facts && typeof facts === 'object' && !Array.isArray(facts));
  let bedrooms = row.bedrooms;
  let bathrooms = row.bathrooms;
  if (target.repairRooms) {
    assert.deepEqual(count, { bedrooms: target.repairRooms[0], bathrooms: target.repairRooms[1],
      conflictingBedrooms: false, conflictingBathrooms: false }, `${target.id} source room evidence changed`);
    for (const oldValue of [row.bedrooms,row.bathrooms,row.property_bedrooms,row.property_bathrooms,
      facts.bedrooms,facts.bathrooms]) assert.ok(oldValue == null, `${target.id} room fact already changed`);
    [bedrooms, bathrooms] = target.repairRooms;
  } else {
    assert.equal(row.bedrooms, row.property_bedrooms);
    assert.equal(row.bathrooms, row.property_bathrooms);
  }
  const decision = evaluateModerationCandidate({ ...row, review_reason: null, bedrooms, bathrooms });
  assert.deepEqual(decision, {approved: true,reasons: []}, `${target.id} has other moderation holds`);
  return {id: target.id, row, target, facts, count, alreadyApplied: false};
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  if (apply) db.exec('BEGIN IMMEDIATE');
  try {
    const plans = TARGETS.map(verify);
    const newPlans = plans.filter(p => !p.alreadyApplied);
    if (apply) {
      for (const p of newPlans) {
        if (p.target.repairRooms) {
          const [bedrooms,bathrooms] = p.target.repairRooms;
          assert.equal(run(`UPDATE canonical_listings SET bedrooms=?,bathrooms=?,listing_facts_json=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL AND bathrooms IS NULL`,
          bedrooms,bathrooms,JSON.stringify({...p.facts,bedrooms,bathrooms}),p.id).changes,1);
          assert.equal(run(`UPDATE canonical_properties SET bedrooms=?,bathrooms=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL AND bathrooms IS NULL`,
          bedrooms,bathrooms,p.id).changes,1);
        }
        const evidence = {sourceGeoV5Recovery:true,policy:MODERATION_POLICY_VERSION,
          previousReason:p.row.review_reason,originalSourceId:p.target.sourceId,sourceUrl:p.row.source_url,
          monthlyPriceCents:p.target.price,locationEvidence:'source-asserted-Siem-Reap-sangkat',
          sourceRooms:p.count,sourceCoordinatesVerified:false};
        assert.equal(run(`UPDATE canonical_listing_moderation SET review_status='approved',review_reason=NULL,
          decision_origin='INGESTION_VALIDATED_V1',policy_version=?,decision_evidence_json=?,
          previous_review_status='pending',decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
          decision_actor='AUTO_POLICY',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE listing_id=? AND review_status='pending' AND decision_origin=? AND decision_actor=?
          AND review_reason IS ?`,
        MODERATION_POLICY_VERSION,JSON.stringify(evidence),p.id,p.row.decision_origin,
        p.row.decision_actor,p.row.review_reason).changes,1);
      }
      assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok');
      assert.equal(all('PRAGMA foreign_key_check').length, 0);
      db.exec('COMMIT');
    }
    console.log(JSON.stringify({dbPath,applied:apply,policy:MODERATION_POLICY_VERSION,
      candidates:plans.map(p=>p.id),alreadyApplied:plans.filter(p=>p.alreadyApplied).map(p=>p.id),
      newlyApproved:apply?newPlans.map(p=>p.id):[],
      roomRepairs:apply?newPlans.filter(p=>p.target.repairRooms).map(p=>p.id):[],
      integrity:'ok',foreignKeyViolations:0}));
  } catch (error) { if (apply) db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }
