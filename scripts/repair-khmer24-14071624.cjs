/**
 * Targeted, idempotent repair for the verified legacy identity split of Khmer24
 * post 14071624. Run on an isolated SQLite snapshot before the live container:
 * HOMEASY_REPAIR_DB=/app/data/backups/fixture.db node - --apply < scripts/repair-khmer24-14071624.cjs
 * Requires both --apply and --live for /app/data/homeasy.db.
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const path = require('node:path');

const dbPath = process.env.HOMEASY_REPAIR_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'HOMEASY_REPAIR_DB must be absolute');
const isLive = path.resolve(dbPath) === '/app/data/homeasy.db';
assert.ok(!isLive || process.argv.includes('--live'), 'Live DB requires explicit --live');
const apply = process.argv.includes('--apply');
const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');

const OLD = 243, NEW = 2630, OLD_ITEM = 2924, NEW_ITEM = 4282;
const OLD_OCC = 307, NEW_OCC = 4822;
const OLD_REF = 'lst_8698d7f58d179ce968d88193106ce8a0';
const NEW_REF = 'lst_8b3cb66a9390d1c996454c20584a4cb9';
const LAT = 13.35789016603966, LNG = 103.86067953898747;
const MAP_URL = `https://www.google.com/maps/search/?api=1&query=${LAT},${LNG}`;
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const count = (sql, ...args) => Number(one(sql, ...args).n);

function verify(before, allowUnretiredArchive = false) {
  const old = one('SELECT id,public_ref,status,property_id,price,bedrooms,bathrooms FROM canonical_listings WHERE id=?', OLD);
  const newer = one('SELECT id,public_ref,status,property_id,price,bedrooms,bathrooms,primary_source_occurrence_id,listing_facts_json FROM canonical_listings WHERE id=?', NEW);
  const oldReview = one('SELECT review_status,review_reason,decision_actor,decision_evidence_json FROM canonical_listing_moderation WHERE listing_id=?', OLD);
  assert.equal(old.public_ref, OLD_REF);
  assert.equal(newer.public_ref, NEW_REF);
  assert.equal(old.property_id, OLD);
  assert.equal(newer.property_id, NEW);
  assert.equal(old.price, 70000);
  assert.equal(newer.price, 70000);
  assert.equal(old.bedrooms, 3);
  assert.equal(old.bathrooms, 4);
  for (const [item, externalId] of [[OLD_ITEM, 'adid:14071624'],[NEW_ITEM, '14071624']]) {
    const src = one('SELECT source_type,external_id,raw_payload_json FROM source_items WHERE id=?', item);
    assert.equal(src.external_id, externalId);
    assert.ok(/KHMER24/i.test(src.source_type));
    assert.ok(src.raw_payload_json);
  }
  const occurrences = all('SELECT id,source_item_id,listing_id,is_current,posted_at FROM canonical_listing_source_occurrences WHERE id IN (?,?) ORDER BY id', OLD_OCC, NEW_OCC);
  assert.deepEqual(occurrences.map(x => [x.id,x.source_item_id,x.is_current]), [[OLD_OCC,OLD_ITEM,1],[NEW_OCC,NEW_ITEM,1]]);
  assert.equal(occurrences[0].listing_id, before ? OLD : NEW);
  assert.equal(occurrences[1].listing_id, NEW);
  assert.equal(count('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE listing_id=? AND is_current=1', OLD),before?1:0);
  assert.equal(count('SELECT COUNT(*) n FROM media_assets WHERE source_item_id=?', OLD_ITEM),20);
  assert.equal(count('SELECT COUNT(*) n FROM media_asset_source_occurrences WHERE source_item_id IN (?,?)', OLD_ITEM, NEW_ITEM),40);
  assert.equal(count('SELECT COUNT(*) n FROM canonical_listing_moderation WHERE listing_id=? AND review_status=\'approved\'', NEW),1);
  assert.equal(old.status,before?'active':'archived');
  if (before || allowUnretiredArchive) {
    assert.equal(oldReview.review_status,'pending');
    assert.equal(oldReview.review_reason,'Legacy identity alias conflict; manual review required');
  } else {
    assert.equal(oldReview.review_status,'rejected');
    assert.equal(oldReview.decision_actor,'AUTO_POLICY');
    assert.equal(JSON.parse(oldReview.decision_evidence_json).mergedIntoListingId,NEW);
  }
  if (!before) {
    assert.equal(newer.primary_source_occurrence_id,OLD_OCC);
    assert.equal(newer.bedrooms,3);assert.equal(newer.bathrooms,4);
    assert.equal(count('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE listing_id=? AND discovery_credit=1',NEW),1);
    assert.equal(count('SELECT COUNT(*) n FROM media_asset_source_occurrences WHERE listing_id=? AND source_item_id IN (?,?)',NEW,OLD_ITEM,NEW_ITEM),40);
    assert.equal(count('SELECT COUNT(*) n FROM media_assets WHERE listing_id=? AND source_item_id=?',NEW,OLD_ITEM),20);
    for(const ref of [OLD_REF,NEW_REF]) assert.equal(one('SELECT listing_id FROM canonical_listing_aliases WHERE namespace=\'public_listing_ref\' AND alias=?',ref).listing_id, NEW);
    assert.equal(one('SELECT latitude FROM canonical_properties WHERE id=?',NEW).latitude,LAT);
    assert.equal(one('SELECT longitude FROM canonical_properties WHERE id=?',NEW).longitude,LNG);
    assert.equal(JSON.parse(newer.listing_facts_json).latitude,LAT);
  }
}

function setVerifiedPin(item, priorFactRooms) {
  const row = one('SELECT raw_payload_json FROM source_items WHERE id=?', item);
  const payload = JSON.parse(row.raw_payload_json);
  const extraction = { ...(payload.listingExtraction || {}) };
  if(priorFactRooms) {
    // Original listingFacts remain intact, including rooms and lease details.
    assert.equal(payload.listingFacts.bedrooms,3);
    assert.equal(payload.listingFacts.bathrooms,4);
  } else {
    assert.ok(extraction.description_en.includes('3 Bedroom'));
    assert.ok(extraction.description_en.includes('4 Bathroom'));
    extraction.bedrooms = 3;
    extraction.bathrooms = 4;
  }
  extraction.latitude=LAT;extraction.longitude=LNG;
  extraction.maps_url=MAP_URL;
  extraction.maps_urls=[MAP_URL];
  payload.listingExtraction=extraction;
  run('UPDATE source_items SET raw_payload_json=? WHERE id=?',JSON.stringify(payload),item);
  return {...(payload.listingFacts||{}),...extraction};
}

const already = one('SELECT status FROM canonical_listings WHERE id=?', OLD)?.status === 'archived';
const reviewRetired = one('SELECT review_status FROM canonical_listing_moderation WHERE listing_id=?', OLD)?.review_status === 'rejected';
verify(!already, already && !reviewRetired);
console.log(JSON.stringify({ database: dbPath, state: !already?'ready':reviewRetired?'already-repaired':'archive-review-pending', apply, latitude: LAT, longitude: LNG }));
if (apply && (!already || !reviewRetired)) {
  db.exec('BEGIN IMMEDIATE');
  try {
    verify(!already, already && !reviewRetired);
    if (!already) {
    const oldFacts = setVerifiedPin(OLD_ITEM,true);
    setVerifiedPin(NEW_ITEM,false);
    // Historical listing remains as an archived audit record. All current
    // occurrences and asset associations belong to the public survivor.
    run('UPDATE canonical_listing_source_occurrences SET listing_id=?, discovery_credit=1, discovery_rank=1, property_discovery_credit=1 WHERE id=?',NEW,OLD_OCC);
    run('UPDATE canonical_listing_source_occurrences SET discovery_credit=0, discovery_rank=NULL, property_discovery_credit=0 WHERE id=?',NEW_OCC);
    run('UPDATE media_assets SET listing_id=?, property_id=? WHERE source_item_id=? AND listing_id=?',NEW,NEW,OLD_ITEM,OLD);
    run('UPDATE media_asset_source_occurrences SET listing_id=?, property_id=? WHERE listing_id=? AND source_item_id IN (?,?)',NEW,NEW,OLD,OLD_ITEM,NEW_ITEM);
    run('UPDATE media_asset_source_occurrences SET property_id=? WHERE listing_id=? AND source_item_id=?',NEW,NEW,NEW_ITEM);
    run(`UPDATE canonical_listings SET status='archived',primary_source_occurrence_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,OLD);
    run(`UPDATE canonical_listings SET primary_source_occurrence_id=?, title=?, description=?, property_type=?,
      bedrooms=3,bathrooms=4,listing_facts_json=?,first_seen_at=MIN(first_seen_at,?),
      last_seen_at=MAX(last_seen_at,?),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
      OLD_OCC,oldFacts.title_en,oldFacts.description_en,oldFacts.property_type,
      JSON.stringify(oldFacts),'2026-10-05T00:59:59Z','2026-10-07T07:43:52.544Z',NEW);
    run(`UPDATE canonical_properties SET latitude=?,longitude=?,bedrooms=3,bathrooms=4,
      property_type='Private Villa',sangkat='Sala Kamreuk',canonical_address='Sala Kamreuk',explicit_location='Sala Kamreuk',
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,LAT,LNG,NEW);
    // Preserve the immutable old public ref as an explicit route to the survivor.
    for (const [ns, alias] of [['public_listing_ref',OLD_REF],['canonical_listing_id',String(OLD)]]) {
      const aliasRow = one('SELECT listing_id FROM canonical_listing_aliases WHERE namespace=? AND alias=?',ns,alias);
      assert.equal(aliasRow.listing_id,OLD);
      run('UPDATE canonical_listing_aliases SET listing_id=? WHERE namespace=? AND alias=?',NEW,ns,alias);
    }
    assert.equal(count('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE listing_id=? AND is_current=1',OLD),0);
    }
    // The archived identity is an already-merged duplicate. Retire its stale
    // pending moderation task without implying that the survivor was rejected.
    const oldReview=one('SELECT review_status,review_reason,decision_origin,decision_evidence_json FROM canonical_listing_moderation WHERE listing_id=?',OLD);
    assert.equal(oldReview.review_status,'pending');
    const originalEvidence=oldReview.decision_evidence_json?JSON.parse(oldReview.decision_evidence_json):null;
    run(`UPDATE canonical_listing_moderation SET review_status='rejected',
      review_reason='Archived duplicate identity merged into approved Khmer24 listing 2630',
      decision_origin='INGESTION_VALIDATED_V1',policy_version='DUPLICATE_IDENTITY_REPAIR_V1',
      decision_actor='AUTO_POLICY',previous_review_status='pending',
      decision_evidence_json=?,decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE listing_id=? AND review_status='pending'`,
      JSON.stringify({ action:'RETIRED_DUPLICATE',source:'KHMER24',postId:'14071624',mergedIntoListingId:NEW,
        previousReviewReason:oldReview.review_reason,previousDecisionOrigin:oldReview.decision_origin,originalEvidence }),OLD);
    verify(false);
    assert.equal(one('PRAGMA integrity_check').integrity_check,'ok');
    assert.equal(all('PRAGMA foreign_key_check').length,0);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  console.log('APPLIED');
}
verify(!already && !apply,!apply && already && !reviewRetired);
console.log(JSON.stringify({state:apply?'verified':'read-only verified',integrity:one('PRAGMA integrity_check').integrity_check,foreignKeyErrors:all('PRAGMA foreign_key_check').length}));
db.close();
