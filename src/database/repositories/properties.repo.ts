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
  posted_at: string | null;
  updated_at: string;
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
    posted_at: row.posted_at ?? null,
    updated_at: row.updated_at || row.created_at,
  };
}

export type CreatePropertyInput = Omit<
  Property,
  'id' | 'created_at' | 'updated_at' | 'parsed_at' | 'image_phashes' | 'image_phash' | 'reports_count' | 'is_active' | 'posted_at'
> & {
  image_phash?: string | null;
  image_phashes?: string[];
  reports_count?: number;
  is_active?: 0 | 1;
  parsed_at?: string;
  posted_at?: string | null;
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
            maps_url, source_url, photos, image_phash, image_phashes, direct_contact, original_url, posted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
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
        input.posted_at ?? null,
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
   * Updates an existing master listing when a duplicate/re-post is discovered:
   * - Bumps updated_at to NOW (making it fresh in search and catalogs).
   * - Adopts lower genuine price if re-posted with a lower price.
   * - Enriches phone number, location, and maps_url if missing in original.
   * - Retains earliest posted_at timestamp.
   */
  bumpAndMerge(
    id: number,
    update: {
      price?: number;
      phone?: string;
      location?: string;
      maps_url?: string;
      posted_at?: string | null;
      source_url?: string;
    },
  ): Property | undefined {
    const existing = this.getPropertyById(id);
    if (!existing) return undefined;

    let newPrice = existing.price;
    if (update.price && update.price > 0) {
      if (existing.price === 0 || update.price < existing.price) {
        newPrice = update.price;
      }
    }

    const contact = { ...existing.direct_contact };
    if (update.phone && !contact.phone) {
      contact.phone = update.phone;
    }

    let newLocation = existing.location;
    if (update.location && (!existing.location || existing.location.toLowerCase() === existing.city)) {
      newLocation = update.location;
    }

    let newMapsUrl = existing.maps_url;
    if (update.maps_url && !existing.maps_url) {
      newMapsUrl = update.maps_url;
    }

    let newPostedAt = existing.posted_at;
    if (update.posted_at) {
      if (!existing.posted_at || update.posted_at < existing.posted_at) {
        newPostedAt = update.posted_at;
      }
    }

    this.db
      .prepare(
        `UPDATE properties
         SET price = ?,
             direct_contact = ?,
             location = ?,
             maps_url = ?,
             posted_at = ?,
             updated_at = (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         WHERE id = ?`,
      )
      .run(newPrice, JSON.stringify(contact), newLocation, newMapsUrl, newPostedAt, id);

    return this.getPropertyById(id);
  }

  /**
   * Returns recent properties in the same city and area/location for deduplication checks.
   * Restricts search to properties active within the last 45 days.
   */
  findRecentPropertiesForDedup(city: CityKey, location: string, limit = 50): Property[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM properties
         WHERE city = ? AND (location LIKE ? OR location = ?) AND is_active = 1
           AND COALESCE(updated_at, created_at) >= datetime('now', '-45 days')
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT ?`,
      )
      .all(city, `%${location}%`, location, limit) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  getRecentProperties(limit = 20, offset = 0): Property[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM properties
         WHERE is_active = 1
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  getPropertyCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM properties WHERE is_active = 1')
      .get() as unknown as { count: number };
    return row.count;
  }

  /**
   * Search and filter properties with pagination, sorting, and total count for Telegram Mini App.
   */
  searchProperties(options: PropertyFilterOptions = {}): { items: Property[]; total: number } {
    const whereClauses: string[] = ['is_active = 1'];
    const params: Array<string | number> = [];

    if (options.city) {
      whereClauses.push('city = ?');
      params.push(options.city);
    }

    if (options.locations && options.locations.length > 0) {
      const locConditions = options.locations.map(() => '(location LIKE ? OR location = ?)');
      whereClauses.push(`(${locConditions.join(' OR ')})`);
      for (const loc of options.locations) {
        params.push(`%${loc}%`, loc);
      }
    }

    if (options.category) {
      whereClauses.push('category = ?');
      params.push(options.category);
    }

    if (options.type) {
      whereClauses.push('type = ?');
      params.push(options.type);
    }

    if (typeof options.minPrice === 'number' && options.minPrice >= 0) {
      whereClauses.push('price >= ?');
      params.push(options.minPrice);
    }

    if (typeof options.maxPrice === 'number' && options.maxPrice > 0) {
      whereClauses.push('price <= ?');
      params.push(options.maxPrice);
    }

    if (options.bedrooms && options.bedrooms.length > 0) {
      const placeholders = options.bedrooms.map(() => '?').join(', ');
      whereClauses.push(`bedrooms IN (${placeholders})`);
      params.push(...options.bedrooms);
    }

    if (options.bathrooms && options.bathrooms.length > 0) {
      const placeholders = options.bathrooms.map(() => '?').join(', ');
      whereClauses.push(`bathrooms IN (${placeholders})`);
      params.push(...options.bathrooms);
    }

    if (options.hasPool === true) {
      whereClauses.push('has_pool = 1');
    }

    if (typeof options.minLeaseMax === 'number' && options.minLeaseMax > 0) {
      whereClauses.push('(min_lease IS NULL OR min_lease <= ?)');
      params.push(options.minLeaseMax);
    }

    if (options.query && options.query.trim().length > 0) {
      whereClauses.push('(title LIKE ? OR description LIKE ? OR location LIKE ?)');
      const q = `%${options.query.trim()}%`;
      params.push(q, q, q);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count total matches
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM properties ${whereSql}`)
      .get(...params) as unknown as { count: number };
    const total = countRow?.count ?? 0;

    // Sorting
    let orderBy = 'ORDER BY COALESCE(posted_at, created_at) DESC';
    if (options.sort === 'price_asc') {
      orderBy = 'ORDER BY price ASC, COALESCE(posted_at, created_at) DESC';
    } else if (options.sort === 'price_desc') {
      orderBy = 'ORDER BY price DESC, COALESCE(posted_at, created_at) DESC';
    }

    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const offset = Math.max(0, options.offset ?? 0);

    const querySql = `SELECT * FROM properties ${whereSql} ${orderBy} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(querySql).all(...params, limit, offset) as unknown as PropertyRow[];

    return {
      items: rows.map(rowToProperty),
      total,
    };
  }

  /**
   * Lightweight query for map markers.
   */
  getPropertiesForMap(
    city: CityKey,
    options: { category?: string; type?: 'rent' | 'sale'; limit?: number } = {},
  ): Property[] {
    const whereClauses: string[] = ['is_active = 1', 'city = ?'];
    const params: Array<string | number> = [city];

    if (options.category) {
      whereClauses.push('category = ?');
      params.push(options.category);
    }

    if (options.type) {
      whereClauses.push('type = ?');
      params.push(options.type);
    }

    const limit = Math.min(options.limit ?? 300, 500);
    const sql = `SELECT * FROM properties WHERE ${whereClauses.join(' AND ')} ORDER BY COALESCE(posted_at, created_at) DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  /**
   * Returns aggregated metadata for the city filter dropdowns:
   * locations with listing counts, categories with listing counts, and min/max prices.
   */
  getMetadata(city: CityKey): {
    locations: Array<{ location: string; count: number }>;
    categories: Array<{ category: string; count: number }>;
    priceRange: { minPrice: number; maxPrice: number };
  } {
    const locations = this.db
      .prepare(
        `SELECT location, COUNT(*) as count
         FROM properties
         WHERE city = ? AND is_active = 1 AND location != ''
         GROUP BY location
         ORDER BY count DESC
         LIMIT 30`,
      )
      .all(city) as unknown as Array<{ location: string; count: number }>;

    const categories = this.db
      .prepare(
        `SELECT COALESCE(category, 'other') as category, COUNT(*) as count
         FROM properties
         WHERE city = ? AND is_active = 1
         GROUP BY category
         ORDER BY count DESC`,
      )
      .all(city) as unknown as Array<{ category: string; count: number }>;

    const priceRow = this.db
      .prepare(
        `SELECT MIN(price) as minPrice, MAX(price) as maxPrice
         FROM properties
         WHERE city = ? AND is_active = 1 AND price > 0`,
      )
      .get(city) as unknown as { minPrice: number | null; maxPrice: number | null };

    return {
      locations: locations ?? [],
      categories: categories ?? [],
      priceRange: {
        minPrice: priceRow?.minPrice ?? 5000,
        maxPrice: priceRow?.maxPrice ?? 500000,
      },
    };
  }
}

export interface PropertyFilterOptions {
  city?: CityKey;
  locations?: string[];
  category?: PropertyCategory | string;
  type?: 'rent' | 'sale';
  minPrice?: number;
  maxPrice?: number;
  bedrooms?: number[];
  bathrooms?: number[];
  hasPool?: boolean;
  minLeaseMax?: number;
  query?: string;
  sort?: 'newest' | 'price_asc' | 'price_desc';
  limit?: number;
  offset?: number;
}
