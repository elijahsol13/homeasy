/**
 * Evidence-scoped recovery for 18 verified Khmer24 canonical listings whose
 * preserved source text explicitly states rooms, but old LLM facts omit them.
 *
 * Usage (only on a detached copy first):
 * HOMEASY_RECOVERY_DB=/absolute/path/to/checkpoint.db node scripts/recover-khmer24-room-facts.cjs
 * HOMEASY_RECOVERY_DB=/absolute/path/to/rehearsal.db node scripts/recover-khmer24-room-facts.cjs --apply
 *
 * For /app/data/homeasy.db, --apply also requires --live. Run from within the
 * API container to avoid concurrent host SQLite/WAL access.
 * Uses the application's compiled room parser and moderation policy.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sourceRoomCounts } = require(path.join(process.cwd(), 'dist/modules/parser/source-room-counts.js'));
const { reviewDefaultPending } = require(path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));

// Snapshot-verified canonical ID -> historical primary source item ID.
const SOURCES = new Map([
  // 5889 is deliberately excluded: original says "Bedrooms: 4 + 1",
  // and advertises Phnom Penh as a mixed sale/rent offer.
  [5714, 4450], [5798, 4445], [6006, 4446],
  [6954, 4457], [6990, 4459], [9135, 4617], [9557, 4616],
  [9692, 4633], [9744, 4632], [9778, 4628], [9852, 4630],
  [9867, 4629], [9899, 4631], [9909, 4626], [9933, 4627],
  [10879, 4651], [11091, 4652], [11773, 4677],
]);
const dbPath = process.env.HOMEASY_RECOVERY_DB;
assert.ok(dbPath && path.isAbsolute(dbPath), 'HOMEASY_RECOVERY_DB must be an absolute path');
const apply = process.argv.includes('--apply');
if (path.resolve(dbPath) === '/app/data/homeasy.db') {
  assert.ok(!apply || process.argv.includes('--live'), 'Live DB write requires --live');
}

const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const rowSql = `SELECT l.id,l.property_id,l.status,l.bedrooms,l.bathrooms,l.listing_facts_json,
  p.bedrooms property_bedrooms,p.bathrooms property_bathrooms,
  (SELECT COUNT(*) FROM canonical_listings v WHERE v.property_id=l.property_id) property_links,
  (SELECT COUNT(*) FROM canonical_listing_source_occurrences v WHERE v.listing_id=l.id AND v.is_current=1) current_count,
  m.review_status,m.decision_origin,m.review_reason,o.source_item_id,o.is_current,
  s.source_type,s.raw_text,s.raw_payload_json,s.canonical_url
  FROM canonical_listings l JOIN canonical_properties p ON p.id=l.property_id
  JOIN canonical_listing_moderation m ON m.listing_id=l.id
  JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
  JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?`;

function planOne(id, sourceItemId) {
  const row = one(rowSql, id);
  assert.ok(row, `Canonical listing ${id} missing`);
  assert.equal(row.property_id, id, `${id} property changed`);
  assert.equal(row.property_links, 1, `${id} shared property changed`);
  assert.equal(row.source_item_id, sourceItemId, `${id} primary source changed`);
  assert.equal(row.current_count, 1, `${id} ambiguous current occurrence`);
  assert.equal(row.is_current, 1, `${id} primary is not current`);
  assert.equal(row.source_type, 'KHMER24', `${id} source type changed`);
  assert.equal(row.status, 'active', `${id} listing status changed`);
  assert.ok(/khmer24\.com/i.test(row.canonical_url), `${id} source is not Khmer24`);
  assert.ok(row.raw_text?.trim(), `${id} original text missing`);
  const payload = JSON.parse(row.raw_payload_json);
  const sourceTitle = typeof payload.listing?.source_title === 'string' ? payload.listing.source_title : '';
  const rooms = sourceRoomCounts(`${sourceTitle}\n${row.raw_text}`);
  assert.equal(rooms.conflictingBedrooms, false, `${id} conflicting original bedrooms`);
  assert.equal(rooms.conflictingBathrooms, false, `${id} conflicting original bathrooms`);
  assert.ok(rooms.bedrooms !== null || rooms.bathrooms !== null, `${id} no rooms proved by source`);
  const facts = JSON.parse(row.listing_facts_json || '{}');
  assert.ok(facts && typeof facts === 'object' && !Array.isArray(facts), `${id} facts malformed`);
  const next = { ...facts };
  for (const kind of ['bedrooms', 'bathrooms']) {
    const value = rooms[kind];
    if (value === null) continue;
    for (const [field, existing] of [[`canonical.${kind}`, row[kind]], [`property.${kind}`, row[`property_${kind}`]], [`facts.${kind}`, next[kind]]]) {
      assert.ok(existing == null || existing === value, `${id} ${field} contradicts original ${value}`);
    }
    next[kind] = value;
  }
  const update = row.bedrooms !== (rooms.bedrooms ?? row.bedrooms)
    || row.bathrooms !== (rooms.bathrooms ?? row.bathrooms)
    || row.property_bedrooms !== (rooms.bedrooms ?? row.property_bedrooms)
    || row.property_bathrooms !== (rooms.bathrooms ?? row.property_bathrooms)
    || next.bedrooms !== facts.bedrooms || next.bathrooms !== facts.bathrooms;
  // A routine scraper pass may have auto-approved these listings after the v3
  // deployment. Restore source-confirmed facts there too, preserving that
  // automated decision. Never rewrite human decisions or review exceptions.
  const eligible = row.review_status === 'pending' && row.decision_origin === 'DEFAULT_PENDING' && !row.review_reason;
  const autoApproved = row.review_status === 'approved' && row.decision_origin === 'INGESTION_VALIDATED_V1' && !row.review_reason;
  assert.ok(!update || eligible || autoApproved, `${id} needs facts repair but moderation has a protected decision`);
  return { id, sourceItemId, rooms: { bedrooms: rooms.bedrooms, bathrooms: rooms.bathrooms },
    row, next, update, eligible };
}

try {
  assert.equal(one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
  if (apply) db.exec('BEGIN IMMEDIATE');
  try {
    const plans = [...SOURCES].map(([id, sourceItemId]) => planOne(id, sourceItemId));
    const recovery = plans.filter(p => p.update);
    if (apply) {
      for (const p of recovery) {
        const bedrooms = p.rooms.bedrooms ?? p.row.bedrooms;
        const bathrooms = p.rooms.bathrooms ?? p.row.bathrooms;
        assert.equal(run(`UPDATE canonical_listings SET bedrooms=?,bathrooms=?,listing_facts_json=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL AND bathrooms IS NULL`,
          bedrooms, bathrooms, JSON.stringify(p.next), p.id).changes, 1, `${p.id} canonical changed concurrently`);
        assert.equal(run(`UPDATE canonical_properties SET bedrooms=?,bathrooms=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND bedrooms IS NULL AND bathrooms IS NULL`,
          bedrooms, bathrooms, p.id).changes, 1, `${p.id} property changed concurrently`);
      }
    }
    const moderation = apply ? reviewDefaultPending(db, plans.map(p => p.id).filter(id =>
      plans.some(p => p.id === id && p.eligible))) : null;
    if (apply) {
      assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok');
      assert.equal(all('PRAGMA foreign_key_check').length, 0);
      db.exec('COMMIT');
    }
    console.log(JSON.stringify({ path: dbPath, applied: apply, count: plans.length,
      repaired: recovery.map(p => p.id),
      unchanged: plans.filter(p => !p.update).map(p => p.id),
      evidence: plans.map(p => ({ id: p.id, sourceItemId: p.sourceItemId, ...p.rooms,
        reviewStatusBefore: p.row.review_status })),
      moderation, integrity: 'ok', foreignKeyErrors: 0 }, null, 2));
  } catch (error) { if (apply) db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }
