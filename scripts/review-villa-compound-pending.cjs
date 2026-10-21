/** Source-scoped repair: Khmer24 #14137551 states 7 bedrooms = main villa 3 + bungalows 4.
 * Rehearse on detached SQLite first; production requires --apply --live from the API container.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sourceRoomCounts } = require(path.join(process.cwd(), 'dist/modules/parser/source-room-counts.js'));
const { reviewDefaultPending, MODERATION_POLICY_VERSION } = require(
  path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));

const ID = 14373;
const SOURCE_ID = 4923;
const dbPath = process.env.HOMEASY_COMPOUND_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'HOMEASY_COMPOUND_DB must be absolute');
const apply = process.argv.includes('--apply');
const live = process.argv.includes('--live');
assert.equal(MODERATION_POLICY_VERSION, 'source-corroborated-crossposts-v7');
assert.ok(!live || (apply && path.resolve(dbPath) === '/app/data/homeasy.db'),
  '--live requires --apply on API container production database');
assert.ok(path.resolve(dbPath) !== '/app/data/homeasy.db' || live,
  'Never rehearse against the live database');
assert.ok(live || /^\/(?:private\/)?tmp\//.test(path.resolve(dbPath)),
  'Detached rehearsal must use a temporary database path');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const counts = () => Object.fromEntries(all('SELECT review_status,COUNT(*) n FROM canonical_listing_moderation GROUP BY 1')
  .map(row => [row.review_status, row.n]));

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = counts();
    const row = one(`SELECT l.id,l.property_id,l.price,l.status,l.city,l.bedrooms,l.bathrooms,
      l.listing_facts_json,p.bedrooms property_bedrooms,p.bathrooms property_bathrooms,
      m.review_status,m.review_reason,m.decision_origin,
      o.source_item_id,o.is_current,s.source_type,s.external_id,s.raw_text,s.raw_payload_json,
      (SELECT COUNT(*) FROM canonical_listings x WHERE x.property_id=l.property_id) property_links,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences x WHERE x.listing_id=l.id AND x.is_current=1) current_sources
      FROM canonical_listings l JOIN canonical_properties p ON p.id=l.property_id
      JOIN canonical_listing_moderation m ON m.listing_id=l.id
      JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
      JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?`, ID);
    assert.ok(row, 'Target listing missing');
    assert.equal(row.property_id, ID);
    assert.equal(row.property_links, 1);
    assert.equal(row.current_sources, 1);
    assert.equal(row.source_item_id, SOURCE_ID);
    assert.equal(row.is_current, 1);
    assert.equal(row.source_type, 'KHMER24');
    assert.equal(row.external_id, '14137551');
    assert.equal(row.status, 'active');
    assert.equal(row.city, 'siem_reap');
    assert.equal(row.price, 250000);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.decision_origin, 'DEFAULT_PENDING');
    assert.equal(row.review_reason, null);
    assert.equal(row.bedrooms, null);
    assert.equal(row.property_bedrooms, null);
    assert.equal(row.bathrooms, 8);
    assert.equal(row.property_bathrooms, 8);

    const payload = JSON.parse(row.raw_payload_json ?? '{}');
    const originalTitle = payload.listing?.source_title;
    assert.ok(typeof originalTitle === 'string' && /7[- ]?bedroom/i.test(originalTitle));
    const rooms = sourceRoomCounts(`${originalTitle}\n${row.raw_text}`);
    assert.deepEqual(rooms, { bedrooms: 7, bathrooms: 8,
      conflictingBedrooms: false, conflictingBathrooms: false });
    const facts = JSON.parse(row.listing_facts_json ?? '{}');
    assert.ok(facts.bedrooms == null, 'Stored AI bedrooms changed');

    assert.equal(run(`UPDATE canonical_listings SET bedrooms=7,listing_facts_json=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL`,
    JSON.stringify({ ...facts, bedrooms: 7 }), ID).changes, 1);
    assert.equal(run(`UPDATE canonical_properties SET bedrooms=7,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL`, ID).changes, 1);
    const moderation = reviewDefaultPending(db, [ID]);
    assert.deepEqual(moderation, { approved: 1, held: 0 },
      'The full moderation policy still considers the offer unsafe');
    const updated = one(`SELECT l.bedrooms,p.bedrooms property_bedrooms,m.review_status,m.review_reason,
      m.decision_origin,m.policy_version FROM canonical_listings l
      JOIN canonical_properties p ON p.id=l.property_id
      JOIN canonical_listing_moderation m ON m.listing_id=l.id WHERE l.id=?`, ID);
    assert.equal(updated.bedrooms, 7);
    assert.equal(updated.property_bedrooms, 7);
    assert.equal(updated.review_status, 'approved');
    assert.equal(updated.review_reason, null);
    assert.equal(updated.decision_origin, 'INGESTION_VALIDATED_V1');
    assert.equal(updated.policy_version, MODERATION_POLICY_VERSION);
    const after = counts();
    assert.equal(after.pending, before.pending - 1);
    assert.equal(after.approved, before.approved + 1);
    assert.equal(after.rejected, before.rejected);
    assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
    assert.equal(all('PRAGMA foreign_key_check').length, 0);
    db.exec(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'rehearsed-rolled-back', listingId: ID,
      sourceItemId: SOURCE_ID, bedrooms: 7, bathrooms: 8, before, expectedAfter: after, integrity: 'ok' }));
  } catch (error) { db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }
