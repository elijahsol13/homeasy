import crypto from 'crypto';
import { BulkImportSchema, RawListingSchema, type BulkIngestResult, type CleanProperty, type IngestResult } from './schemas';
import { cleanPhotoUrls, extractDirectContacts, normalizeText } from './normalizer';
import {
  categoryFromPropertyType,
  extractAmenities,
  extractBathrooms,
  extractBedrooms,
  extractCategory,
  extractDeposit,
  extractElectricity,
  extractHasPool,
  extractLocation,
  extractMapsUrl,
  extractMinLease,
  extractPrice,
  extractType,
  extractWater,
} from './extractor';
import { escapeHtml, extractCleaning, extractRestrictions } from '../../services/notifier';
import { findLandmarksInText, inferCityFromLandmarks, inferLocationFromLandmark } from '../../config/landmarks';
import {
  extractCoordinatesFromMapsUrl,
  findCanonicalLocation,
  isCoordinateInSanityBounds,
} from '../../config/locations';
import type { PropertiesRepository } from '../../database/repositories/properties.repo';
import { checkDuplicate, computeListingPhashes } from '../matcher/deduplicator';
import type { MatcherService } from '../matcher/matcher';
import type { AlertService } from '../../services/alert.service';
import type { CityKey, PropertyCategory } from '../../config/settings';
import type { z } from 'zod';
import { SourceIngestionRepository } from '../../database/repositories/source-ingestion.repo';
import type { IngestionBatchResult, SourceAdapter, SourceRunContext } from './ingestion-contracts';
import { extractDeterministicMetadata } from './deterministic-metadata';
import type { RepostClusteringService } from './repost-clustering';
import type { CanonicalShadowService } from './canonical-dedupe';

type RawListing = z.infer<typeof RawListingSchema>;

function inferIsRealEstate(
  raw: RawListing,
  type: 'rent' | 'sale' | null,
  category: PropertyCategory | null,
  city: CityKey,
  priceCents: number,
  minLease: number | null,
): { is_real_estate: true; reason: string } | null {
  if (city !== 'siem_reap') return null;
  if (type && type !== 'rent') return null;
  const text = [raw.title ?? '', raw.description ?? ''].join('\n').toLowerCase();
  const saleSignals = /\b(for sale|sale|land for sale|house for sale|ដូរ|លក់|សម្រាប់លក់|sale price)\b/;
  const dailySignals = /\b(daily|nightly|per night|per day|day rent|homestay|guesthouse|guest house|ប្រចាំថ្ងៃ|រាល់ថ្ងៃ)\b/;
  const commercialSignals = /\b(commercial villa|commercial house|office space|shop house|business|warehouse|factory|ហាង|ការិយាល័យ|សាឡន)\b/;
  if (saleSignals.test(text)) return null;
  if (dailySignals.test(text) && (minLease ?? 0) < 7) return null;
  if (commercialSignals.test(text)) return null;
  // Require a canonical Siem Reap district in the location string to auto-approve.
  const canonical = findCanonicalLocation(raw.location ?? '');
  if (!canonical || canonical.city !== 'siem_reap') return null;
  if (type === 'rent' && priceCents > 0 && category && ['apartment', 'house', 'room', 'hotel'].includes(category)) {
    if (category === 'hotel' && (minLease ?? 0) < 1) return null;
    return {
      is_real_estate: true,
      reason: `Deterministic: ${category} monthly rental in ${canonical.canonicalName}`,
    };
  }
  return null;
}
import { isNonRealEstateSpam } from './spam-detector';

// ─── Hash (Fallback fingerprint) ──────────────────────────────────────────────

export function computeContentHash(fields: {
  title: string;
  price: number;
  location: string;
  type: string;
  bedrooms?: number | null;
  category?: string | null;
}): string {
  const canonical = [
    fields.title.toLowerCase().trim(),
    fields.price,
    fields.location.toLowerCase().trim(),
    fields.type,
    fields.bedrooms ?? '',
    fields.category ?? '',
  ].join('|');

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ─── Normalization pipeline ───────────────────────────────────────────────────

export function normalizeRawToClean(
  raw: ReturnType<typeof RawListingSchema.parse>,
): CleanProperty | null {
  // Extraction source: prefer the preserved raw post text — it still contains
  // price strings, map links, and location hints that AI normalization may
  // have stripped from `description`.
  const rawText = raw.raw_text?.trim() ? raw.raw_text : (raw.description ?? '');
  const combinedText = [raw.title, raw.description, raw.location, raw.city]
    .filter(Boolean)
    .join(' ');
  const extractionText = [raw.title, rawText, raw.location, raw.city]
    .filter(Boolean)
    .join(' ');

  const warnings: string[] = [];
  const hasCanonicalFacts = typeof raw.listing_facts_json === 'string' && raw.listing_facts_json.length > 0;
  let cleanReviewStatus: 'approved' | 'pending' = raw.review_status ?? 'approved';
  let cleanReviewReason: string | null = raw.review_reason ?? null;

  // Start with the LLM decision if it provided one; otherwise fall through to the
  // deterministic inference below before marking the record uncertain.
  let resolvedIsRealEstate: boolean | null = raw.is_real_estate ?? null;

  const title = raw.title ? normalizeText(raw.title) : 'Real Estate Listing';
  const description = raw.description ? normalizeText(raw.description) : '';

  // ── Type ───────────────────────────────────────────────────────────────────
  // Computed before price: currency sanity rules differ for rent vs sale.
  const rawType = raw.type?.toLowerCase();
  const type: 'rent' | 'sale' =
    rawType === 'sale'
      ? 'sale'
      : rawType === 'rent'
        ? 'rent'
        : (extractType(combinedText) ?? 'rent');

  // ── Price ──────────────────────────────────────────────────────────────────
  // Declared currency is unreliable on both platforms (FB posters pick whatever,
  // K24 defaults to USD). Resolved by magnitude:
  //   rent + amount < 10,000              → USD (even if marked KHR/riel)
  //   rent + amount ≥ 50,000, no "$"      → KHR @ 4,000
  //   explicit THB markers (฿/บาท/baht)   → KHR @ 4,000 (Cambodia listings
  //                                           frequently mis-label riel as baht)
  //   sale                                → USD unless explicit riel markers
  const toUsdCents = (n: number, cur: 'USD' | 'KHR'): number =>
    cur === 'KHR' ? Math.round((n / 4_000) * 100) : Math.round(n * 100);

  let amount: number | null = null;
  let declaredCurrency: string | null = null;
  let priceSourceText = '';

  if (typeof raw.price === 'number' && raw.price > 0) {
    amount = raw.price;
    declaredCurrency = raw.currency ?? null;
  } else if (raw.price !== undefined && raw.price !== null) {
    const str = String(raw.price);
    const num = parseFloat(str.replace(/[^0-9.]/g, ''));
    if (!isNaN(num) && num > 0) {
      amount = num;
      declaredCurrency = raw.currency ?? null;
      priceSourceText = `${str} ${raw.currency ?? ''}`;
    }
  }

  if (amount === null && !hasCanonicalFacts) {
    const extracted = extractPrice(extractionText);
    if (extracted) {
      amount = extracted.rawAmount;
      declaredCurrency = extracted.currency;
      priceSourceText = extractionText;
    }
  }

  if (amount === null && !hasCanonicalFacts && raw.price_hint !== undefined && raw.price_hint > 0) {
    amount = raw.price_hint;
    declaredCurrency = raw.price_hint_currency ?? 'USD';
  }

  let priceCents = 0;
  const currency: 'USD' | 'KHR' = 'USD';

  if (amount !== null && amount > 0) {
    const priceHaystack = [priceSourceText, String(raw.price ?? ''), raw.currency ?? '', rawText]
      .join(' ');
    const hasThbMarker =
      /฿|บาท|\bbaht\b/i.test(priceHaystack) ||
      String(declaredCurrency ?? '').toUpperCase() === 'THB';
    const hasDollarSign = /\$\s*\d|\bUSD\b/i.test(priceSourceText) ||
      String(declaredCurrency ?? '').toUpperCase() === 'USD';
    const hasKhrMarker = /៛|\briel\b|\bKHR\b/i.test(priceHaystack);

    let finalCur: 'USD' | 'KHR';
    // In Cambodia listings, a ฿/baht marker is almost always a mistagged riel
    // price, not an actual Thai baht value. Treat it as KHR.
    if (hasThbMarker && !hasDollarSign && amount >= 1_000) {
      finalCur = 'KHR';
    } else if (hasCanonicalFacts && (declaredCurrency === 'USD' || declaredCurrency === 'KHR')) {
      finalCur = declaredCurrency;
    } else if (type === 'rent') {
      finalCur = amount >= 50_000 && !hasDollarSign ? 'KHR' : 'USD';
      // $10k+/mo rent is virtually always a mis-tagged sale or a currency error.
      if (amount >= 10_000 && finalCur !== 'KHR') {
        warnings.push('price_suspicious');
      }
    } else {
      finalCur = hasKhrMarker && !hasDollarSign && amount >= 500_000 ? 'KHR' : 'USD';
    }

    priceCents = toUsdCents(amount, finalCur);
    if (finalCur === 'KHR') warnings.push('currency_converted:KHR');
    if (hasThbMarker && finalCur === 'KHR') warnings.push('currency_converted:THB_as_KHR');
  }

  if (priceCents === 0) warnings.push('price_missing');

  // ── Category ───────────────────────────────────────────────────────────────
  const validCategories: readonly string[] = ['apartment', 'house', 'room', 'hotel'];
  const rawCategory = raw.category?.toLowerCase();
  const normalizedRawCategory = rawCategory && validCategories.includes(rawCategory)
    ? (rawCategory as PropertyCategory)
    : null;
  const extractedCat = hasCanonicalFacts ? null : extractCategory(combinedText);
  let category: PropertyCategory | null = normalizedRawCategory ?? extractedCat;
  if (extractedCat === 'hotel') {
    category = 'hotel';
  }

  // If the LLM returned a property_type, the dedicated property_type→category
  // mapping is the most reliable signal and should override a miscategorized
  // category (e.g. a house mislabeled as hotel because a hotel name appeared as
  // a nearby landmark).
  const derivedFromPropertyType = categoryFromPropertyType(raw.property_type ?? undefined);
  if (derivedFromPropertyType) {
    category = derivedFromPropertyType;
  }

  // ── Bedrooms ───────────────────────────────────────────────────────────────
  let bedrooms: number | null = null;
  if (raw.bedrooms !== undefined && raw.bedrooms !== null) {
    const n = parseInt(String(raw.bedrooms), 10);
    bedrooms = isNaN(n) ? (hasCanonicalFacts ? null : extractBedrooms(combinedText)) : n;
  } else {
    bedrooms = hasCanonicalFacts ? null : extractBedrooms(combinedText);
  }
  if (!hasCanonicalFacts && bedrooms === null && (category === 'room' || category === 'hotel')) {
    bedrooms = 1;
  }

  // ── Bathrooms ──────────────────────────────────────────────────────────────
  let bathrooms: number | null = null;
  if (raw.bathrooms !== undefined && raw.bathrooms !== null) {
    const n = parseInt(String(raw.bathrooms), 10);
    bathrooms = isNaN(n) ? (hasCanonicalFacts ? null : extractBathrooms(combinedText)) : n;
  } else {
    bathrooms = hasCanonicalFacts ? null : extractBathrooms(combinedText);
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

  // If well-known landmarks in the text all point to a different city than the
  // scraped page assumed, trust the landmarks (e.g. "near Pochentong Airport" on
  // a Siem Reap browse page).
  const inferredCity = hasCanonicalFacts ? null : inferCityFromLandmarks(combinedText);
  if (inferredCity && inferredCity !== city) {
    city = inferredCity;
    warnings.push(`city_inferred_from_landmark:${inferredCity}`);
  }

  // Cross-check the explicit location string against the canonical catalog: a listing
  // can be cross-posted to the wrong city's browse page (e.g. Phnom Penh ad on
  // the Siem Reap page). When the canonical city from the address disagrees with
  // the scraped city, trust the address.
  if (raw.location) {
    const canonicalFromLocation = findCanonicalLocation(raw.location);
    if (canonicalFromLocation && canonicalFromLocation.city !== city) {
      city = canonicalFromLocation.city;
      warnings.push(`city_corrected_from_location:${canonicalFromLocation.city}`);
    }
  }

  const locationSearch = [raw.location, raw.city, raw.title, raw.description]
    .filter(Boolean)
    .join(' ');
  // When the scraper already told us the city reliably (Khmer24 category page / Facebook
  // group are both single-city, assigned at scrape time), restrict the district search to
  // that city only. Otherwise post text mentioning the OTHER city for marketing/comparison
  // purposes (e.g. "cheaper than BKK1") can silently flip the listing into the wrong city tab.
  const extracted = hasCanonicalFacts ? null : extractLocation(locationSearch, detectedCity ?? undefined);

  if (extracted) {
    location = extracted.location;
    if (!detectedCity) {
      city = extracted.city;
    }
  } else if (raw.location && raw.location.trim().length > 0 && raw.location.toLowerCase() !== 'null') {
    location = normalizeText(raw.location);
    warnings.push(`location_unrecognized:${raw.location.trim().slice(0, 40)}`);
  }

  // Platform-provided commerce location (FB "Sell" attachments): use only as a
  // fallback when nothing else resolved — and only when it canonically resolves
  // inside our scope (it can name out-of-scope cities like Battambang).
  if (!location && raw.commerce_location) {
    const comm = findCanonicalLocation(raw.commerce_location);
    if (comm) {
      location = comm.canonicalName;
      if (!detectedCity) city = comm.city;
    } else {
      warnings.push(`commerce_location_unresolved:${raw.commerce_location.trim().slice(0, 40)}`);
    }
  }

  // If the location is still empty or just the generic city name, try to map a
  // known physical landmark mention to its canonical sangkat.
  const genericCityName = /^(siem\s*reap|phnom\s*penh|sihanoukville|kampot)$/i;
  if (!hasCanonicalFacts && (!location || genericCityName.test(location.trim())) && city === 'siem_reap') {
    const inferred = inferLocationFromLandmark(combinedText, city);
    if (inferred) {
      location = inferred.canonicalName;
      warnings.push(`location_inferred_from_landmark:${inferred.sourceLandmark}`);
    }
  }

  if (!location) warnings.push('location_missing');

  const photos = cleanPhotoUrls(raw.photos);

  // Google Maps link: prefer explicit field, then scan the RAW post text
  // (AI normalization may strip links from the cleaned description).
  let mapsUrl = raw.maps_url ?? extractMapsUrl(rawText) ?? extractMapsUrl(combinedText);

  // Trust-but-verify: when the link carries parseable coordinates they must land
  // inside the listing's city bounds — otherwise the pin is bogus and we drop it.
  const linkCoords = mapsUrl ? extractCoordinatesFromMapsUrl(mapsUrl) : null;
  if (linkCoords && !isCoordinateInSanityBounds(linkCoords.latitude, linkCoords.longitude, city)) {
    warnings.push('maps_rejected_out_of_bounds');
    mapsUrl = null;
  }

  const sourceUrl = raw.source_url ?? raw.url ?? '';

  // ── Deposit & Min Lease & Pool ─────────────────────────────────────────────
  let deposit: number | null = null;
  if (raw.deposit !== undefined && raw.deposit !== null) {
    const n = parseFloat(String(raw.deposit).replace(/[^0-9.]/g, ''));
    deposit = isNaN(n) ? null : Math.round(n * 100);
  }
  // Deposit expressed as "N months" must be kept separate from a dollar amount and
  // only converted when the monthly rent is known. Never treat `deposit_months: 1` as $1.
  if (!hasCanonicalFacts && deposit === null && raw.deposit_months !== undefined && raw.deposit_months !== null) {
    const months = parseInt(String(raw.deposit_months), 10);
    if (!isNaN(months) && months > 0 && months <= 12) {
      if (priceCents > 0) {
        deposit = priceCents * months;
      } else {
        warnings.push('deposit_months_without_rent');
      }
    }
  }
  if (deposit === null && !hasCanonicalFacts) {
    deposit = extractDeposit(combinedText, priceCents);
  }

  let minLease: number | null = null;
  if (raw.min_lease !== undefined && raw.min_lease !== null) {
    const n = parseInt(String(raw.min_lease), 10);
    minLease = isNaN(n) ? null : n;
  } else {
    minLease = hasCanonicalFacts ? null : extractMinLease(combinedText);
  }

  // When the LLM is uncertain (returns null) or a weak fallback model misclassifies
  // an obvious rental, fall back to deterministic signals before marking pending.
  if (resolvedIsRealEstate === null || resolvedIsRealEstate === undefined) {
    const inferred = inferIsRealEstate(raw, type, category, city, priceCents, minLease);
    if (inferred) {
      resolvedIsRealEstate = inferred.is_real_estate;
      cleanReviewReason = inferred.reason;
      warnings.push('is_real_estate_inferred');
    }
  }

  // Fail-closed admission: a missing or uncertain is_real_estate decision means the
  // record must not publish automatically. Preserve it as inactive pending review.
  if (resolvedIsRealEstate === null || resolvedIsRealEstate === undefined) {
    cleanReviewStatus = 'pending';
    cleanReviewReason = cleanReviewReason ?? 'Admission decision missing or uncertain';
    warnings.push('is_real_estate_uncertain');
  }

  const hasPool: boolean | null =
    raw.has_pool === true || raw.has_pool === 1 || raw.has_pool === '1' || raw.has_pool === 'true'
      ? true
      : raw.has_pool === false || raw.has_pool === 0 || raw.has_pool === '0' || raw.has_pool === 'false'
        ? false
        : hasCanonicalFacts ? null : extractHasPool(combinedText);

  // Direct contact: phone, telegram, whatsapp with disambiguation and domestic mask
  const contacts = extractDirectContacts(combinedText, {
    rawPhone: raw.phone,
    rawTelegram: raw.telegram_contact,
  });
  const directContact: CleanProperty['direct_contact'] = {};
  if (contacts.phone) directContact.phone = contacts.phone;
  if (contacts.telegram) directContact.telegram = contacts.telegram;
  if (contacts.whatsapp) directContact.whatsapp = contacts.whatsapp;

  // ── Utilities, Restrictions, Landmarks & Pet-Friendly ──────────────────────
  // Use LLM-passed values first, fall back to regex heuristics
  const electricity = raw.electricity ?? (hasCanonicalFacts ? null : extractElectricity(combinedText));
  const water = raw.water ?? (hasCanonicalFacts ? null : extractWater(combinedText));
  const cleaning = raw.cleaning ?? (hasCanonicalFacts ? null : extractCleaning(combinedText));
  const restrictions = (raw.restrictions && raw.restrictions.length > 0)
    ? raw.restrictions
    : hasCanonicalFacts ? [] : extractRestrictions(combinedText);
  const hasPetRestriction = restrictions.includes('🚫 No Pets');
  const rawPetFriendly: boolean | null =
    raw.pet_friendly === true || raw.pet_friendly === 1 || raw.pet_friendly === '1' || raw.pet_friendly === 'true'
      ? true
      : raw.pet_friendly === false || raw.pet_friendly === 0 || raw.pet_friendly === '0' || raw.pet_friendly === 'false'
        ? false
        : null;
  const petFriendly: boolean | null = rawPetFriendly !== null
    ? rawPetFriendly
    : hasPetRestriction
      ? false
      : !hasCanonicalFacts && /\b(?:pet friendly|pets allowed)\b/i.test(combinedText)
        ? true
        : null;
  const landmarkEntries = hasCanonicalFacts ? [] : findLandmarksInText(combinedText, city);
  // Physical landmarks only — marketing claims ("5 min to Pub Street") are kept
  // separate in marketing_landmarks and never feed location/matching logic.
  const landmarks = landmarkEntries.map((l) => l.canonicalName);
  const marketingLandmarks = Array.from(new Set(raw.marketing_landmarks || []));
  const primaryLandmark = landmarks[0] ?? null;

  const coords = linkCoords;
  const rawLat = raw.latitude !== undefined && raw.latitude !== null ? parseFloat(String(raw.latitude)) : NaN;
  const rawLng = raw.longitude !== undefined && raw.longitude !== null ? parseFloat(String(raw.longitude)) : NaN;
  const latOk =
    !isNaN(rawLat) && !isNaN(rawLng) && isCoordinateInSanityBounds(rawLat, rawLng, city);
  const latitude = coords ? coords.latitude : latOk ? rawLat : null;
  const longitude = coords ? coords.longitude : latOk ? rawLng : null;
  if (!isNaN(rawLat) && !isNaN(rawLng) && !latOk) {
    warnings.push('coords_rejected_out_of_bounds');
  }

  // Land/commercial listings are out of scope for the current MVP. Preserve the
  // record as inactive pending review rather than silently discarding it.
  const propertyTypeLower = (raw.property_type ?? '').toLowerCase();
  if (
    (raw.category ?? '').toLowerCase() === 'land' ||
    propertyTypeLower.includes('commercial') ||
    propertyTypeLower.includes('warehouse') ||
    propertyTypeLower.includes('office') ||
    propertyTypeLower.includes('shop') ||
    propertyTypeLower.includes('restaurant')
  ) {
    warnings.push('land_or_commercial_out_of_scope');
    cleanReviewStatus = 'pending';
    cleanReviewReason = cleanReviewReason ?? 'Land/commercial property outside current MVP scope';
  }

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
    electricity,
    water,
    cleaning,
    restrictions,
    pet_friendly: petFriendly,
    primary_landmark: primaryLandmark,
    landmarks,
    marketing_landmarks: marketingLandmarks,
    latitude,
    longitude,
    property_type: raw.property_type ?? null,
    amenities: Array.from(new Set([...(raw.amenities ?? []), ...(hasCanonicalFacts ? [] : extractAmenities(combinedText))])),
    raw_text: raw.raw_text ?? rawText,
    listing_facts_json: raw.listing_facts_json ?? null,
    parse_warnings: cleanReviewStatus === 'pending' ? [...warnings, 'review_pending'] : warnings,
    review_status: cleanReviewStatus,
    review_reason: cleanReviewReason,
  };
}

// ─── Ingestion Service ────────────────────────────────────────────────────────

export class IngestionService {
  constructor(
    private readonly propertiesRepo: PropertiesRepository,
    private readonly matcherService: MatcherService,
    private readonly alertService?: AlertService,
    private readonly sourceIngestionRepo?: SourceIngestionRepository,
    private readonly repostClusteringService?: RepostClusteringService,
    private readonly canonicalShadowService?: CanonicalShadowService,
  ) {}

  /** Shadow raw ingestion path. It never calls LLMs and never writes legacy properties. */
  async ingestBatch<T>(adapter: SourceAdapter<T>, context: SourceRunContext): Promise<IngestionBatchResult> {
    if (!this.sourceIngestionRepo) throw new Error('SourceIngestionRepository is required for unified ingestion');
    const repo = this.sourceIngestionRepo;
    const result: IngestionBatchResult = {
      inputItems: 0, processedItems: 0, newSources: 0, newSourceItems: 0,
      updatedSourceItems: 0, unchangedSourceItems: 0, newVersions: 0,
      errors: [], classificationCounts: {}, identifierCounts: {}, providerCounts: {}, items: [],
      incrementalRepostItems: 0, incrementalRepostClustersCreated: 0, incrementalRepostClustersUpdated: 0,
      incrementalCanonicalItems: 0, occurrencesAttached: 0, canonicalBindingsUpdated: 0,
      repurposedBindingsClosed: 0, needsGlobalCanonicalMatch: 0, canonicalInconsistencies: 0,
      globalCanonicalRuns: 0, globalCanonicalProperties: 0, globalCanonicalListings: 0,
      dryRun: Boolean(context.dryRun),
    };
    const runId = context.dryRun ? undefined : repo.createRun(context.runType);
    if (runId !== undefined) result.runId = runId;
    const sourceIds = new Map<string, { id: number; inserted: boolean }>();
    const newSourceKeys = new Set<string>();
    const dryRunItems = new Map<string, string | null>();
    const sourceCounts = new Map<string, { input: number; success: number; failed: number }>();
    const globalCanonicalIds = new Set<number>();
    const observedAt = context.observedAt ?? new Date().toISOString();

    for await (const raw of adapter.fetchNewItems(context)) {
      result.inputItems++;
      let externalId: string | undefined;
      let sourceKey = '';
      try {
        let item = adapter.normalize(raw);
        externalId = item.externalId;
        sourceKey = repo.makeSourceKey(item.sourceIdentity);
        let didProcessChangedItem = false;
        const priorSourceId = repo.findSourceId(sourceKey);
        const priorState = priorSourceId === undefined ? undefined : repo.findSourceItemState(priorSourceId, item.externalId);
        const sourceContentChanged = !priorState || priorState.contentHash !== (item.contentHash ?? null);
        const sourceMediaChanged = !priorState || priorState.mediaHash !== (item.mediaHash ?? null);
        if (adapter.processNewOrChanged && !context.dryRun) {
          const sourceRegistryId = priorSourceId;
          const existing = priorState;
          const contentChanged = !existing || existing.contentHash !== (item.contentHash ?? null);
          const mediaChanged = !existing || existing.mediaHash !== (item.mediaHash ?? null);
          const needsRetry = Boolean(existing && (existing.classification === 'UNCLASSIFIED' || existing.classification == null));
          if (existing && !contentChanged && mediaChanged) {
            let previous: unknown = {};
            try { previous = JSON.parse(existing.rawPayloadJson || '{}'); } catch { /* keep incoming payload */ }
            if (previous && typeof previous === 'object' && item.raw && typeof item.raw === 'object') {
              item = { ...item, raw: { ...(previous as Record<string, unknown>), ...(item.raw as Record<string, unknown>) } as T };
            }
          } else if (contentChanged || needsRetry) {
            const status = !existing ? 'new' : needsRetry && !contentChanged ? 'retry' : 'changed';
            item = await adapter.processNewOrChanged(raw, item, { status, contentChanged, mediaChanged, run: context });
            didProcessChangedItem = true;
          }
        }
        const identifiers = extractDeterministicMetadata(item.rawText ?? '', {
          phoneNumbers: item.deterministicIdentifiers?.filter((entry) => entry.type === 'PHONE').map((entry) => entry.rawValue ?? '').filter(Boolean),
          mapsUrls: item.deterministicIdentifiers?.filter((entry) => entry.type === 'MAPS_URL').map((entry) => entry.rawValue ?? '').filter(Boolean),
          telegramLinks: item.deterministicIdentifiers?.filter((entry) => entry.type === 'TELEGRAM').map((entry) => entry.rawValue ?? '').filter(Boolean),
        });
        const classification = item.classification ?? 'UNCLASSIFIED';
        result.classificationCounts[classification] = (result.classificationCounts[classification] ?? 0) + 1;
        for (const identifier of identifiers) {
          result.identifierCounts[identifier.type] = (result.identifierCounts[identifier.type] ?? 0) + 1;
        }
        const existingSourceId = repo.findSourceId(sourceKey);
        const source = sourceIds.get(sourceKey) ?? {
          id: existingSourceId ?? 0,
          inserted: existingSourceId === undefined,
        };
        const sourceItemInput = {
          sourceType: item.sourceIdentity.sourceType,
          externalId: item.externalId,
          canonicalUrl: item.canonicalUrl,
          sourceUrl: item.sourceUrl,
          groupId: item.groupId,
          groupName: item.groupName,
          authorExternalId: item.authorExternalId,
          authorName: item.authorName,
          authorUrl: item.authorUrl,
          rawText: item.rawText,
          rawPayload: item.raw,
          contentHash: item.contentHash,
          mediaHash: item.mediaHash,
          publishedAt: item.publishedAt,
          classification,
          parserVersion: context.parserVersion,
          processingRunId: runId,
        };

        if (context.dryRun) {
          sourceIds.set(sourceKey, source);
          const itemKey = `${sourceKey}\u0000${item.externalId}`;
          const incomingHash = item.contentHash ?? null;
          const priorDryRunHash = dryRunItems.get(itemKey);
          const preview = priorDryRunHash !== undefined
            ? (priorDryRunHash === incomingHash ? 'unchanged' : 'updated')
            : repo.previewSourceItem(source.id, item.externalId, incomingHash, item.mediaHash);
          dryRunItems.set(itemKey, incomingHash);
          if (preview === 'new') result.newSourceItems++;
          else if (preview === 'updated') result.updatedSourceItems++;
          else result.unchangedSourceItems++;
          if (preview !== 'unchanged' && !adapter.processNewOrChanged) for (const aiResult of item.aiResults ?? []) {
            const label = `${aiResult.provider ?? 'unknown'}/${aiResult.model ?? 'unknown'}`;
            result.providerCounts[label] = (result.providerCounts[label] ?? 0) + 1;
          }
          result.newVersions += Number(preview !== 'unchanged');
          result.items.push({ externalId: item.externalId, sourceKey, status: preview });
          if (source.inserted) newSourceKeys.add(sourceKey);
          continue;
        }

        const outcome = repo.transaction(() => {
          const resolvedSource = repo.upsertSourceDetailed(item.sourceIdentity);
          sourceIds.set(sourceKey, resolvedSource);
          const upsert = repo.upsertSourceItemDetailed(resolvedSource.id, sourceItemInput, observedAt);
          repo.replaceIdentifiers(upsert.id, identifiers);
          repo.recordNaturalRediscovery(upsert.id, observedAt);
          if (sourceContentChanged && item.rawText) repo.recordExplicitAvailabilityEdit(upsert.id, item.rawText, observedAt);
          if (upsert.newVersion || didProcessChangedItem) for (const aiResult of item.aiResults ?? []) {
            const label = `${aiResult.provider ?? 'unknown'}/${aiResult.model ?? 'unknown'}`;
            result.providerCounts[label] = (result.providerCounts[label] ?? 0) + 1;
            if (runId !== undefined) repo.recordAiResult(runId, { sourceItemId: upsert.id, ...aiResult });
          }
          return { upsert, source: resolvedSource };
        });
        sourceIds.set(sourceKey, outcome.source);
        const eligibleForRepost = classification === 'HOUSING_SUPPLY' || classification === 'HOUSING_DEMAND';
        const hadRepostAssignment = repo.hasRepostAssignment(outcome.upsert.id);
        if (this.repostClusteringService && ((sourceContentChanged && (eligibleForRepost || hadRepostAssignment))
          || (eligibleForRepost && !hadRepostAssignment))) {
          const repost = this.repostClusteringService.runIncremental('repost-v1', [outcome.upsert.id]);
          result.incrementalRepostItems++;
          result.incrementalRepostClustersCreated += repost.clustersCreated;
          result.incrementalRepostClustersUpdated += repost.clustersUpdated;
        }
        const hasCurrentBinding = repo.hasCurrentCanonicalBinding(outcome.upsert.id,item.contentHash??null,item.mediaHash??null);
        if (this.canonicalShadowService && (sourceContentChanged || sourceMediaChanged || (eligibleForRepost && !hasCurrentBinding))) {
          const canonical = this.canonicalShadowService.reconcileBoundSourceItems([outcome.upsert.id], observedAt);
          result.incrementalCanonicalItems += canonical.processed;
          result.occurrencesAttached += canonical.occurrencesAttached;
          result.canonicalBindingsUpdated += canonical.bindingsUpdated;
          result.repurposedBindingsClosed += canonical.repurposed;
          result.needsGlobalCanonicalMatch += canonical.needsGlobalMatch;
          result.canonicalInconsistencies += canonical.inconsistencies.length;
          if (canonical.needsGlobalMatch > 0 && canonical.inconsistencies.length === 0) globalCanonicalIds.add(outcome.upsert.id);
        }
        if (outcome.source.inserted) newSourceKeys.add(sourceKey);
        const counts = sourceCounts.get(sourceKey) ?? { input: 0, success: 0, failed: 0 };
        counts.input++;
        counts.success++;
        sourceCounts.set(sourceKey, counts);
        result.processedItems++;
        result.newVersions += Number(outcome.upsert.newVersion);
        if (outcome.upsert.inserted) result.newSourceItems++;
        else if (outcome.upsert.updated) result.updatedSourceItems++;
        else result.unchangedSourceItems++;
        result.items.push({ externalId: item.externalId, sourceKey,
          status: outcome.upsert.inserted ? 'new' : outcome.upsert.updated ? 'updated' : 'unchanged' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ externalId, message });
        if (sourceKey) {
          const counts = sourceCounts.get(sourceKey) ?? { input: 0, success: 0, failed: 0 };
          counts.input++;
          counts.failed++;
          sourceCounts.set(sourceKey, counts);
        }
        result.items.push({ externalId: externalId ?? 'unknown', sourceKey, status: 'error' });
      }
    }

    if (this.canonicalShadowService && globalCanonicalIds.size > 0) {
      const canonical = this.canonicalShadowService.run({ dryRun: false });
      result.globalCanonicalRuns++;
      result.globalCanonicalProperties = canonical.canonicalProperties;
      result.globalCanonicalListings = canonical.canonicalListings;
    }
    result.newSources = newSourceKeys.size;
    if (runId !== undefined) {
      for (const [sourceKey, source] of sourceIds) {
        const counts = sourceCounts.get(sourceKey) ?? { input: 0, success: 0, failed: 0 };
        repo.addRunSourceCounts(runId, source.id, context.ingestionMethod, counts);
      }
      repo.finishRun(runId, { input: result.inputItems, processed: result.processedItems,
        success: result.processedItems, failed: result.errors.length });
      const liveProvider = context.runType === 'DISCOVERY'
        ? context.ingestionMethod === 'BRIGHTDATA' ? 'BRIGHTDATA'
          : context.ingestionMethod === 'KHMER24_SCRAPER' ? 'KHMER24' : null
        : null;
      if (liveProvider) repo.recordProviderUsage({ provider: liveProvider, operation: 'DISCOVERY',
        requestedItems: result.inputItems, returnedItems: result.processedItems, failedItems: result.errors.length,
        records: result.inputItems, processingRunId: runId });
    }
    return result;
  }

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

    // LLM-confirmed non-real-estate can be rejected before normalization.
    if (parseResult.data.is_real_estate === false) {
      return {
        status: 'error',
        error: 'LLM classified as non-real-estate',
      };
    }

    const clean = normalizeRawToClean(parseResult.data);
    if (!clean) {
      return {
        status: 'error',
        error: 'Could not extract required fields (title, location) from payload',
      };
    }
    if (clean.city !== 'siem_reap' || clean.type !== 'rent') {
      return {
        status: 'error',
        error: 'MVP accepts only monthly rentals in Siem Reap',
      };
    }

    // ── Step 1: Compute Perceptual Hashes for up to 3 Photos ───────────────────
    const imagePhashes = await computeListingPhashes(clean.photos, 3);
    clean.image_phashes = imagePhashes;
    clean.image_phash = imagePhashes[0] ?? null;

    // ── Step 1.5: Source URL match — same ad re-scraped after an edit (price
    // drop, text change) produces a different content hash, so without this
    // early check a verified re-fetch could insert a duplicate. ────────────────
    const existingBySource = clean.source_url
      ? this.propertiesRepo.findBySourceUrl(clean.source_url)
      : undefined;
    if (existingBySource) {
      this.propertiesRepo.bumpAndMerge(existingBySource.id, {
        price: clean.price,
        phone: clean.direct_contact?.phone,
        location: clean.location,
        maps_url: clean.maps_url ?? undefined,
        posted_at: clean.posted_at,
        source_url: clean.source_url ?? undefined,
        landmarks: clean.landmarks,
        marketing_landmarks: clean.marketing_landmarks,
        description: clean.description,
        raw_text: clean.raw_text ?? undefined,
        listing_facts_json: clean.listing_facts_json,
        parse_warnings: clean.parse_warnings,
      });
      console.log(`  ✨ [Smart Merge] Re-scraped source matched listing #${existingBySource.id} — merged updates`);
      return {
        status: 'duplicate',
        duplicateOfId: existingBySource.id,
        image_phash: clean.image_phash,
        image_phashes: clean.image_phashes,
        reason: `Source URL match with listing #${existingBySource.id}`,
      };
    }

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
          landmarks: clean.landmarks,
          marketing_landmarks: clean.marketing_landmarks,
          description: clean.description,
          raw_text: clean.raw_text ?? undefined,
          listing_facts_json: clean.listing_facts_json,
          parse_warnings: clean.parse_warnings,
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
      bedrooms: clean.bedrooms,
      category: clean.category,
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
        landmarks: clean.landmarks,
        marketing_landmarks: clean.marketing_landmarks,
        description: clean.description,
        raw_text: clean.raw_text ?? undefined,
        listing_facts_json: clean.listing_facts_json,
        parse_warnings: clean.parse_warnings,
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

    const hasNoPhotos = clean.photos.length === 0;
    const needsReview = clean.review_status === 'pending';
    const isActive = hasNoPhotos || needsReview ? 0 : 1;

    const property = this.propertiesRepo.insertProperty({
      ...clean,
      is_active: isActive,
      hash,
      image_phash: clean.image_phash,
      image_phashes: clean.image_phashes,
    });

    if (needsReview) {
      console.warn(`⚠️ [Ingestor] Listing #${property.id} requires manual review: ${clean.review_reason ?? 'uncertain admission'}`);
      if (this.alertService) {
        await this.alertService.reviewProperty(
          property.id,
          `<b>Pending listing review #${property.id}</b>\n` +
            `<b>${escapeHtml(clean.title)}</b>\n` +
            `Reason: ${escapeHtml(clean.review_reason ?? 'uncertain admission')}\n` +
            `<a href="${escapeHtml(clean.original_url)}">Original post</a>`,
        );
      }
    }

    if (hasNoPhotos) {
      console.warn(
        `⚠️ [Ingestor] Listing #${property.id} ("${clean.title}") has 0 photos. Quarantined with is_active = 0.`,
      );
      if (this.alertService) {
        await this.alertService.warn(
          `<b>Needs Review (no photos):</b>\n${clean.title}\n<a href="${clean.original_url}">Original post</a>`,
        );
      }
    } else if (!needsReview) {
      // ── Step 4: Trigger Matching Engine ─────────────────────────────────────────
      this.matcherService.matchAndNotify(property).catch((err: unknown) => {
        console.error('matchAndNotify error:', err);
      });
    }

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
