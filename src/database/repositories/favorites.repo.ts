import type { DatabaseSync } from 'node:sqlite';
import { rowToProperty, type Property } from './properties.repo';
import type { CanonicalListingRepository } from './canonical-listing.repo';

export interface Favorite {
  user_id: number;
  property_id: number;
  saved_at: string;
}

export class FavoritesRepository {
  constructor(private readonly db: DatabaseSync) {}

  addFavorite(userId: number, propertyId: number): boolean {
    try {
      const result = this.db
        .prepare('INSERT OR IGNORE INTO user_favorites (user_id, property_id) VALUES (?, ?)')
        .run(userId, propertyId);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  removeFavorite(userId: number, propertyId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM user_favorites WHERE user_id = ? AND property_id = ?')
      .run(userId, propertyId);
    return result.changes > 0;
  }

  isFavorite(userId: number, propertyId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM user_favorites WHERE user_id = ? AND property_id = ?')
      .get(userId, propertyId);
    return row !== undefined;
  }

  getUserFavorites(userId: number): Property[] {
    const rows = this.db
      .prepare(
        `SELECT p.*
         FROM properties p
         INNER JOIN user_favorites uf ON uf.property_id = p.id
         WHERE uf.user_id = ?
         ORDER BY uf.saved_at DESC`,
      )
      .all(userId) as unknown as Parameters<typeof rowToProperty>[0][];

    return rows.map(rowToProperty);
  }

  getFavoriteCount(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM user_favorites WHERE user_id = ?')
      .get(userId) as unknown as { count: number };
    return row.count;
  }

  getCanonicalFavorites(userId: number, canonical: CanonicalListingRepository): Property[] {
    const rows = this.canonicalFavoriteRows(userId);
    return rows.map((row)=>canonical.getPropertyById(row.listing_id)).filter((row):row is Property=>Boolean(row));
  }

  /** Save state in the canonical cohort must never delete rollback favorites. */
  toggleCanonicalFavorite(userId: number, listingId: number): boolean {
    const existing = this.isCanonicalFavorite(userId, listingId);
    this.db.exec('SAVEPOINT canonical_favorite_toggle');
    try {
      if (existing) {
        this.db.prepare('DELETE FROM canonical_user_favorites WHERE user_id=? AND listing_id=?').run(userId, listingId);
        this.db.prepare('INSERT OR IGNORE INTO canonical_favorite_exclusions(user_id,listing_id) VALUES(?,?)').run(userId, listingId);
      } else {
        this.db.prepare('DELETE FROM canonical_favorite_exclusions WHERE user_id=? AND listing_id=?').run(userId, listingId);
        this.db.prepare('INSERT OR IGNORE INTO canonical_user_favorites(user_id,listing_id) VALUES(?,?)').run(userId, listingId);
      }
      this.db.exec('RELEASE SAVEPOINT canonical_favorite_toggle');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT canonical_favorite_toggle');
      this.db.exec('RELEASE SAVEPOINT canonical_favorite_toggle');
      throw error;
    }
    return !existing;
  }

  isCanonicalFavorite(userId: number, listingId: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM canonical_user_favorites WHERE user_id=? AND listing_id=?
      UNION SELECT 1 FROM user_favorites uf
      JOIN canonical_listing_aliases a ON a.namespace='legacy_property_id' AND a.alias=CAST(uf.property_id AS TEXT)
      WHERE uf.user_id=? AND a.listing_id=?
        AND NOT EXISTS (SELECT 1 FROM canonical_favorite_exclusions x WHERE x.user_id=uf.user_id AND x.listing_id=a.listing_id)
      LIMIT 1`).get(userId, listingId, userId, listingId));
  }

  private canonicalFavoriteRows(userId: number): Array<{ listing_id: number }> {
    return this.db.prepare(`
      SELECT listing_id FROM canonical_user_favorites WHERE user_id=?
      UNION SELECT a.listing_id FROM user_favorites uf
      JOIN canonical_listing_aliases a ON a.namespace='legacy_property_id' AND a.alias=CAST(uf.property_id AS TEXT)
      WHERE uf.user_id=?
        AND NOT EXISTS (SELECT 1 FROM canonical_favorite_exclusions x WHERE x.user_id=uf.user_id AND x.listing_id=a.listing_id)
    `).all(userId, userId) as Array<{ listing_id: number }>;
  }

  getCanonicalFavoriteListingIds(userId: number): number[] {
    return this.canonicalFavoriteRows(userId).map((row) => row.listing_id);
  }
}
