import { DatabaseSync } from 'node:sqlite';
import { measureAliasIdentityCoverage } from '../src/database/canonical-alias-parity';

describe('alias-aware canonical identity parity', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE canonical_listing_aliases(namespace TEXT NOT NULL,alias TEXT NOT NULL,listing_id INTEGER NOT NULL,
      PRIMARY KEY(namespace,alias));
      INSERT INTO canonical_listing_aliases VALUES
        ('legacy_property_id','12',55),('legacy_property_id','286',55),('legacy_property_id','19',381),
        ('canonical_listing_id','7',7);`);
  });
  afterEach(() => db.close());

  it('counts source duplicates as separate legacy cards but one visible canonical listing', () => {
    const result = measureAliasIdentityCoverage(db, [12, 286, 19, 165, 12], [55, 100]);
    expect(result).toMatchObject({legacyCards: 4, resolvedAliases: 3,
      visibleResolvedCards: 2, visibleDistinctCanonicalListings: 1,
      duplicateLegacyCardsCollapsingToVisibleListing: 1,
      resolvedButNotInCanonicalQuery: [19], unresolvedLegacyIds: [165]});
    expect(result.visibleResolutions).toEqual([
      { legacyId: 12, listingId: 55, visible: true }, { legacyId: 286, listingId: 55, visible: true },
    ]);
  });

  it('requires explicit legacy namespace and does not guess matching numeric IDs', () => {
    const result = measureAliasIdentityCoverage(db, [7, 165], [7, 55]);
    expect(result.resolvedAliases).toBe(0);
    expect(result.unresolvedLegacyIds).toEqual([7, 165]);
  });

  it('does not silently accept non-integer identifiers', () => {
    expect(() => measureAliasIdentityCoverage(db, [0], [])).toThrow('Invalid legacy listing ID');
  });
});
