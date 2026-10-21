import type { DatabaseSync } from 'node:sqlite';

/** Distinct from the one-to-one URL/content comparator: many legacy IDs may refer to one listing. */
export function measureAliasIdentityCoverage(
  db: DatabaseSync,
  legacyIds: readonly number[],
  visibleCanonicalListingIds: readonly number[],
) {
  const visible = new Set(visibleCanonicalListingIds);
  const resolve = db.prepare(`SELECT a.listing_id
    FROM canonical_listing_aliases a
    WHERE a.namespace='legacy_property_id' AND a.alias=?`);
  const resolved: Array<{ legacyId: number; listingId: number; visible: boolean }> = [];
  const unresolvedLegacyIds: number[] = [];
  for (const id of [...new Set(legacyIds)]) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid legacy listing ID ${id}`);
    const row = resolve.get(String(id)) as { listing_id: number } | undefined;
    if (!row) unresolvedLegacyIds.push(id);
    else resolved.push({ legacyId: id, listingId: row.listing_id, visible: visible.has(row.listing_id) });
  }
  const matchedVisible = resolved.filter((row) => row.visible);
  const visibleUnique = new Set(matchedVisible.map((row) => row.listingId));
  return {
    scope: 'authoritative legacy_property_id aliases for returned legacy cards; not a one-to-one semantic match',
    legacyCards: new Set(legacyIds).size,
    resolvedAliases: resolved.length,
    visibleResolvedCards: matchedVisible.length,
    visibleDistinctCanonicalListings: visibleUnique.size,
    duplicateLegacyCardsCollapsingToVisibleListing: matchedVisible.length - visibleUnique.size,
    resolvedButNotInCanonicalQuery: resolved.filter((row) => !row.visible).map((row) => row.legacyId),
    unresolvedLegacyIds,
    // Helpful for explicit review; no guessing from matching titles or numerical ID overlap.
    visibleResolutions: matchedVisible,
  };
}
