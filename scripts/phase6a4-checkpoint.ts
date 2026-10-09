import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const dbPath = process.env.PHASE6A4_DB ?? 'data/backups/homeasy_phase6a4_precanary_20261007.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const legacy = snapshotLegacyProperties(db);
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM source_items) sourceItems,
    (SELECT COUNT(*) FROM source_item_versions) versions,
    (SELECT COUNT(*) FROM canonical_properties) canonicalProperties,
    (SELECT COUNT(*) FROM canonical_listings) canonicalListings,
    (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) currentOccurrences`).get();
  const refAudit = db.prepare(`SELECT COUNT(*) total, COUNT(DISTINCT public_ref) distinctRefs,
    SUM(CASE WHEN length(public_ref)=36 AND substr(public_ref,1,4)='lst_' AND substr(public_ref,5) NOT GLOB '*[^0-9a-f]*' THEN 1 ELSE 0 END) wellFormed
    FROM canonical_listings`).get();
  const aliasAudit = db.prepare(`SELECT
    (SELECT COUNT(*) FROM (SELECT namespace,alias FROM canonical_listing_aliases GROUP BY 1,2 HAVING COUNT(*)>1)) duplicateAliases,
    (SELECT COUNT(*) FROM canonical_listing_aliases a LEFT JOIN canonical_listings l ON l.id=a.listing_id WHERE l.id IS NULL) danglingAliases,
    (SELECT COUNT(*) FROM (SELECT source_item_id,source_entity_key FROM canonical_listing_source_occurrences WHERE is_current=1 GROUP BY 1,2 HAVING COUNT(*)>1)) duplicateCurrentBindings`).get();
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  const checkpoint = {
    generatedAt: new Date().toISOString(), dbPath,
    legacy: { ...legacy, baselineCount: 390, baselineDigest: '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272', matchesBaseline: legacy.count === 390 && legacy.digest === '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272' },
    counts, refAudit, aliasAudit, integrity, foreignKeys,
    backupSha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
  };
  writeFileSync('reports/phase6a4-checkpoint-20261007.json', JSON.stringify(checkpoint, null, 2) + '\n');
  console.log(JSON.stringify(checkpoint, null, 2));
  const values = counts as { sourceItems: number; versions: number; canonicalProperties: number; canonicalListings: number; currentOccurrences: number };
  const refs = refAudit as { total: number; distinctRefs: number; wellFormed: number };
  const aliases = aliasAudit as { duplicateAliases: number; danglingAliases: number; duplicateCurrentBindings: number };
  if (!checkpoint.legacy.matchesBaseline || values.sourceItems !== 1257 || values.versions !== 1939
    || values.canonicalProperties !== 465 || values.canonicalListings !== 465 || values.currentOccurrences !== 733
    || refs.total !== 465 || refs.distinctRefs !== 465 || refs.wellFormed !== 465
    || aliases.duplicateAliases || aliases.danglingAliases || aliases.duplicateCurrentBindings
    || (integrity[0] as { integrity_check?: string }).integrity_check !== 'ok' || foreignKeys.length) {
    throw new Error('Phase 6A.4 checkpoint validation failed');
  }
} finally {
  db.close();
}
