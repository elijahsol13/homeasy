import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { FavoritesRepository } from '../src/database/repositories/favorites.repo';
import { ListingIdentityRepository } from '../src/database/repositories/listing-identity.repo';

describe('canonical favorites and legacy rollback', () => {
  let db: DatabaseSync;
  let favorites: FavoritesRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db);
    favorites = new FavoritesRepository(db);
    const identities = new ListingIdentityRepository(db);

    db.exec(`
      INSERT INTO users(id,telegram_id) VALUES (1,10001),(2,10002);
      INSERT INTO properties(id,hash,title,price,type,location,city)
        VALUES (123,'legacy-123','Legacy 123',10000,'rent','Wat Bo','siem_reap'),
               (124,'legacy-124','Legacy 124',11000,'rent','Wat Bo','siem_reap'),
               (999,'legacy-999','Unmapped',9000,'rent','Wat Bo','siem_reap');
      INSERT INTO canonical_listings(id,public_ref,title,first_seen_at,last_seen_at)
        VALUES (9,'lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Canonical nine','2026-01-01','2026-01-01'),
               (123,'lst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','Canonical 123','2026-01-01','2026-01-01');
      INSERT INTO user_favorites(user_id,property_id) VALUES (1,123),(1,124),(2,999);
    `);
    identities.register('legacy_property_id', 123, 9);
    identities.register('legacy_property_id', 124, 9);
    identities.register('canonical_listing_id', 123, 123);
  });

  afterEach(() => db.close());

  it('deduplicates legacy favorites and preserves separate numeric namespaces', () => {
    expect(favorites.getCanonicalFavoriteListingIds(1)).toEqual([9]);
    expect(favorites.isCanonicalFavorite(1, 9)).toBe(true);
    expect(favorites.isCanonicalFavorite(1, 123)).toBe(false);
    expect(favorites.getCanonicalFavoriteListingIds(2)).toEqual([]);
    expect(favorites.getFavoriteCount(1)).toBe(2);
  });

  it('can unsave and resave a mapped favorite without changing the legacy rollback state', () => {
    expect(favorites.toggleCanonicalFavorite(1, 9)).toBe(false);
    expect(favorites.isCanonicalFavorite(1, 9)).toBe(false);
    expect(favorites.getCanonicalFavoriteListingIds(1)).toEqual([]);
    expect(db.prepare('SELECT listing_id FROM canonical_favorite_exclusions WHERE user_id=1').all())
      .toEqual([{ listing_id: 9 }]);
    expect(favorites.getFavoriteCount(1)).toBe(2);
    expect(favorites.isFavorite(1, 123)).toBe(true);

    expect(favorites.toggleCanonicalFavorite(1, 9)).toBe(true);
    expect(favorites.isCanonicalFavorite(1, 9)).toBe(true);
    expect(favorites.getCanonicalFavoriteListingIds(1)).toEqual([9]);
    expect(db.prepare('SELECT listing_id FROM canonical_favorite_exclusions WHERE user_id=1').all()).toEqual([]);
    expect(favorites.getFavoriteCount(1)).toBe(2);
  });

  it('saves colliding canonical numeric IDs separately from mapped legacy IDs', () => {
    expect(favorites.toggleCanonicalFavorite(1, 123)).toBe(true);
    expect(favorites.isCanonicalFavorite(1, 9)).toBe(true);
    expect(new Set(favorites.getCanonicalFavoriteListingIds(1))).toEqual(new Set([9, 123]));
    expect(favorites.toggleCanonicalFavorite(1, 123)).toBe(false);
    expect(favorites.isCanonicalFavorite(1, 123)).toBe(false);
    expect(favorites.getCanonicalFavoriteListingIds(1)).toEqual([9]);
    expect(favorites.getFavoriteCount(1)).toBe(2);
  });

  it('rolls back the savepoint after an invalid foreign key and remains usable', () => {
    expect(() => favorites.toggleCanonicalFavorite(1, 777777)).toThrow();
    expect(favorites.getCanonicalFavoriteListingIds(1)).toEqual([9]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_user_favorites').get()).toEqual({ n: 0 });
    expect(favorites.toggleCanonicalFavorite(1, 123)).toBe(true);
    expect(favorites.isCanonicalFavorite(1, 123)).toBe(true);
  });
});
