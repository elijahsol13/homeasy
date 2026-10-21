import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertLegacyPropertiesUnchanged, snapshotLegacyProperties } from '../src/database/legacy-write-guard';
import { stableMediaHash } from '../src/modules/parser/media-identity';

const requestedPath = path.resolve(process.argv[2] ?? '');
const rebuildRoot = path.resolve('data/rebuild') + path.sep;
if (!requestedPath.startsWith(rebuildRoot)) {
  throw new Error('Refusing to touch a database outside data/rebuild');
}

const db = new DatabaseSync(requestedPath);
db.exec('PRAGMA foreign_keys = ON');

function count(sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

function verifyIntegrity(): void {
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`Working DB integrity failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error(`Working DB has ${foreignKeys.length} foreign-key violations`);
}

verifyIntegrity();
const legacyBefore = snapshotLegacyProperties(db);
if (legacyBefore.count !== 390 || legacyBefore.digest !== '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272') {
  throw new Error(`Unexpected legacy baseline: ${JSON.stringify(legacyBefore)}`);
}

const run = db.prepare('SELECT started_at FROM processing_runs WHERE id = 15').get() as { started_at: string } | undefined;
if (!run) throw new Error('Expected second Facebook ingestion run 15');
const runStartedAt = run.started_at;
const oldItems = db.prepare(`SELECT id,external_id FROM source_items WHERE processing_run_id=15 AND created_at<? ORDER BY id`)
  .all(runStartedAt) as Array<{ id: number; external_id: string }>;
const newItems = db.prepare(`SELECT id,external_id FROM source_items WHERE processing_run_id=15 AND created_at>=? ORDER BY id`)
  .all(runStartedAt) as Array<{ id: number; external_id: string }>;
const falseVersions = db.prepare(`SELECT v.id,v.source_item_id FROM source_item_versions v
  JOIN source_items i ON i.id=v.source_item_id
  WHERE i.processing_run_id=15 AND i.created_at<? AND v.created_at>=?
  ORDER BY v.id`).all(runStartedAt, runStartedAt) as Array<{ id: number; source_item_id: number }>;
if (oldItems.length !== 28 || newItems.length !== 2 || falseVersions.length !== 28) {
  throw new Error(`Unexpected run 15 repair scope: old=${oldItems.length}, new=${newItems.length}, falseVersions=${falseVersions.length}`);
}

const payloadPhotos = (payload: unknown): string[] => {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const photos = Array.isArray(record.photos) ? record.photos.filter((value): value is string => typeof value === 'string') : [];
  const assets = Array.isArray(record.photoAssets) ? record.photoAssets.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const url = (value as Record<string, unknown>).url;
    return typeof url === 'string' ? [url] : [];
  }) : [];
  return [...photos, ...assets];
};

const restore = db.prepare(`UPDATE source_items SET raw_text=?,raw_payload_json=?,content_hash=?,media_hash=?,classification=?,
  last_seen_at=?,processing_run_id=14,updated_at=? WHERE id=?`);
const restoreOccurrence = db.prepare(`UPDATE canonical_listing_source_occurrences SET content_hash=?,media_hash=?,last_seen_at=?,updated_at=?
  WHERE source_item_id=? AND is_current=1`);
const deleteFalseVersion = db.prepare('DELETE FROM source_item_versions WHERE id=?');

db.exec('BEGIN IMMEDIATE');
try {
  for (const item of oldItems) {
    const prior = db.prepare(`SELECT content_hash,raw_text,raw_payload_json,observed_at,created_at
      FROM source_item_versions WHERE source_item_id=? AND created_at<? ORDER BY id DESC LIMIT 1`)
      .get(item.id, runStartedAt) as { content_hash: string | null; raw_text: string | null; raw_payload_json: string; observed_at: string; created_at: string } | undefined;
    if (!prior) throw new Error(`Missing pre-run version for source item ${item.external_id}`);
    const payload = JSON.parse(prior.raw_payload_json) as Record<string, unknown>;
    const mediaHash = stableMediaHash(payloadPhotos(payload));
    restore.run(prior.raw_text ?? String(payload.content ?? ''), prior.raw_payload_json, prior.content_hash, mediaHash,
      typeof payload.classification === 'string' ? payload.classification : null, prior.observed_at, prior.created_at, item.id);
    restoreOccurrence.run(prior.content_hash, mediaHash, prior.observed_at, prior.created_at, item.id);
  }
  for (const version of falseVersions) deleteFalseVersion.run(version.id);

  const newIds = newItems.map(({ id }) => id);
  const placeholders = newIds.map(() => '?').join(',');
  const listings = db.prepare(`SELECT DISTINCT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id IN (${placeholders}) AND listing_id IS NOT NULL`)
    .all(...newIds) as Array<{ listing_id: number }>;
  const listingIds = listings.map(({ listing_id }) => listing_id);
  const properties = listingIds.length
    ? db.prepare(`SELECT DISTINCT property_id FROM canonical_listings WHERE id IN (${listingIds.map(() => '?').join(',')})`).all(...listingIds) as Array<{ property_id: number }>
    : [];
  const propertyIds = properties.map(({ property_id }) => property_id);
  const occurrences = db.prepare(`SELECT id FROM canonical_listing_source_occurrences WHERE source_item_id IN (${placeholders})`)
    .all(...newIds) as Array<{ id: number }>;
  const occurrenceIds = occurrences.map(({ id }) => id);

  const clusters = new Map<number, { remaining: number[]; representative: number }>();
  const clusterRows = db.prepare(`SELECT id,representative_source_item_id FROM dedupe_clusters WHERE representative_source_item_id IN (${placeholders})`)
    .all(...newIds) as Array<{ id: number; representative_source_item_id: number }>;
  const memberRows = db.prepare(`SELECT DISTINCT c.id,c.representative_source_item_id,m.source_item_id FROM dedupe_clusters c
    JOIN dedupe_cluster_members m ON m.cluster_id=c.id WHERE m.source_item_id IN (${placeholders})`)
    .all(...newIds) as Array<{ id: number; representative_source_item_id: number; source_item_id: number }>;
  for (const row of [...clusterRows, ...memberRows]) {
    if (!clusters.has(row.id)) clusters.set(row.id, { remaining: [], representative: row.representative_source_item_id });
  }
  for (const [clusterId, state] of clusters) {
    state.remaining = (db.prepare('SELECT source_item_id FROM dedupe_cluster_members WHERE cluster_id=?').all(clusterId) as Array<{ source_item_id: number }>)
      .map(({ source_item_id }) => source_item_id).filter((id) => !newIds.includes(id));
    db.prepare(`DELETE FROM dedupe_cluster_members WHERE cluster_id=? AND source_item_id IN (${placeholders})`).run(clusterId, ...newIds);
    if (state.remaining.length) {
      if (newIds.includes(state.representative)) db.prepare('UPDATE dedupe_clusters SET representative_source_item_id=? WHERE id=?').run(state.remaining[0], clusterId);
    } else {
      db.prepare('DELETE FROM dedupe_cluster_members WHERE cluster_id=?').run(clusterId);
      db.prepare('DELETE FROM dedupe_clusters WHERE id=?').run(clusterId);
    }
  }

  db.prepare(`DELETE FROM media_asset_source_occurrences WHERE source_item_id IN (${placeholders})`).run(...newIds);
  if (occurrenceIds.length) db.prepare(`DELETE FROM media_asset_source_occurrences WHERE source_occurrence_id IN (${occurrenceIds.map(() => '?').join(',')})`).run(...occurrenceIds);
  if (listingIds.length) db.prepare(`DELETE FROM media_asset_source_occurrences WHERE listing_id IN (${listingIds.map(() => '?').join(',')})`).run(...listingIds);
  if (propertyIds.length) db.prepare(`DELETE FROM media_asset_source_occurrences WHERE property_id IN (${propertyIds.map(() => '?').join(',')})`).run(...propertyIds);

  const mediaAssetWhere = [`source_item_id IN (${placeholders})`];
  const mediaAssetParams: Array<number> = [...newIds];
  if (listingIds.length) { mediaAssetWhere.push(`listing_id IN (${listingIds.map(() => '?').join(',')})`); mediaAssetParams.push(...listingIds); }
  if (propertyIds.length) { mediaAssetWhere.push(`property_id IN (${propertyIds.map(() => '?').join(',')})`); mediaAssetParams.push(...propertyIds); }
  const assetIds = (db.prepare(`SELECT id FROM media_assets WHERE ${mediaAssetWhere.join(' OR ')}`).all(...mediaAssetParams) as Array<{ id: number }>).map(({ id }) => id);
  if (assetIds.length) {
    const otherAssociations = db.prepare(`SELECT COUNT(*) AS count FROM media_asset_source_occurrences
      WHERE media_asset_id IN (${assetIds.map(() => '?').join(',')}) AND source_item_id NOT IN (${placeholders})`)
      .get(...assetIds, ...newIds) as { count: number };
    if (otherAssociations.count) throw new Error('Refusing to remove media assets still associated with other source items');
    db.prepare(`DELETE FROM media_assets WHERE id IN (${assetIds.map(() => '?').join(',')})`).run(...assetIds);
  }

  if (occurrenceIds.length) {
    db.prepare(`DELETE FROM availability_checks WHERE source_occurrence_id IN (${occurrenceIds.map(() => '?').join(',')})`).run(...occurrenceIds);
    db.prepare(`DELETE FROM freshness_jobs WHERE source_occurrence_id IN (${occurrenceIds.map(() => '?').join(',')})`).run(...occurrenceIds);
  }
  db.prepare(`DELETE FROM ai_processing_results WHERE source_item_id IN (${placeholders})`).run(...newIds);
  db.prepare(`DELETE FROM source_item_identifiers WHERE source_item_id IN (${placeholders})`).run(...newIds);
  db.prepare(`DELETE FROM demand_source_occurrences WHERE source_item_id IN (${placeholders})`).run(...newIds);
  if (occurrenceIds.length) db.prepare(`DELETE FROM canonical_listing_source_occurrences WHERE id IN (${occurrenceIds.map(() => '?').join(',')})`).run(...occurrenceIds);
  db.prepare(`DELETE FROM source_item_versions WHERE source_item_id IN (${placeholders})`).run(...newIds);
  db.prepare(`DELETE FROM source_items WHERE id IN (${placeholders})`).run(...newIds);

  for (const listingId of listingIds) {
    if (count('SELECT COUNT(*) AS count FROM canonical_listing_source_occurrences WHERE listing_id=?', listingId) !== 0) {
      throw new Error(`Refusing to remove listing ${listingId}; it still has source occurrences`);
    }
    db.prepare('DELETE FROM canonical_listings WHERE id=?').run(listingId);
  }
  for (const propertyId of propertyIds) {
    if (count('SELECT COUNT(*) AS count FROM canonical_listings WHERE property_id=?', propertyId) !== 0) {
      throw new Error(`Refusing to remove property ${propertyId}; it still has listings`);
    }
    db.prepare('DELETE FROM canonical_properties WHERE id=?').run(propertyId);
  }

  const fbSources = db.prepare(`SELECT id,raw_payload_json FROM source_items WHERE source_type='FACEBOOK_GROUP'`).all() as Array<{ id: number; raw_payload_json: string }>;
  const updateItemMedia = db.prepare('UPDATE source_items SET media_hash=? WHERE id=?');
  for (const item of fbSources) {
    const payload = JSON.parse(item.raw_payload_json) as Record<string, unknown>;
    updateItemMedia.run(stableMediaHash(payloadPhotos(payload)), item.id);
  }
  const fbVersions = db.prepare(`SELECT v.id,v.raw_payload_json FROM source_item_versions v
    JOIN source_items i ON i.id=v.source_item_id WHERE i.source_type='FACEBOOK_GROUP'`).all() as Array<{ id: number; raw_payload_json: string }>;
  const updateVersionMedia = db.prepare('UPDATE source_item_versions SET media_hash=? WHERE id=?');
  for (const version of fbVersions) {
    const payload = JSON.parse(version.raw_payload_json) as Record<string, unknown>;
    updateVersionMedia.run(stableMediaHash(payloadPhotos(payload)), version.id);
  }
  db.exec(`UPDATE canonical_listing_source_occurrences SET media_hash=(
    SELECT si.media_hash FROM source_items si WHERE si.id=canonical_listing_source_occurrences.source_item_id
  ) WHERE is_current=1 AND source_item_id IN (SELECT id FROM source_items WHERE source_type='FACEBOOK_GROUP')`);

  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

assertLegacyPropertiesUnchanged(db, legacyBefore);
verifyIntegrity();
const report = {
  target: requestedPath,
  restoredExistingItems: oldItems.length,
  deletedFalseMediaVersions: falseVersions.length,
  removedRun15NewItems: newItems.map(({ external_id }) => external_id),
  sourceItems: count('SELECT COUNT(*) AS count FROM source_items'),
  versions: count('SELECT COUNT(*) AS count FROM source_item_versions'),
  canonicalProperties: count('SELECT COUNT(*) AS count FROM canonical_properties'),
  canonicalListings: count('SELECT COUNT(*) AS count FROM canonical_listings'),
  currentOccurrences: count('SELECT COUNT(*) AS count FROM canonical_listing_source_occurrences WHERE is_current=1'),
  historicalOccurrences: count('SELECT COUNT(*) AS count FROM canonical_listing_source_occurrences WHERE is_current=0'),
  legacyProperties: legacyBefore.count,
  legacyDigest: legacyBefore.digest,
  integrity: 'ok',
  foreignKeyViolations: 0,
};
console.log(JSON.stringify(report, null, 2));
db.close();
