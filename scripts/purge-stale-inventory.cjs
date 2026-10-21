// Usage (inside the API Docker container, with the shared database volume):
// node - --db=/app/data/... --cutoff=ISO8601 --apply < scripts/purge-stale-inventory.cjs
// Omit --apply to rehearse the complete write transaction and roll it back.
const { DatabaseSync } = require('node:sqlite');

const args = Object.fromEntries(process.argv.slice(2).filter(s => s.startsWith('--') && s.includes('='))
  .map(s => s.slice(2).split(/=(.*)/s).slice(0, 2)));
const apply = process.argv.includes('--apply');
// One-time evidence-backed correction of historical Khmer24 records. Their
// legacy import stored the Homeasy import date in place of the original
// publication date; the live Camoufox detail scrape confirmed both originals.
const repairProvenKhmer24LegacyDates = process.argv.includes('--repair-proven-k24-legacy-dates');
const dbFile = args.db;
const cutoff = args.cutoff;
if (!dbFile || !cutoff || !Number.isFinite(Date.parse(cutoff))) {
  throw new Error('Required --db=ABSOLUTE_PATH and --cutoff=ISO8601');
}
if (apply && dbFile !== '/app/data/homeasy.db') {
  throw new Error('Live apply is only valid inside the API container');
}
const db = new DatabaseSync(dbFile, {timeout:10000});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const count = name => db.prepare('SELECT COUNT(*) AS n FROM '+name).get().n;
const query = (sql, ...values) => db.prepare(sql).run(...values).changes;
const totalBefore = {
  listings: count('canonical_listings'), legacy: count('properties'),
  sources: count('source_items'),
  pending: db.prepare("SELECT COUNT(*) n FROM canonical_listing_moderation WHERE review_status='pending'").get().n,
};
const expected = args.expect ? JSON.parse(args.expect) : null;
if (apply && (!expected || Object.keys(totalBefore).some(k => totalBefore[k] !== expected[k]))) {
  throw new Error('Inventory changed after rehearsal; abort live purge and repeat with fresh snapshot');
}
db.exec('BEGIN IMMEDIATE');
try {
  if (repairProvenKhmer24LegacyDates) {
    const corrections = [
      {source:2630, occurrence:316, listing:149, external:'adid:13006549',
        mistaken:'2026-10-05T01:02:48Z', original:'2025-12-28T06:12:24Z'},
      {source:2663, occurrence:686, listing:389, external:'adid:13609422',
        mistaken:'2026-10-07T05:30:32Z', original:'2026-06-05T02:27:53Z'},
    ];
    const statement = db.prepare(`SELECT s.source_type,s.external_id,s.published_at,
      o.id occurrence_id,o.listing_id,o.posted_at,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences x
        WHERE x.source_item_id=s.id) source_links,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences x
        WHERE x.listing_id=o.listing_id) listing_links
      FROM source_items s JOIN canonical_listing_source_occurrences o
        ON o.source_item_id=s.id WHERE s.id=?`);
    for (const c of corrections) {
      const rows = statement.all(c.source);
      const row = rows.length === 1 ? rows[0] : null;
      if (!row || row.source_type !== 'KHMER24' || row.external_id !== c.external ||
          row.published_at !== c.mistaken || row.posted_at !== c.mistaken ||
          row.occurrence_id !== c.occurrence || row.listing_id !== c.listing ||
          row.source_links !== 1 || row.listing_links !== 1) {
        throw new Error('Legacy Khmer24 original-date repair evidence changed for '+c.external);
      }
      if (query('UPDATE source_items SET published_at=? WHERE id=?',c.original,c.source)!==1 ||
          query('UPDATE canonical_listing_source_occurrences SET posted_at=? WHERE id=?',c.original,c.occurrence)!==1) {
        throw new Error('Could not repair confirmed original date for '+c.external);
      }
    }
    console.log('Repaired two source-confirmed Khmer24 original timestamps inside pending purge transaction');
  }
  db.prepare(`CREATE TEMP TABLE purge_listings AS
    SELECT l.id,l.property_id FROM canonical_listings l
    WHERE (SELECT MIN(COALESCE(julianday(o.posted_at),julianday(s.published_at)))
      FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
      WHERE o.listing_id=l.id) < julianday(?)
      AND NOT EXISTS(SELECT 1 FROM canonical_listing_source_occurrences o
        WHERE o.listing_id=l.id AND julianday(o.content_changed_at)>=julianday(?))`).run(cutoff,cutoff);
  db.prepare(`CREATE TEMP TABLE purge_legacy AS SELECT id FROM properties
    WHERE COALESCE(julianday(posted_at),julianday(created_at)) < julianday(?)`).run(cutoff);
  db.exec(`CREATE TEMP TABLE purge_occurrences AS
    SELECT id FROM canonical_listing_source_occurrences WHERE listing_id IN (SELECT id FROM purge_listings);
    CREATE TEMP TABLE purge_canonical_properties AS
    SELECT DISTINCT property_id AS id FROM purge_listings p WHERE NOT EXISTS
      (SELECT 1 FROM canonical_listings l WHERE l.property_id=p.property_id
        AND l.id NOT IN(SELECT id FROM purge_listings));
    CREATE TEMP TABLE purge_sources AS
    SELECT s.id FROM source_items s WHERE julianday(s.published_at)<julianday('${cutoff.replace(/'/g,"''")}')
      AND NOT EXISTS (SELECT 1 FROM canonical_listing_source_occurrences o
        WHERE o.source_item_id=s.id AND o.id NOT IN (SELECT id FROM purge_occurrences));
    CREATE TEMP TABLE purge_clusters AS SELECT c.id FROM dedupe_clusters c
      WHERE NOT EXISTS(SELECT 1 FROM dedupe_cluster_members m WHERE m.cluster_id=c.id
        AND m.source_item_id NOT IN(SELECT id FROM purge_sources))
      AND (c.representative_source_item_id IN(SELECT id FROM purge_sources)
        OR EXISTS(SELECT 1 FROM dedupe_cluster_members m WHERE m.cluster_id=c.id
          AND m.source_item_id IN(SELECT id FROM purge_sources)));
    CREATE TEMP TABLE purge_asset_links AS SELECT id FROM media_asset_source_occurrences
      WHERE source_item_id IN(SELECT id FROM purge_sources)
        OR source_occurrence_id IN(SELECT id FROM purge_occurrences)
        OR listing_id IN(SELECT id FROM purge_listings)
        OR property_id IN(SELECT id FROM purge_canonical_properties);
    CREATE TEMP TABLE purge_assets AS SELECT a.id FROM media_assets a
      WHERE (a.source_item_id IN(SELECT id FROM purge_sources)
        OR a.source_occurrence_id IN(SELECT id FROM purge_occurrences)
        OR a.listing_id IN(SELECT id FROM purge_listings)
        OR a.property_id IN(SELECT id FROM purge_canonical_properties))
      AND NOT EXISTS (SELECT 1 FROM media_asset_source_occurrences m WHERE m.media_asset_id=a.id
        AND m.id NOT IN(SELECT id FROM purge_asset_links));`);
  const selected = Object.fromEntries(['purge_listings','purge_legacy','purge_occurrences',
    'purge_sources','purge_canonical_properties','purge_clusters','purge_asset_links','purge_assets']
    .map(k=>[k,count(k)]));

  query('DELETE FROM availability_checks WHERE listing_id IN(SELECT id FROM purge_listings) OR source_occurrence_id IN(SELECT id FROM purge_occurrences)');
  query('DELETE FROM freshness_jobs WHERE listing_id IN(SELECT id FROM purge_listings) OR source_occurrence_id IN(SELECT id FROM purge_occurrences)');
  query('DELETE FROM media_asset_source_occurrences WHERE id IN(SELECT id FROM purge_asset_links) OR media_asset_id IN(SELECT id FROM purge_assets)');
  query('DELETE FROM media_assets WHERE id IN(SELECT id FROM purge_assets)');
  // Shared assets remain attached to surviving sources; clear references to deleted entities.
  query(`UPDATE media_assets SET
    source_item_id=CASE WHEN source_item_id IN(SELECT id FROM purge_sources) THEN NULL ELSE source_item_id END,
    source_occurrence_id=CASE WHEN source_occurrence_id IN(SELECT id FROM purge_occurrences) THEN NULL ELSE source_occurrence_id END,
    listing_id=CASE WHEN listing_id IN(SELECT id FROM purge_listings) THEN NULL ELSE listing_id END,
    property_id=CASE WHEN property_id IN(SELECT id FROM purge_canonical_properties) THEN NULL ELSE property_id END
    WHERE source_item_id IN(SELECT id FROM purge_sources)
      OR source_occurrence_id IN(SELECT id FROM purge_occurrences)
      OR listing_id IN(SELECT id FROM purge_listings)
      OR property_id IN(SELECT id FROM purge_canonical_properties)`);
  query('DELETE FROM canonical_listing_source_occurrences WHERE id IN(SELECT id FROM purge_occurrences)');
  query('DELETE FROM canonical_listings WHERE id IN(SELECT id FROM purge_listings)');
  query('DELETE FROM canonical_properties WHERE id IN(SELECT id FROM purge_canonical_properties)');
  query('DELETE FROM properties WHERE id IN(SELECT id FROM purge_legacy)');
  query('DELETE FROM ai_processing_results WHERE source_item_id IN(SELECT id FROM purge_sources)');
  query('DELETE FROM demand_source_occurrences WHERE source_item_id IN(SELECT id FROM purge_sources)');
  query('DELETE FROM source_item_identifiers WHERE source_item_id IN(SELECT id FROM purge_sources)');
  query('DELETE FROM source_item_versions WHERE source_item_id IN(SELECT id FROM purge_sources)');
  query('DELETE FROM dedupe_cluster_members WHERE source_item_id IN(SELECT id FROM purge_sources) OR cluster_id IN(SELECT id FROM purge_clusters)');
  query('DELETE FROM dedupe_clusters WHERE id IN(SELECT id FROM purge_clusters)');
  query(`UPDATE dedupe_clusters SET representative_source_item_id=(
      SELECT m.source_item_id FROM dedupe_cluster_members m
      WHERE m.cluster_id=dedupe_clusters.id ORDER BY m.id LIMIT 1)
    WHERE representative_source_item_id IN(SELECT id FROM purge_sources)`);
  query('DELETE FROM source_items WHERE id IN(SELECT id FROM purge_sources)');

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  const integrity = db.prepare('PRAGMA quick_check').get();
  const totalAfter = {
    listings: count('canonical_listings'), legacy: count('properties'),
    sources: count('source_items'),
    pending: db.prepare("SELECT COUNT(*) n FROM canonical_listing_moderation WHERE review_status='pending'").get().n,
  };
  if (fk.length || integrity.quick_check!=='ok') throw new Error('Database integrity failed: '+JSON.stringify({fk:fk.length,integrity}));
  console.log(JSON.stringify({mode:apply?'applied':'rehearsed',cutoff,totalBefore,selected,totalAfter,
    integrity:integrity.quick_check,foreignKeys:fk.length}));
  db.exec(apply?'COMMIT':'ROLLBACK');
} catch (error) {
  try {db.exec('ROLLBACK');} catch {}
  throw error;
} finally {db.close();}
