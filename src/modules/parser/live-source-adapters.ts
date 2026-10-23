import crypto from 'node:crypto';
import type { SourceAdapter, SourceRunContext, NormalizedSourceItem } from './ingestion-contracts';
import type { SourceType } from '../../database/repositories/source-ingestion.repo';
import type { RawListing } from './schemas';
import { validRoomCount } from './source-listing-facts';
import { sourceRoomCounts } from './source-room-counts';
import { stableMediaHash } from './media-identity';
import { extractCoordinatesFromMapsUrl, extractPropertyPinCoordinatesFromMapsUrl, isCoordinateInSanityBounds } from '../../config/locations';
import { isKnownKhmer24AdministrativePin } from './source-geography';
import { extractPropertyMapUrlFromText, isGoogleMapsDestinationUrl } from './source-map-location';

function trustworthySourceMap(url: string | undefined, sourceType: SourceType): string | undefined {
  if (!url || sourceType !== 'KHMER24') return url;
  const point = extractCoordinatesFromMapsUrl(url);
  return point && isKnownKhmer24AdministrativePin(point.latitude, point.longitude) ? undefined : url;
}

export interface LiveListingEnvelope {
  listing: RawListing;
  sourceName: string;
  sourceId: string;
  sourceUrl?: string;
  groupId?: string;
  groupName?: string;
  classification?: 'HOUSING_SUPPLY' | 'HOUSING_DEMAND' | 'HOUSING_ADJACENT' | 'IRRELEVANT' | 'UNCLASSIFIED';
}

export type LiveListingFetcher = (context: SourceRunContext) => AsyncIterable<LiveListingEnvelope>;
export type LiveListingProcessor = NonNullable<SourceAdapter<LiveListingEnvelope>['processNewOrChanged']>;

/** Use the same group key as BrightData's ReplayAdapter (groupUrl /groups/:id). */
export function facebookGroupEnvelope(
  listing: RawListing,
  target: { name: string; url: string },
): LiveListingEnvelope {
  const groupId = new URL(target.url).pathname.match(/\/groups\/([^/?#]+)/i)?.[1];
  if (!groupId) throw new Error(`Facebook target is missing a stable group ID: ${target.url}`);
  return {
    listing,
    sourceId: decodeURIComponent(groupId),
    sourceName: target.name,
    sourceUrl: target.url,
    groupId: decodeURIComponent(groupId),
    groupName: target.name,
  };
}

function stableExternalId(sourceType: SourceType, listing: RawListing): string {
  const url = listing.source_url ?? listing.url ?? '';
  const pattern = sourceType === 'KHMER24' ? /(?:adid-|adid\/)(\d+)/i : /(?:posts|permalink)\/(\d+)(?:[/?#]|$)/i;
  const match = url.match(pattern);
  if (sourceType === 'KHMER24') {
    if (match?.[1]) return match[1];
    throw new Error(`Khmer24 listing URL has no stable ad ID: ${url}`);
  }
  const structuredId = listing.facebook_post_id;
  if (structuredId !== undefined && !/^\d+$/.test(structuredId.trim())) {
    throw new Error(`Facebook structured post ID is invalid: ${structuredId}`);
  }
  if (structuredId && match?.[1] && structuredId.trim() !== match[1]) {
    throw new Error(`Facebook post ID conflicts with permalink: ${structuredId} != ${match[1]}`);
  }
  if (structuredId) return structuredId.trim();
  if (match?.[1]) return match[1];
  if (url) return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  throw new Error('Facebook listing is missing a stable post URL');
}

function listingFacts(listing: RawListing, sourceType: SourceType): Record<string, unknown> {
  let canonicalFacts: unknown;
  try { canonicalFacts = listing.listing_facts_json ? JSON.parse(listing.listing_facts_json) : null; } catch { canonicalFacts = null; }
  const facts = canonicalFacts && typeof canonicalFacts === 'object' && !Array.isArray(canonicalFacts)
    ? { ...canonicalFacts as Record<string, unknown> } : {};
  const hasCanonicalFacts = canonicalFacts !== null && typeof canonicalFacts === 'object' && !Array.isArray(canonicalFacts);
  // Both Khmer24 and Facebook may include literal room counts that contradict
  // AI extraction (e.g. "02 – Bedroom" incorrectly returned as one bedroom).
  // Only the retained original is independent evidence; generated summaries
  // are never used to override it.
  const sourceRooms = sourceRoomCounts([listing.source_title, listing.raw_text].filter(Boolean).join('\n'));
  if (sourceType === 'KHMER24') {
    // AI facts may describe a nearby attraction or the seller's address. Only
    // source-confirmed fields from the Khmer24 detail parser may locate the home.
    delete facts.latitude;
    delete facts.longitude;
    delete facts.maps_url;
    const latitude = Number(listing.latitude);
    const longitude = Number(listing.longitude);
    if (listing.latitude != null && listing.longitude != null &&
        Number.isFinite(latitude) && Number.isFinite(longitude) &&
        (listing.city === 'siem_reap' || listing.city === 'phnom_penh') &&
        isCoordinateInSanityBounds(latitude, longitude, listing.city) &&
        !isKnownKhmer24AdministrativePin(latitude, longitude)) {
      facts.latitude = latitude;
      facts.longitude = longitude;
    }
    const mapsUrl = trustworthySourceMap(listing.maps_url, sourceType);
    if (mapsUrl) facts.maps_url = mapsUrl;
  } else {
    // Facebook AI output may contain an invented/nearby maps link. Retain a
    // location URL or exact pin only when the original post labels its link as
    // the property's location and the parser-derived coordinates match it.
    delete facts.latitude;
    delete facts.longitude;
    delete facts.maps_url;
    const sourceText = [listing.source_title, listing.raw_text].filter(Boolean).join('\n');
    const labelledSourceUrl = extractPropertyMapUrlFromText(sourceText);
    const sourceMapMatches = Boolean(labelledSourceUrl && listing.source_map_url === labelledSourceUrl);
    const mapsUrl = sourceMapMatches && listing.maps_url
      && (listing.maps_url === labelledSourceUrl || isGoogleMapsDestinationUrl(listing.maps_url))
      ? listing.maps_url : undefined;
    const mapPoint = mapsUrl ? extractPropertyPinCoordinatesFromMapsUrl(mapsUrl) : null;
    if (mapsUrl) facts.maps_url = mapsUrl;
    const latitude = Number(listing.latitude);
    const longitude = Number(listing.longitude);
    if (mapPoint && listing.latitude != null && listing.longitude != null
      && Number.isFinite(latitude) && Number.isFinite(longitude)
      && Math.abs(latitude - mapPoint.latitude) < 0.000001
      && Math.abs(longitude - mapPoint.longitude) < 0.000001
      && (listing.city === 'siem_reap' || listing.city === 'phnom_penh')
      && isCoordinateInSanityBounds(latitude, longitude, listing.city)) {
      facts.latitude = latitude;
      facts.longitude = longitude;
    }
  }
  return {
    ...facts,
    title_en: listing.title ?? null, description_en: listing.description ?? null,
    price: hasCanonicalFacts ? facts.price ?? null : (typeof listing.price === 'number' ? listing.price : null),
    currency: hasCanonicalFacts ? facts.currency ?? null : listing.currency ?? null,
    category: listing.category ?? null, property_type: listing.property_type ?? null,
    bedrooms: sourceRooms.conflictingBedrooms ? null : sourceRooms.bedrooms ?? (hasCanonicalFacts ? validRoomCount(facts.bedrooms) : validRoomCount(listing.bedrooms)),
    bathrooms: sourceRooms.conflictingBathrooms ? null : sourceRooms.bathrooms ?? (hasCanonicalFacts ? validRoomCount(facts.bathrooms) : validRoomCount(listing.bathrooms)),
    location: listing.location ?? null, city: listing.city ?? null,
  };
}

export class LiveListingAdapter implements SourceAdapter<LiveListingEnvelope> {
  constructor(readonly sourceType: 'FACEBOOK_GROUP' | 'KHMER24',
    private readonly fetcher: LiveListingFetcher, private readonly processor?: LiveListingProcessor) {}

  fetchNewItems(context: SourceRunContext): AsyncIterable<LiveListingEnvelope> { return this.fetcher(context); }

  normalize(envelope: LiveListingEnvelope): NormalizedSourceItem<LiveListingEnvelope> {
    const listing = envelope.listing;
    const externalId = stableExternalId(this.sourceType, listing);
    // Preserve the source exactly, including whitespace and empty posts. The
    // display/enrichment text may be normalized separately downstream.
    const rawText = listing.raw_text ?? [listing.title, listing.description].filter(Boolean).join('\n');
    const photoUrls = [...new Set((listing.photos ?? []).filter((url) => /^https?:\/\//i.test(url)))].sort();
    const sourceUrl = listing.source_url ?? listing.url;
    const contentHash = crypto.createHash('sha256').update(rawText, 'utf8').digest('hex');
    const sourceCity = listing.city === 'phnom_penh' ? 'phnom_penh' : 'siem_reap';
    const extractedFacts = listingFacts(listing, this.sourceType);
    const rawPayload: LiveListingEnvelope & { listingExtraction: Record<string, unknown>; photos: string[]; sourceType: SourceType } = {
      ...envelope, listing: { ...listing, photos: photoUrls }, listingExtraction: extractedFacts,
      photos: photoUrls, sourceType: this.sourceType,
    };
    return {
      sourceIdentity: { sourceType: this.sourceType, externalSourceId: envelope.sourceId,
        name: envelope.sourceName, url: envelope.sourceUrl, city: sourceCity },
      externalId, raw: rawPayload,
      canonicalUrl: sourceUrl, sourceUrl, groupId: envelope.groupId, groupName: envelope.groupName,
      authorName: undefined, rawText, contentHash,
      // Match ReplayAdapter: Facebook CDN signed URLs/hosts change without a media edit.
      mediaHash: stableMediaHash(photoUrls) ?? undefined,
      publishedAt: listing.posted_at, classification: envelope.classification ??
        (this.sourceType === 'FACEBOOK_GROUP'
          ? listing.is_real_estate === true ? 'HOUSING_SUPPLY' : listing.is_real_estate === false ? 'IRRELEVANT' : 'UNCLASSIFIED'
          : 'UNCLASSIFIED'),
      deterministicIdentifiers: [
        ...(listing.phone ? listing.phone.split(/[;,/]/).map((value) => ({ type: 'PHONE' as const, rawValue: value.trim(), normalizedValue: value.trim() })) : []),
        ...(listing.telegram_contact ? [{ type: 'TELEGRAM' as const, rawValue: listing.telegram_contact, normalizedValue: listing.telegram_contact }] : []),
        ...(typeof extractedFacts.maps_url === 'string'
          ? [{ type: 'MAPS_URL' as const, rawValue: extractedFacts.maps_url, normalizedValue: extractedFacts.maps_url }] : []),
      ],
    };
  }

  processNewOrChanged(raw: LiveListingEnvelope, normalized: NormalizedSourceItem<LiveListingEnvelope>, state: Parameters<LiveListingProcessor>[2]) {
    return this.processor ? this.processor(raw, normalized, state) : Promise.resolve(normalized);
  }
}

export class FacebookLiveAdapter extends LiveListingAdapter {
  constructor(fetcher: LiveListingFetcher, processor?: LiveListingProcessor) { super('FACEBOOK_GROUP', fetcher, processor); }
}

export class Khmer24LiveAdapter extends LiveListingAdapter {
  constructor(fetcher: LiveListingFetcher, processor?: LiveListingProcessor) { super('KHMER24', fetcher, processor); }
}
