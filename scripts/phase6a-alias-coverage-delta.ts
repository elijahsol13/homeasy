/** Read-only identity coverage comparison across two detached Phase 6a SQLite snapshots. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertiesRepository } from '../src/database/repositories/properties.repo';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { measureAliasIdentityCoverage } from '../src/database/canonical-alias-parity';

const beforeInput = process.env.PHASE6A_BEFORE_DB;
const afterInput = process.env.PHASE6A_AFTER_DB;
if (!beforeInput || !afterInput || !existsSync(beforeInput) || !existsSync(afterInput)) {
  throw new Error('Set PHASE6A_BEFORE_DB and PHASE6A_AFTER_DB to existing detached SQLite snapshots');
}
const beforePath = realpathSync(beforeInput);
const afterPath = realpathSync(afterInput);
const livePath = resolve('data/homeasy.db');
const liveRealPath = existsSync(livePath) ? realpathSync(livePath) : livePath;
if (beforePath === afterPath || [beforePath, afterPath].some((path) => path === livePath || path === liveRealPath)) {
  throw new Error('Refusing live DB path or comparison of a snapshot with itself');
}

function sorted(values: readonly number[]) { return [...values].sort((a, b) => a - b); }

function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const legacy = new PropertiesRepository(db).searchProperties({ city: 'siem_reap', type: 'rent', limit: 100 });
    const canonical = new CanonicalListingRepository(db).searchProperties({ city: 'siem_reap', type: 'rent', limit: 500 });
    if (legacy.total !== legacy.items.length || canonical.total !== canonical.items.length) {
      throw new Error('Pagination truncated the parity cohort: increase the query limits');
    }
    const legacyIds = legacy.items.map((item) => item.id);
    const canonicalIds = canonical.items.map((item) => item.id);
    const coverage = measureAliasIdentityCoverage(db, legacyIds, canonicalIds);
    const lookup = db.prepare(`SELECT listing_id FROM canonical_listing_aliases
      WHERE namespace='legacy_property_id' AND alias=?`);
    const resolvedMappings = legacyIds.flatMap((legacyId) => {
      const row = lookup.get(String(legacyId)) as { listing_id: number } | undefined;
      return row ? [{ legacyId, listingId: row.listing_id }] : [];
    });
    return {
      path, legacyIds: sorted(legacyIds), canonicalIds: sorted(canonicalIds),
      resolvedMappings, coverage, legacyTotal: legacy.total, canonicalTotal: canonical.total,
    };
  } finally {
    db.close();
  }
}

const before = inspect(beforePath);
const after = inspect(afterPath);
if (JSON.stringify(before.legacyIds) !== JSON.stringify(after.legacyIds)
  || JSON.stringify(before.canonicalIds) !== JSON.stringify(after.canonicalIds)) {
  throw new Error('Before/after listing cohorts differ; identity coverage delta is not comparable');
}
const originalMappings = new Map(before.resolvedMappings.map((item) => [item.legacyId, item.listingId]));
const latestMappings = new Map(after.resolvedMappings.map((item) => [item.legacyId, item.listingId]));
for (const [legacyId, listingId] of originalMappings) {
  if (latestMappings.get(legacyId) !== listingId) {
    throw new Error(`Existing legacy alias ${legacyId} was removed or remapped`);
  }
}
const newMappings = after.resolvedMappings.filter((item) => !originalMappings.has(item.legacyId));
const counts = (value: typeof before) => ({
  legacyCards: value.coverage.legacyCards,
  canonicalCards: value.canonicalTotal,
  resolvedAliases: value.coverage.resolvedAliases,
  visibleResolvedCards: value.coverage.visibleResolvedCards,
  visibleDistinctCanonicalListings: value.coverage.visibleDistinctCanonicalListings,
  duplicateLegacyCardsCollapsingToVisibleListing: value.coverage.duplicateLegacyCardsCollapsingToVisibleListing,
  resolvedButNotInCanonicalQuery: sorted(value.coverage.resolvedButNotInCanonicalQuery),
  unresolvedLegacyIds: sorted(value.coverage.unresolvedLegacyIds),
});
const report = {
  generatedAt: new Date().toISOString(),
  scope: 'Siem Reap rental cards; explicit legacy_property_id namespace only. Measures identity mapping, not semantic or UI parity.',
  before: { database: before.path, ...counts(before) },
  after: { database: after.path, ...counts(after) },
  difference: {
    additionalResolvedAliases: after.coverage.resolvedAliases - before.coverage.resolvedAliases,
    additionalVisibleResolvedCards: after.coverage.visibleResolvedCards - before.coverage.visibleResolvedCards,
    additionalDistinctCanonicalListings: after.coverage.visibleDistinctCanonicalListings - before.coverage.visibleDistinctCanonicalListings,
    newMappings,
  },
  checks: { sameLegacyCardIds: true, sameCanonicalCardIds: true, existingAliasesPreserved: true, liveDatabaseUntouched: true },
};
const outputPath = process.env.PHASE6A_ALIAS_REPORT;
if (outputPath) {
  if (existsSync(outputPath)) throw new Error('Refusing to overwrite an existing alias delta report');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(report, null, 2));
