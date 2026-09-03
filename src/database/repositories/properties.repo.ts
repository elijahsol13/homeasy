import type { DatabaseSync } from 'node:sqlite';
import type { CityKey, PropertyCategory } from '../../config/settings';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DirectContact {
  phone?: string;
  telegram?: string;
}

export interface Property {
  id: number;
  hash: string;
  title: string;
  description: string;
  /** Price in USD cents (e.g. $800/mo → 80000) */
  price: number;
  currency: 'USD' | 'KHR';
  type: 'rent' | 'sale';
  category: PropertyCategory | null;
  bedrooms: number | null;
  bathrooms: number | null;
  /** Deposit in USD cents (e.g. $800 → 80000) */
  deposit: number | null;
  /** Minimum lease in months (e.g. 1, 6, 12) */
  min_lease: number | null;
  has_pool: boolean;
  location: string;
  city: CityKey;
  maps_url: string | null;
  source_url: string | null;
  photos: string[];
  image_phash: string | null;
  image_phashes: string[];
  direct_contact: DirectContact;
  original_url: string;
  reports_count: number;
  is_active: 0 | 1;
  parsed_at: string;
  created_at: string;
}

interface PropertyRow
  extends Omit<
    Property,
    'photos' | 'direct_contact' | 'has_pool' | 'image_phashes' | 'reports_count' | 'is_active'
  > {
  has_pool: 0 | 1;
  photos: string;
  direct_contact: string;
  image_phashes?: string | null;
  reports_count?: number;
  is_active?: 0 | 1;
}

function rowToProperty(row: PropertyRow): Property {
  let imagePhashes: string[] = [];
  try {
    if (row.image_phashes) {
      imagePhashes = JSON.parse(row.image_phashes) as string[];
    } else if (row.image_phash) {
      imagePhashes = [row.image_phash];
    }
  } catch {
    imagePhashes = row.image_phash ? [row.image_phash] : [];
  }

  return {
    ...row,
    has_pool: Boolean(row.has_pool),
    photos: JSON.parse(row.photos || '[]') as string[],
    direct_contact: JSON.parse(row.direct_contact || '{}') as DirectContact,
    image_phashes: imagePhashes,
    reports_count: row.reports_count ?? 0,
    is_active: row.is_active !== undefined ? row.is_active : 1,
  };
}

export type CreatePropertyInput = Omit<
  Property,
  'id' | 'created_at' | 'parsed_at' | 'image_phashes' | 'reports_count' | 'is_active'
> & {
  image_phashes?: string[];
  reports_count?: number;
  is_active?: 0 | 1;
  parsed_at?: string;
};

// ─── Repository ───────────────────────────────────────────────────────────────

export class PropertiesRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Inserts a property into the database.
   */
  insertProperty(input: CreatePropertyInput): Property {
    const phashes = input.image_phashes ?? (input.image_phash ? [input.image_phash] : []);
    const primaryPhash = phashes[0] ?? input.image_phash ?? null;

    const result = this.db
      .prepare(
        `INSERT INTO properties
           (hash, title, description, price, currency, type, category,
            bedrooms, bathrooms, deposit, min_lease, has_pool, location, city,
            maps_url, source_url, photos, image_phash, image_phashes, direct_contact, original_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.hash,
        input.title,
        input.description,
        input.price,
        input.currency,
        input.type,
        input.category ?? null,
        input.bedrooms ?? null,
        input.bathrooms ?? null,
        input.deposit ?? null,
        input.min_lease ?? null,
        input.has_pool ? 1 : 0,
        input.location,
        input.city,
        input.maps_url ?? null,
        input.source_url ?? null,
        JSON.stringify(input.photos ?? []),
        primaryPhash,
        JSON.stringify(phashes),
        JSON.stringify(input.direct_contact ?? {}),
        input.original_url ?? '',
      );

    const row = this.db
      .prepare('SELECT * FROM properties WHERE id = ?')
      .get(result.lastInsertRowid) as unknown as PropertyRow;

    return rowToProperty(row);
  }

  findByHash(hash: string): Property | undefined {
    const row = this.db
      .prepare('SELECT * FROM properties WHERE hash = ? ORDER BY created_at DESC LIMIT 1')
      .get(hash) as unknown as PropertyRow | undefined;
    return row ? rowToProperty(row) : undefined;
  }

  findBySourceUrl(sourceUrl: string): Property | undefined {
    if (!sourceUrl) return undefined;
    const row = this.db
      .prepare(
        'SELECT * FROM properties WHERE source_url = ? OR original_url = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(sourceUrl, sourceUrl) as unknown as PropertyRow | undefined;
    return row ? rowToProperty(row) : undefined;
  }

  getPropertyById(id: number): Property | undefined {
    const row = this.db
      .prepare('SELECT * FROM properties WHERE id = ?')
      .get(id) as unknown as PropertyRow | undefined;
    return row ? rowToProperty(row) : undefined;
  }

  reportProperty(id: number): { reports_count: number; is_active: boolean } {
    this.db.prepare('UPDATE properties SET reports_count = reports_count + 1 WHERE id = ?').run(id);
    const row = this.db
      .prepare('SELECT reports_count FROM properties WHERE id = ?')
      .get(id) as unknown as { reports_count: number } | undefined;

    const count = row?.reports_count ?? 1;
    let isActive = true;
    if (count >= 3) {
      this.db.prepare('UPDATE properties SET is_active = 0 WHERE id = ?').run(id);
      isActive = false;
    }

    return { reports_count: count, is_active: isActive };
  }

  /**
   * Returns recent properties in the same city and area/location for deduplication checks.
   * Restricts search to properties created within the last 45 days.
   */
  findRecentPropertiesForDedup(city: CityKey, location: string, limit = 50): Property[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM properties
         WHERE city = ? AND (location LIKE ? OR location = ?) AND is_active = 1
           AND created_at >= datetime('now', '-45 days')
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(city, `%${location}%`, location, limit) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  getRecentProperties(limit = 20): Property[] {
    const rows = this.db
      .prepare('SELECT * FROM properties WHERE is_active = 1 ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  getPropertyCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM properties WHERE is_active = 1')
      .get() as unknown as { count: number };
    return row.count;
  }
}
