import type { DatabaseSync } from 'node:sqlite';
import type { Property } from './properties.repo';

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
      .all(userId) as unknown as Array<
      Omit<Property, 'photos' | 'direct_contact'> & { photos: string; direct_contact: string }
    >;

    return rows.map((row) => ({
      ...row,
      photos: JSON.parse(row.photos) as string[],
      direct_contact: JSON.parse(row.direct_contact) as Property['direct_contact'],
    }));
  }

  getFavoriteCount(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM user_favorites WHERE user_id = ?')
      .get(userId) as unknown as { count: number };
    return row.count;
  }
}
