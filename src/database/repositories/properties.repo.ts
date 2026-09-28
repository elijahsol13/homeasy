import type { DatabaseSync } from 'node:sqlite';
import type { CityKey, PropertyCategory } from '../../config/settings';
import { canonicalizeLocation, extractCoordinatesFromMapsUrl, getSangkatCentroid } from '../../config/locations';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DirectContact {
  phone?: string;
  telegram?: string;
  whatsapp?: string;
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
  has_pool: boolean | null;
  location: string;
  location_key?: string | null;
  raw_location?: string | null;
  city: CityKey;
  coordinate_precision?: 'exact' | 'district' | 'city';
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
  electricity?: string | null;
  water?: string | null;
  cleaning?: string | null;
  restrictions?: string[];
  pet_friendly?: boolean | null;
  primary_landmark?: string | null;
  landmarks?: string[];
  /** Promotional "5 min to X" references — never treated as physical location. */
  marketing_landmarks?: string[];
  /** Original un-normalized post text, kept for re-parsing/debugging. */
  raw_text?: string | null;
  /** Machine-readable extraction issue codes (e.g. 'price_missing'). */
  parse_warnings?: string[];
  /** ISO timestamp of the last source-page re-verification. */
  last_verified_at?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  property_type?: string | null;
  amenities?: string[];
  review_status?: 'approved' | 'pending' | 'rejected';
  review_reason?: string | null;
}

interface PropertyRow
  extends Omit<
    Property,
    | 'photos'
    | 'direct_contact'
    | 'has_pool'
    | 'image_phashes'
    | 'reports_count'
    | 'is_active'
    | 'restrictions'
    | 'pet_friendly'
    | 'landmarks'
    | 'marketing_landmarks'
    | 'electricity'
    | 'water'
    | 'cleaning'
    | 'primary_landmark'
    | 'amenities'
    | 'raw_text'
    | 'parse_warnings'
  > {
  has_pool: 0 | 1 | null;
  photos: string;
  direct_contact: string;
  image_phashes?: string | null;
  reports_count?: number;
  is_active?: 0 | 1;
  electricity?: string | null;
  water?: string | null;
  cleaning?: string | null;
  restrictions?: string | null;
  pet_friendly?: 0 | 1 | null;
  primary_landmark?: string | null;
  landmarks?: string | null;
  marketing_landmarks?: string | null;
  raw_text?: string | null;
  parse_warnings?: string | null;
  last_verified_at?: string | null;
  property_type?: string | null;
  amenities?: string | null;
}

export function rowToProperty(row: PropertyRow): Property {
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

  let parsedRestrictions: string[] = [];
  try {
    if (row.restrictions) {
      parsedRestrictions = JSON.parse(row.restrictions) as string[];
    }
  } catch {
    parsedRestrictions = [];
  }

  let parsedLandmarks: string[] = [];
  try {
    if (row.landmarks) {
      parsedLandmarks = JSON.parse(row.landmarks) as string[];
    }
  } catch {
    parsedLandmarks = [];
  }

  let parsedAmenities: string[] = [];
  try {
    if (row.amenities) {
      parsedAmenities = JSON.parse(row.amenities) as string[];
    }
  } catch {
    parsedAmenities = [];
  }

  let parsedMarketingLandmarks: string[] = [];
  try {
    if (row.marketing_landmarks) {
      parsedMarketingLandmarks = JSON.parse(row.marketing_landmarks) as string[];
    }
  } catch {
    parsedMarketingLandmarks = [];
  }

  let parsedWarnings: string[] = [];
  try {
    if (row.parse_warnings) {
      parsedWarnings = JSON.parse(row.parse_warnings) as string[];
    }
  } catch {
    parsedWarnings = [];
  }

  return {
    ...row,
    has_pool: row.has_pool === 1 ? true : row.has_pool === 0 ? false : null,
    photos: JSON.parse(row.photos || '[]') as string[],
    direct_contact: JSON.parse(row.direct_contact || '{}') as DirectContact,
    image_phashes: imagePhashes,
    reports_count: row.reports_count ?? 0,
    is_active: row.is_active !== undefined ? row.is_active : 1,
    posted_at: row.posted_at ?? null,
    updated_at: row.updated_at || row.created_at,
    electricity: row.electricity ?? null,
    water: row.water ?? null,
    cleaning: row.cleaning ?? null,
    restrictions: parsedRestrictions,
    pet_friendly: row.pet_friendly === 1 ? true : row.pet_friendly === 0 ? false : null,
    primary_landmark: row.primary_landmark ?? null,
    landmarks: parsedLandmarks,
    marketing_landmarks: parsedMarketingLandmarks,
    raw_text: row.raw_text ?? null,
    parse_warnings: parsedWarnings,
    last_verified_at: row.last_verified_at ?? null,
    latitude: row.latitude !== undefined && row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== undefined && row.longitude !== null ? Number(row.longitude) : null,
    property_type: row.property_type ?? null,
    amenities: parsedAmenities,
  };
}

export type CreatePropertyInput = Omit<
  Property,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'parsed_at'
  | 'image_phashes'
  | 'image_phash'
  | 'reports_count'
  | 'is_active'
  | 'posted_at'
  | 'restrictions'
  | 'landmarks'
  | 'marketing_landmarks'
  | 'raw_text'
  | 'parse_warnings'
  | 'pet_friendly'
  | 'electricity'
  | 'water'
  | 'cleaning'
  | 'primary_landmark'
> & {
  image_phash?: string | null;
  image_phashes?: string[];
  reports_count?: number;
  is_active?: 0 | 1;
  parsed_at?: string;
  posted_at?: string | null;
  electricity?: string | null;
  water?: string | null;
  cleaning?: string | null;
  restrictions?: string[] | string | null;
  pet_friendly?: boolean | null | number;
  primary_landmark?: string | null;
  landmarks?: string[] | string | null;
  marketing_landmarks?: string[] | string | null;
  raw_text?: string | null;
  parse_warnings?: string[] | string | null;
  property_type?: string | null;
  amenities?: string[];
};

export interface MapBoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  paddingRatio?: number; // default 0.2 (20% overscan buffer = ~5-10 mm beyond screen)
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class PropertiesRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Inserts a property into the database.
   */
  insertProperty(input: CreatePropertyInput): Property {
    const phashes = input.image_phashes ?? (input.image_phash ? [input.image_phash] : []);
    const primaryPhash = phashes[0] ?? input.image_phash ?? null;

    const restrictionsJson = Array.isArray(input.restrictions)
      ? JSON.stringify(input.restrictions)
      : typeof input.restrictions === 'string'
        ? input.restrictions
        : '[]';
    const landmarksJson = Array.isArray(input.landmarks)
      ? JSON.stringify(input.landmarks)
      : typeof input.landmarks === 'string'
        ? input.landmarks
        : '[]';
    const hasPoolVal = input.has_pool === true ? 1 : input.has_pool === false ? 0 : null;
    const petFriendlyVal = input.pet_friendly === true ? 1 : input.pet_friendly === false ? 0 : null;

    let lat = input.latitude ?? null;
    let lng = input.longitude ?? null;
    if ((lat === null || lng === null) && input.maps_url) {
      const coords = extractCoordinatesFromMapsUrl(input.maps_url);
      if (coords) {
        lat = coords.latitude;
        lng = coords.longitude;
      }
    }

    const canonicalLocation = canonicalizeLocation(input.location, input.city);
    const locationKey = input.location_key ?? canonicalLocation.key;
    const locationName = canonicalLocation.name || input.location;
    const locationCity = canonicalLocation.key ? canonicalLocation.city : input.city;
    const rawLocation = input.raw_location ?? (locationName !== input.location ? input.location : null);
    const coordinatePrecision = lat !== null && lng !== null
      ? 'exact'
      : locationKey ? 'district' : 'city';
    const isActiveVal = input.is_active !== undefined ? input.is_active : 1;

    const amenitiesJson = Array.isArray(input.amenities)
      ? JSON.stringify(input.amenities)
      : '[]';
    const marketingLandmarksJson = Array.isArray(input.marketing_landmarks)
      ? JSON.stringify(input.marketing_landmarks)
      : typeof input.marketing_landmarks === 'string'
        ? input.marketing_landmarks
        : '[]';
    const parseWarningsJson = Array.isArray(input.parse_warnings)
      ? JSON.stringify(input.parse_warnings)
      : typeof input.parse_warnings === 'string'
        ? input.parse_warnings
        : '[]';

    const result = this.db
      .prepare(
        `INSERT INTO properties
           (hash, title, description, price, currency, type, category,
            bedrooms, bathrooms, deposit, min_lease, has_pool, location, location_key, raw_location, city, coordinate_precision,
            maps_url, source_url, photos, image_phash, image_phashes, direct_contact, original_url, posted_at, updated_at,
            electricity, water, cleaning, restrictions, pet_friendly, primary_landmark, landmarks, marketing_landmarks, raw_text, parse_warnings, latitude, longitude, is_active,
            property_type, amenities, review_status, review_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        hasPoolVal,
        locationName,
        locationKey,
        rawLocation,
        locationCity,
        coordinatePrecision,
        input.maps_url ?? null,
        input.source_url ?? null,
        JSON.stringify(input.photos ?? []),
        primaryPhash,
        JSON.stringify(phashes),
        JSON.stringify(input.direct_contact ?? {}),
        input.original_url ?? '',
        input.posted_at ?? null,
        input.electricity ?? null,
        input.water ?? null,
        input.cleaning ?? null,
        restrictionsJson,
        petFriendlyVal,
        input.primary_landmark ?? null,
        landmarksJson,
        marketingLandmarksJson,
        input.raw_text ?? null,
        parseWarningsJson,
        lat,
        lng,
        isActiveVal,
        input.property_type ?? null,
        amenitiesJson,
        input.review_status ?? 'approved',
        input.review_reason ?? null,
      );

    const newId = result.lastInsertRowid as number;

    const row = this.db
      .prepare('SELECT * FROM properties WHERE id = ?')
      .get(newId) as unknown as PropertyRow;

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

  /**
   * Finds a property by numeric post ID embedded in source_url or original_url.
   * Used by the Facebook feed re-parser to match existing records.
   */
  findByPostId(numericId: string): Property | undefined {
    if (!numericId) return undefined;
    const row = this.db
      .prepare(
        'SELECT * FROM properties WHERE source_url LIKE ? OR original_url LIKE ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(`%${numericId}%`, `%${numericId}%`) as unknown as PropertyRow | undefined;
    return row ? rowToProperty(row) : undefined;
  }

  getPropertyById(id: number): Property | undefined {
    const row = this.db
      .prepare('SELECT * FROM properties WHERE id = ?')
      .get(id) as unknown as PropertyRow | undefined;
    return row ? rowToProperty(row) : undefined;
  }

  findById(id: number): Property | undefined {
    return this.getPropertyById(id);
  }

  deactivateProperty(id: number): boolean {
    const result = this.db
      .prepare("UPDATE properties SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  reportProperty(id: number): { reports_count: number; is_active: boolean } {
    this.db.prepare('UPDATE properties SET reports_count = reports_count + 1 WHERE id = ?').run(id);
    const row = this.db
      .prepare('SELECT reports_count FROM properties WHERE id = ?')
      .get(id) as unknown as { reports_count: number } | undefined;

    const count = row?.reports_count ?? 1;
    let isActive = true;
    if (count >= 2) {
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
      description?: string;
      raw_text?: string;
      parse_warnings?: string[];
      maps_url?: string;
      posted_at?: string | null;
      source_url?: string;
      electricity?: string | null;
      water?: string | null;
      cleaning?: string | null;
      restrictions?: string[] | string | null;
      pet_friendly?: boolean | number;
      primary_landmark?: string | null;
      landmarks?: string[] | string | null;
      marketing_landmarks?: string[] | string | null;
      latitude?: number | null;
      longitude?: number | null;
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

    let newLat = existing.latitude ?? update.latitude ?? null;
    let newLng = existing.longitude ?? update.longitude ?? null;
    if ((newLat === null || newLng === null) && newMapsUrl) {
      const coords = extractCoordinatesFromMapsUrl(newMapsUrl);
      if (coords) {
        newLat = coords.latitude;
        newLng = coords.longitude;
      }
    }

    let newPostedAt = existing.posted_at;
    if (update.posted_at) {
      if (!existing.posted_at || update.posted_at < existing.posted_at) {
        newPostedAt = update.posted_at;
      }
    }

    const newElectricity = existing.electricity || update.electricity || null;
    const newWater = existing.water || update.water || null;
    const newCleaning = existing.cleaning || update.cleaning || null;
    const newRestrictions =
      existing.restrictions && existing.restrictions.length > 0
        ? JSON.stringify(existing.restrictions)
        : Array.isArray(update.restrictions)
          ? JSON.stringify(update.restrictions)
          : typeof update.restrictions === 'string'
            ? update.restrictions
            : '[]';
    const newPetFriendly = existing.pet_friendly ? 1 : update.pet_friendly ? 1 : 0;
    const newPrimaryLandmark = existing.primary_landmark || update.primary_landmark || null;
    const newLandmarks =
      existing.landmarks && existing.landmarks.length > 0
        ? JSON.stringify(existing.landmarks)
        : Array.isArray(update.landmarks)
          ? JSON.stringify(update.landmarks)
          : typeof update.landmarks === 'string'
            ? update.landmarks
            : '[]';
    const newMarketingLandmarks =
      existing.marketing_landmarks && existing.marketing_landmarks.length > 0
        ? JSON.stringify(existing.marketing_landmarks)
        : Array.isArray(update.marketing_landmarks)
          ? JSON.stringify(update.marketing_landmarks)
          : typeof update.marketing_landmarks === 'string'
            ? update.marketing_landmarks
            : '[]';
    const newDescription = update.description && update.description.length > 0
      ? update.description
      : existing.description;
    const newRawText = update.raw_text ?? existing.raw_text ?? null;
    const newParseWarnings = Array.isArray(update.parse_warnings)
      ? JSON.stringify(update.parse_warnings)
      : existing.parse_warnings && existing.parse_warnings.length > 0
        ? JSON.stringify(existing.parse_warnings)
        : '[]';

    this.db
      .prepare(
        `UPDATE properties
         SET price = ?,
             direct_contact = ?,
             location = ?,
             maps_url = ?,
             latitude = ?,
             longitude = ?,
             posted_at = ?,
             electricity = ?,
             water = ?,
             cleaning = ?,
             restrictions = ?,
             pet_friendly = ?,
             primary_landmark = ?,
             landmarks = ?,
             marketing_landmarks = ?,
             description = ?,
             raw_text = ?,
             parse_warnings = ?,
             updated_at = (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         WHERE id = ?`,
      )
      .run(
        newPrice,
        JSON.stringify(contact),
        newLocation,
        newMapsUrl,
        newLat,
        newLng,
        newPostedAt,
        newElectricity,
        newWater,
        newCleaning,
        newRestrictions,
        newPetFriendly,
        newPrimaryLandmark,
        newLandmarks,
        newMarketingLandmarks,
        newDescription,
        newRawText,
        newParseWarnings,
        id,
      );

    return this.getPropertyById(id);
  }

  /**
   * Records a successful re-verification pass — drives smart-queue cadence.
   */
  markVerified(id: number): void {
    this.db
      .prepare(
        `UPDATE properties
         SET last_verified_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`,
      )
      .run(id);
  }

  /**
   * Direct field updates used by the verifier (price sync, corrected location).
   * Unlike bumpAndMerge this applies the value as-is — the verifier only calls
   * it when the source page proved a change.
   */
  updateVerifiedFields(
    id: number,
    fields: { price?: number; location?: string; city?: CityKey },
  ): void {
    const sets: string[] = [];
    const args: Array<number | string> = [];
    if (fields.price !== undefined) { sets.push('price = ?'); args.push(fields.price); }
    if (fields.location !== undefined) { sets.push('location = ?'); args.push(fields.location); }
    if (fields.city !== undefined) { sets.push('city = ?'); args.push(fields.city); }
    if (sets.length === 0) return;
    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`);
    this.db
      .prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id);
  }

  /**
   * Smart-queue selection: active listings due for re-verification.
   *  - fresh (<7 days old):  re-check every 12h
   *  - mid   (7–30 days):    every 72h
   *  - old   (>30 days):     every 7d
   * Never-verified listings (NULL) are always due and sort first.
   */
  findDueForVerification(limit = 50): Property[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM properties
         WHERE is_active = 1
           AND (
             last_verified_at IS NULL
             OR (
               COALESCE(posted_at, created_at) >= datetime('now', '-7 days')
               AND last_verified_at <= datetime('now', '-12 hours')
             )
             OR (
               COALESCE(posted_at, created_at) < datetime('now', '-7 days')
               AND COALESCE(posted_at, created_at) >= datetime('now', '-30 days')
               AND last_verified_at <= datetime('now', '-72 hours')
             )
             OR (
               COALESCE(posted_at, created_at) < datetime('now', '-30 days')
               AND last_verified_at <= datetime('now', '-7 days')
             )
           )
         ORDER BY last_verified_at IS NOT NULL ASC, last_verified_at ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  /**
   * Returns recent properties in the same city and area/location for deduplication checks.
   * Restricts search to properties active within the last 45 days.
   */
  findRecentPropertiesForDedup(city: CityKey, location: string, limit = 50): Property[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM properties
         WHERE city = ? AND (location LIKE ? OR location = ?) AND (is_active = 1 OR review_status = 'pending')
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

    if (options.petFriendly === true) {
      whereClauses.push('pet_friendly = 1');
    }

    if (options.primaryLandmark) {
      whereClauses.push('primary_landmark = ?');
      params.push(options.primaryLandmark);
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
   * Lightweight query for map markers with optional Bounding Box & 20% overscan buffer.
   */
  getPropertiesForMap(
    city: CityKey,
    options: {
      category?: string;
      type?: 'rent' | 'sale';
      limit?: number;
      bounds?: MapBoundingBox;
    } = {},
  ): Property[] {
    const whereClauses: string[] = ['is_active = 1', 'city = ?', 'latitude IS NOT NULL', 'longitude IS NOT NULL'];
    const params: Array<string | number> = [city];

    if (options.category) {
      whereClauses.push('category = ?');
      params.push(options.category);
    }

    if (options.type) {
      whereClauses.push('type = ?');
      params.push(options.type);
    }

    if (options.bounds) {
      const { minLat, maxLat, minLng, maxLng, paddingRatio = 0.2 } = options.bounds;
      const latDelta = Math.abs(maxLat - minLat) * paddingRatio;
      const lngDelta = Math.abs(maxLng - minLng) * paddingRatio;
      const queryMinLat = Math.min(minLat, maxLat) - latDelta;
      const queryMaxLat = Math.max(minLat, maxLat) + latDelta;
      const queryMinLng = Math.min(minLng, maxLng) - lngDelta;
      const queryMaxLng = Math.max(minLng, maxLng) + lngDelta;

      whereClauses.push(
        'latitude >= ?',
        'latitude <= ?',
        'longitude >= ?',
        'longitude <= ?',
      );
      params.push(queryMinLat, queryMaxLat, queryMinLng, queryMaxLng);
    }

    const limit = Math.min(options.limit ?? 300, 500);
    const sql = `SELECT * FROM properties WHERE ${whereClauses.join(' AND ')} ORDER BY COALESCE(posted_at, created_at) DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as PropertyRow[];
    return rows.map(rowToProperty);
  }

  /**
   * Aggregates listings without exact GPS pins by Sangkat / neighborhood,
   * returning clean centroids with listing counts and price ranges.
   */
  getSangkatClustersForMap(
    city: CityKey,
    options: {
      category?: string;
      type?: 'rent' | 'sale';
      bounds?: MapBoundingBox;
    } = {},
  ): Array<{
    location: string;
    locationKey: string | null;
    count: number;
    minPriceUsd: number;
    maxPriceUsd: number;
    lat: number;
    lng: number;
  }> {
    const whereClauses: string[] = ['is_active = 1', 'city = ?', '(latitude IS NULL OR longitude IS NULL)', "location != ''"];
    const params: Array<string | number> = [city];

    if (options.category) {
      whereClauses.push('category = ?');
      params.push(options.category);
    }
    if (options.type) {
      whereClauses.push('type = ?');
      params.push(options.type);
    }

    const sql = `
      SELECT MIN(location) as location, location_key, COUNT(*) as count, MIN(price) as min_price, MAX(price) as max_price
      FROM properties
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY COALESCE(location_key, city || ':' || location)
      ORDER BY count DESC
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      location: string;
      location_key: string | null;
      count: number;
      min_price: number;
      max_price: number;
    }>;

    let queryMinLat = -90;
    let queryMaxLat = 90;
    let queryMinLng = -180;
    let queryMaxLng = 180;

    if (options.bounds) {
      const { minLat, maxLat, minLng, maxLng, paddingRatio = 0.2 } = options.bounds;
      const latDelta = Math.abs(maxLat - minLat) * paddingRatio;
      const lngDelta = Math.abs(maxLng - minLng) * paddingRatio;
      queryMinLat = Math.min(minLat, maxLat) - latDelta;
      queryMaxLat = Math.max(minLat, maxLat) + latDelta;
      queryMinLng = Math.min(minLng, maxLng) - lngDelta;
      queryMaxLng = Math.max(minLng, maxLng) + lngDelta;
    }

    const clusters: Array<{
      location: string;
      locationKey: string | null;
      count: number;
      minPriceUsd: number;
      maxPriceUsd: number;
      lat: number;
      lng: number;
    }> = [];

    for (const r of rows) {
      const centroid = getSangkatCentroid(r.location, city);
      if (options.bounds) {
        if (
          centroid.lat < queryMinLat ||
          centroid.lat > queryMaxLat ||
          centroid.lng < queryMinLng ||
          centroid.lng > queryMaxLng
        ) {
          continue;
        }
      }

      clusters.push({
        location: r.location,
        locationKey: r.location_key,
        count: r.count,
        minPriceUsd: Math.round(r.min_price / 100),
        maxPriceUsd: Math.round(r.max_price / 100),
        lat: centroid.lat,
        lng: centroid.lng,
      });
    }

    return clusters;
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
        `SELECT MIN(location) as location, COUNT(*) as count
         FROM properties
         WHERE city = ? AND is_active = 1 AND location != ''
         GROUP BY COALESCE(location_key, city || ':' || location)
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

  approvePendingProperty(id: number): boolean {
    const result = this.db.prepare(
      `UPDATE properties
       SET review_status = 'approved', review_reason = NULL,
           is_active = CASE WHEN photos IS NOT NULL AND photos != '[]' THEN 1 ELSE 0 END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ? AND review_status = 'pending'`,
    ).run(id);
    return result.changes > 0;
  }

  rejectPendingProperty(id: number): boolean {
    const result = this.db.prepare(
      `UPDATE properties
       SET review_status = 'rejected', is_active = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ? AND review_status = 'pending'`,
    ).run(id);
    return result.changes > 0;
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
  petFriendly?: boolean;
  primaryLandmark?: string;
  minLeaseMax?: number;
  query?: string;
  sort?: 'newest' | 'price_asc' | 'price_desc';
  limit?: number;
  offset?: number;
}
