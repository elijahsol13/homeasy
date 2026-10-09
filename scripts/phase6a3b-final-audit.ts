import { writeFileSync } from 'node:fs';
import { createDatabase, closeDatabase } from '../src/database/db';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const targetPath = process.env.PHASE6A3_TARGET ?? 'data/homeasy.db';
const baselineCount = 390;
const baselineDigest = '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272';

function main(): void {
  const db = createDatabase(targetPath);
  try {
    const legacy = snapshotLegacyProperties(db);
    const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM source_items) sourceItems,
      (SELECT COUNT(*) FROM source_item_versions) versions,
      (SELECT COUNT(*) FROM canonical_properties) canonicalProperties,
      (SELECT COUNT(*) FROM canonical_listings) canonicalListings,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) currentOccurrences,
      (SELECT COUNT(*) FROM canonical_listing_moderation WHERE review_status='approved') approved,
      (SELECT COUNT(*) FROM canonical_listing_moderation WHERE review_status='pending') pending,
      (SELECT COUNT(*) FROM canonical_listing_moderation WHERE review_status='rejected') rejected`).get();
    const publicRefs = db.prepare(`SELECT COUNT(*) total,COUNT(public_ref) nonNull,COUNT(DISTINCT public_ref) distinctRefs,
      SUM(CASE WHEN length(public_ref)=36 AND substr(public_ref,1,4)='lst_' AND substr(public_ref,5) NOT GLOB '*[^0-9a-f]*' THEN 1 ELSE 0 END) wellFormed
      FROM canonical_listings`).get();
    const missingRefAliases = db.prepare(`SELECT COUNT(*) n FROM canonical_listings l WHERE NOT EXISTS(
      SELECT 1 FROM canonical_listing_aliases a WHERE a.namespace='public_listing_ref' AND a.alias=l.public_ref AND a.listing_id=l.id)`).get();
    const mismatchedRefAliases = db.prepare(`SELECT COUNT(*) n FROM canonical_listing_aliases a JOIN canonical_listings l
      ON a.namespace='public_listing_ref' AND a.alias=l.public_ref WHERE a.listing_id<>l.id`).get();
    const duplicateAliasKeys = db.prepare(`SELECT COUNT(*) n FROM (SELECT namespace,alias FROM canonical_listing_aliases GROUP BY 1,2 HAVING COUNT(*)>1)`).get();
    const danglingAliases = db.prepare(`SELECT COUNT(*) n FROM canonical_listing_aliases a LEFT JOIN canonical_listings l ON l.id=a.listing_id WHERE l.id IS NULL`).get();
    const duplicateCurrentBindings = db.prepare(`SELECT COUNT(*) n FROM (SELECT source_item_id,source_entity_key FROM canonical_listing_source_occurrences
      WHERE is_current=1 GROUP BY 1,2 HAVING COUNT(*)>1)`).get();
    const activeFreshness = db.prepare(`SELECT COUNT(*) n FROM freshness_jobs WHERE status IN ('QUEUED','RUNNING')`).get();
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>).map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const migration = db.prepare('SELECT MAX(version) version FROM schema_migrations').get();
    const report = {
      generatedAt: new Date().toISOString(), targetPath, migration,
      legacy: { count: legacy.count, digest: legacy.digest, expectedCount: baselineCount, expectedDigest: baselineDigest, unchanged: legacy.count === baselineCount && legacy.digest === baselineDigest },
      totals, publicRefs, missingRefAliases, mismatchedRefAliases, duplicateAliasKeys, danglingAliases, duplicateCurrentBindings, activeFreshness,
      integrity, foreignKeyViolations: foreignKeys,
      cutover: { listingReadPath: process.env.LISTING_READ_PATH ?? 'legacy', paidFreshnessExecution: process.env.PAID_FRESHNESS_EXECUTION === 'true' },
    };
    const out = 'reports/phase6a3b-final-audit-20261007.json';
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, legacy: report.legacy, totals, publicRefs, missingRefAliases, mismatchedRefAliases, duplicateAliasKeys, danglingAliases, duplicateCurrentBindings, activeFreshness, integrity, foreignKeyViolations: foreignKeys.length, cutover: report.cutover }, null, 2));
    const refs = publicRefs as { total: number; nonNull: number; distinctRefs: number; wellFormed: number };
    const scalar = (value: unknown) => Number((value as { n: number }).n);
    if (!report.legacy.unchanged || refs.total !== refs.nonNull || refs.total !== refs.distinctRefs || refs.total !== refs.wellFormed
      || scalar(missingRefAliases) !== 0 || scalar(mismatchedRefAliases) !== 0 || scalar(duplicateAliasKeys) !== 0 || scalar(danglingAliases) !== 0
      || scalar(duplicateCurrentBindings) !== 0 || scalar(activeFreshness) !== 0 || integrity.some((value) => value !== 'ok') || foreignKeys.length
      || report.cutover.listingReadPath !== 'legacy' || report.cutover.paidFreshnessExecution) throw new Error('Final Phase 6A.3b audit failed');
  } finally {
    closeDatabase(db);
  }
}

main();
