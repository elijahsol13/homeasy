import type { DatabaseSync } from 'node:sqlite';
import type { CityKey, PropertyCategory } from '../../config/settings';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchFilter {
  id: number;
  user_id: number;
  type: 'rent' | 'sale';
  category: PropertyCategory | null;
  requires_pool: boolean;
  min_lease_preferred: number | null; // e.g. 5 (short-term), 6 (long-term), or null (any)
  /** Minimum price in USD dollars (not cents) */
  min_price: number | null;
  /** Maximum price in USD dollars (not cents) */
  max_price: number | null;
  /**
   * null or empty = any. Array of bedroom counts: 0 = studio, 1 = 1 BR, 2 = 2 BR, 3 = 3 BR, 4 = 4+ BR.
   */
  bedrooms: number[] | null;
  locations: string[];
  city: CityKey;
  is_active: 0 | 1;
  created_at: string;
}

interface SearchFilterRow extends Omit<SearchFilter, 'locations' | 'requires_pool' | 'bedrooms'> {
  requires_pool: 0 | 1;
  locations: string; // JSON string in DB
  bedrooms: string | number | null;
}

function parseBedroomsField(val: unknown): number[] | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return [val];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(Number);
      if (typeof parsed === 'number') return [parsed];
    } catch {
      const parts = val.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (parts.length > 0) return parts;
    }
  }
  return null;
}

function rowToFilter(row: SearchFilterRow): SearchFilter {
  return {
    ...row,
    requires_pool: Boolean(row.requires_pool),
    locations: JSON.parse(row.locations || '[]') as string[],
    bedrooms: parseBedroomsField(row.bedrooms),
  };
}

export type CreateFilterInput = Omit<SearchFilter, 'id' | 'created_at' | 'is_active' | 'bedrooms'> & {
  bedrooms: number[] | number | null;
};

// ─── Repository ───────────────────────────────────────────────────────────────

export class FiltersRepository {
  constructor(private readonly db: DatabaseSync) {}

  createFilter(input: CreateFilterInput): SearchFilter {
    const bedroomsValue = Array.isArray(input.bedrooms)
      ? JSON.stringify(input.bedrooms)
      : typeof input.bedrooms === 'number'
        ? JSON.stringify([input.bedrooms])
        : null;

    const result = this.db
      .prepare(
        `INSERT INTO search_filters
           (user_id, type, category, requires_pool, min_lease_preferred,
            min_price, max_price, bedrooms, locations, city, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.user_id,
        input.type,
        input.category ?? null,
        input.requires_pool ? 1 : 0,
        input.min_lease_preferred ?? null,
        input.min_price ?? null,
        input.max_price ?? null,
        bedroomsValue,
        JSON.stringify(input.locations ?? []),
        input.city,
      );

    const row = this.db
      .prepare('SELECT * FROM search_filters WHERE id = ?')
      .get(result.lastInsertRowid) as unknown as SearchFilterRow;

    return rowToFilter(row);
  }

  getAllActiveFilters(): SearchFilter[] {
    const rows = this.db
      .prepare('SELECT * FROM search_filters WHERE is_active = 1')
      .all() as unknown as SearchFilterRow[];
    return rows.map(rowToFilter);
  }

  getUserFilters(userId: number): SearchFilter[] {
    const rows = this.db
      .prepare('SELECT * FROM search_filters WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as unknown as SearchFilterRow[];
    return rows.map(rowToFilter);
  }

  getFilterById(filterId: number): SearchFilter | null {
    const row = this.db
      .prepare('SELECT * FROM search_filters WHERE id = ?')
      .get(filterId) as unknown as SearchFilterRow | undefined;
    return row ? rowToFilter(row) : null;
  }

  getUserActiveFilters(userId: number): SearchFilter[] {
    const rows = this.db
      .prepare('SELECT * FROM search_filters WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC')
      .all(userId) as unknown as SearchFilterRow[];
    return rows.map(rowToFilter);
  }

  deactivateFilter(filterId: number, userId: number): boolean {
    const result = this.db
      .prepare('UPDATE search_filters SET is_active = 0 WHERE id = ? AND user_id = ?')
      .run(filterId, userId);
    return result.changes > 0;
  }

  deactivateAllUserFilters(userId: number): void {
    this.db.prepare('UPDATE search_filters SET is_active = 0 WHERE user_id = ?').run(userId);
  }

  getFilterCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM search_filters WHERE is_active = 1')
      .get() as unknown as { count: number };
    return row.count;
  }
}
