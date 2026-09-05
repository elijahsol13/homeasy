import crypto from 'crypto';
import { BulkImportSchema, RawListingSchema, type BulkIngestResult, type CleanProperty, type IngestResult } from './schemas';
import { normalizeText } from './normalizer';
import {
  extractBathrooms,
  extractBedrooms,
  extractCategory,
  extractDeposit,
  extractHasPool,
  extractLocation,
  extractMapsUrl,
  extractMinLease,
  extractPrice,
  extractType,
} from './extractor';
import type { PropertiesRepository } from '../../database/repositories/properties.repo';
import { checkDuplicate, computeListingPhashes } from '../matcher/deduplicator';
import type { MatcherService } from '../matcher/matcher';
import type { CityKey, PropertyCategory } from '../../config/settings';
import { isNonRealEstateSpam } from '../../database/enrich-properties';

// ─── Hash (Fallback fingerprint) ──────────────────────────────────────────────

export function computeContentHash(fields: {
  title: string;
  price: number;
  location: string;
  type: string;
}): string {
  const canonical = [
    fields.title.toLowerCase().trim(),
    fields.price,
    fields.location.toLowerCase().trim(),
    fields.type,
  ].join('|');

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ─── Normalization pipeline ───────────────────────────────────────────────────

export function normalizeRawToClean(
  raw: ReturnType<typeof RawListingSchema.parse>,
): CleanProperty | null {
  const combinedText = [raw.title, raw.description, raw.location, raw.city]
    .filter(Boolean)
    .join(' ');

  const title = raw.title ? normalizeText(raw.title) : 'Real Estate Listing';
  const description = raw.description ? normalizeText(raw.description) : '';

  // ── Price ──────────────────────────────────────────────────────────────────
  let priceCents = 0;
  let currency: 'USD' | 'KHR' = 'USD';

  if (raw.price !== undefined) {
    const priceStr = String(raw.price) + ' ' + (raw.currency ?? '');
    const extracted = extractPrice(priceStr);

    if (extracted) {
      priceCents = extracted.amountCents;
      currency = extracted.currency;
    } else {
      const num = parseFloat(String(raw.price).replace(/[^0-9.]/g, ''));
      if (!isNaN(num)) {
        const curr = (raw.currency ?? 'USD').toUpperCase();
        currency = curr === 'KHR' ? 'KHR' : 'USD';
        priceCents =
          currency === 'KHR' ? Math.round((num / 4_100) * 100) : Math.round(num * 100);
      }
    }
  } else {
    const extracted = extractPrice(combinedText);
    if (extracted) {
      priceCents = extracted.amountCents;
      currency = extracted.currency;
    }
  }

  // ── Type ───────────────────────────────────────────────────────────────────
  const rawType = raw.type?.toLowerCase();
  const type: 'rent' | 'sale' =
    rawType === 'sale'
      ? 'sale'
      : rawType === 'rent'
        ? 'rent'
        : (extractType(combinedText) ?? 'rent');

  // ── Category ───────────────────────────────────────────────────────────────
  const extractedCat = extractCategory(combinedText);
  let category: PropertyCategory | null =
    (raw.category as PropertyCategory | undefined) ?? extractedCat;
  if (extractedCat === 'hotel') {
    category = 'hotel';
  }

  // ── Bedrooms ───────────────────────────────────────────────────────────────
  let bedrooms: number | null = null;
  if (raw.bedrooms !== undefined && raw.bedrooms !== null) {
    const n = parseInt(String(raw.bedrooms), 10);
    bedrooms = isNaN(n) ? extractBedrooms(combinedText) : n;
  } else {
    bedrooms = extractBedrooms(combinedText);
  }
  if (bedrooms === null && (category === 'room' || category === 'hotel')) {
    bedrooms = 1;
  }

  // ── Bathrooms ──────────────────────────────────────────────────────────────
  let bathrooms: number | null = null;
  if (raw.bathrooms !== undefined && raw.bathrooms !== null) {
    const n = parseInt(String(raw.bathrooms), 10);
    bathrooms = isNaN(n) ? extractBathrooms(combinedText) : n;
  } else {
    bathrooms = extractBathrooms(combinedText);
  }

  // ── Location & city ────────────────────────────────────────────────────────
  let location = '';
  const rawCityLower = (raw.city ?? '').toLowerCase();
  const detectedCity: CityKey | null =
    rawCityLower.includes('phnom') || rawCityLower.includes('penh')
      ? 'phnom_penh'
      : rawCityLower.includes('siem') || rawCityLower.includes('reap')
        ? 'siem_reap'
        : null;

  let city: CityKey =
    detectedCity ??
    (raw.city === 'phnom_penh' ? 'phnom_penh' : 'siem_reap');

  const locationSearch = [raw.location, raw.city, raw.title, raw.description]
    .filter(Boolean)
    .join(' ');
  const extracted = extractLocation(locationSearch);

  if (extracted) {
    location = extracted.location;
    city = extracted.city;
  } else if (raw.location && raw.location.trim().length > 0 && raw.location.toLowerCase() !== 'null') {
    location = normalizeText(raw.location);
  }

  const photos = (raw.photos ?? []).filter(
    (u) => u.startsWith('http://') || u.startsWith('https://'),
  );

  const mapsUrl = raw.maps_url ?? extractMapsUrl(combinedText);
  const sourceUrl = raw.source_url ?? raw.url ?? '';

  // ── Deposit & Min Lease & Pool ─────────────────────────────────────────────
  let deposit: number | null = null;
  if (raw.deposit !== undefined && raw.deposit !== null) {
    const n = parseFloat(String(raw.deposit).replace(/[^0-9.]/g, ''));
    deposit = isNaN(n) ? null : Math.round(n * 100);
  } else {
    deposit = extractDeposit(combinedText);
  }

  let minLease: number | null = null;
  if (raw.min_lease !== undefined && raw.min_lease !== null) {
    const n = parseInt(String(raw.min_lease), 10);
    minLease = isNaN(n) ? null : n;
  } else {
    minLease = extractMinLease(combinedText);
  }

  const hasPool =
    raw.has_pool !== undefined ? Boolean(raw.has_pool) : extractHasPool(combinedText);

  // Direct contact: phone and telegram username
  const directContact: CleanProperty['direct_contact'] = {};
  if (raw.phone) directContact.phone = normalizeText(raw.phone);
  if (raw.telegram_contact) directContact.telegram = normalizeText(raw.telegram_contact);

  return {
    title,
    description,
    price: priceCents,
    currency,
    type,
    category,
    bedrooms,
    bathrooms,
    deposit,
    min_lease: minLease,
    has_pool: hasPool,
    location,
    city,
    photos,
    image_phash: null,
    image_phashes: [],
    direct_contact: directContact,
    maps_url: mapsUrl,
    source_url: sourceUrl,
    original_url: raw.url ?? sourceUrl,
    posted_at: raw.posted_at ?? null,
  };
}

// ─── Ingestion Service ────────────────────────────────────────────────────────

export class IngestionService {
  constructor(
    private readonly propertiesRepo: PropertiesRepository,
    private readonly matcherService: MatcherService,
  ) {}

  /**
   * Main ingest pipeline:
   * 1. Normalises payload into CleanProperty.
   * 2. Computes multi-image pHash for up to 3 photos.
   * 3. Checks for duplicates via deduplicator engine:
   *    a) Phase 1: Multi-image pHash match (Hamming distance <= 5 for >= 2 images).
   *    b) Phase 2: Weighted similarity scoring (>= 75 pts on price, beds/baths, phone, category).
   *    c) Exact content hash match.
   * 4. Inserts clean property into database.
   * 5. Triggers matching & notification engine asynchronously.
   */
  async ingestRawListing(rawPayload: unknown): Promise<IngestResult> {
    const parseResult = RawListingSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      return {
        status: 'error',
        error: `Validation failed: ${parseResult.error.message}`,
      };
    }

    // Pre-Ingestion Spam & Non-Real-Estate Check
    const title = parseResult.data.title ?? '';
    const { isSpam, reason } = isNonRealEstateSpam(title, parseResult.data.description || '');
    if (isSpam) {
      console.log(`🚫 [Ingestor] Spam listing rejected ("${title.slice(0, 40)}..."): ${reason}`);
      return {
        status: 'error',
        error: `Spam rejected: ${reason}`,
      };
    }

    const clean = normalizeRawToClean(parseResult.data);
    if (!clean) {
      return {
        status: 'error',
        error: 'Could not extract required fields (title, location) from payload',
      };
    }

    // ── Step 1: Compute Perceptual Hashes for up to 3 Photos ───────────────────
    const imagePhashes = await computeListingPhashes(clean.photos, 3);
    clean.image_phashes = imagePhashes;
    clean.image_phash = imagePhashes[0] ?? null;

    // ── Step 2: High-Accuracy Scoring-Based Deduplication Check ────────────────
    const recentCandidates = this.propertiesRepo.findRecentPropertiesForDedup(clean.city, clean.location, 50);
    const dedupResult = checkDuplicate(clean, recentCandidates);

    if (dedupResult.isDuplicate) {
      console.log(`🔁 [Dedup] ${dedupResult.reason}`);
      if (dedupResult.duplicateOfId) {
        this.propertiesRepo.bumpAndMerge(dedupResult.duplicateOfId, {
          price: clean.price,
          phone: clean.direct_contact?.phone,
          location: clean.location,
          maps_url: clean.maps_url ?? undefined,
          posted_at: clean.posted_at,
          source_url: clean.source_url ?? undefined,
        });
        console.log(`  ✨ [Smart Merge] Bumped & enriched canonical listing #${dedupResult.duplicateOfId}`);
      }
      return {
        status: 'duplicate',
        duplicateOfId: dedupResult.duplicateOfId,
        image_phash: clean.image_phash,
        image_phashes: clean.image_phashes,
        reason: dedupResult.reason,
      };
    }

    // ── Step 3: Exact Content Hash Check ───────────────────────────────────────
    const hash = computeContentHash({
      title: clean.title,
      price: clean.price,
      location: clean.location,
      type: clean.type,
    });

    const existingByHash = this.propertiesRepo.findByHash(hash);
    if (existingByHash) {
      console.log(`🔁 [Dedup] Exact content hash match with listing #${existingByHash.id}`);
      this.propertiesRepo.bumpAndMerge(existingByHash.id, {
        price: clean.price,
        phone: clean.direct_contact?.phone,
        location: clean.location,
        maps_url: clean.maps_url ?? undefined,
        posted_at: clean.posted_at,
        source_url: clean.source_url ?? undefined,
      });
      console.log(`  ✨ [Smart Merge] Bumped & enriched canonical listing #${existingByHash.id}`);
      return {
        status: 'duplicate',
        duplicateOfId: existingByHash.id,
        hash,
        image_phash: clean.image_phash,
        image_phashes: clean.image_phashes,
        reason: `Exact content hash match with listing #${existingByHash.id}`,
      };
    }

    const property = this.propertiesRepo.insertProperty({
      ...clean,
      hash,
      image_phash: clean.image_phash,
      image_phashes: clean.image_phashes,
    });

    // ── Step 4: Trigger Matching Engine ─────────────────────────────────────────
    this.matcherService.matchAndNotify(property).catch((err: unknown) => {
      console.error('matchAndNotify error:', err);
    });

    return {
      status: 'inserted',
      propertyId: property.id,
      hash,
      image_phash: clean.image_phash,
      image_phashes: clean.image_phashes,
    };
  }

  /**
   * Bulk ingest: processes multiple listings sequentially.
   */
  async bulkIngest(rawPayload: unknown): Promise<BulkIngestResult> {
    const parseResult = BulkImportSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      throw new Error(`Invalid bulk payload: ${parseResult.error.message}`);
    }

    const items = Array.isArray(parseResult.data) ? parseResult.data : [parseResult.data];

    const results: IngestResult[] = [];
    let inserted = 0;
    let duplicates = 0;
    let errors = 0;

    for (const item of items) {
      const result = await this.ingestRawListing(item);
      results.push(result);
      if (result.status === 'inserted') inserted++;
      else if (result.status === 'duplicate') duplicates++;
      else errors++;
    }

    return { total: items.length, inserted, duplicates, errors, results };
  }
}
