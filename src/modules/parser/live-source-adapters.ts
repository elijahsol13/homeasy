import crypto from 'node:crypto';
import type { SourceAdapter, SourceRunContext, NormalizedSourceItem } from './ingestion-contracts';
import type { SourceType } from '../../database/repositories/source-ingestion.repo';
import type { RawListing } from './schemas';

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

function stableExternalId(sourceType: SourceType, listing: RawListing): string {
  const url = listing.source_url ?? listing.url ?? '';
  const pattern = sourceType === 'KHMER24' ? /(?:adid-|adid\/)(\d+)/i : /(?:posts|permalink)\/(\d+)/i;
  const match = url.match(pattern);
  if (match?.[1]) return match[1];
  if (sourceType === 'KHMER24') throw new Error(`Khmer24 listing URL has no stable ad ID: ${url}`);
  if (url) return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  throw new Error('Facebook listing is missing a stable post URL');
}

function listingFacts(listing: RawListing): Record<string, unknown> {
  let canonicalFacts: unknown;
  try { canonicalFacts = listing.listing_facts_json ? JSON.parse(listing.listing_facts_json) : null; } catch { canonicalFacts = null; }
  return {
    ...(canonicalFacts && typeof canonicalFacts === 'object' ? canonicalFacts as Record<string, unknown> : {}),
    title_en: listing.title ?? null, description_en: listing.description ?? null,
    price: typeof listing.price === 'number' ? listing.price : null, currency: listing.currency ?? null,
    category: listing.category ?? null, property_type: listing.property_type ?? null,
    bedrooms: listing.bedrooms ?? null, bathrooms: listing.bathrooms ?? null,
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
    const rawText = listing.raw_text?.trim() || [listing.title, listing.description].filter(Boolean).join('\n');
    const photoUrls = [...new Set((listing.photos ?? []).filter((url) => /^https?:\/\//i.test(url)))].sort();
    const sourceUrl = listing.source_url ?? listing.url;
    const contentHash = crypto.createHash('sha256').update(rawText.normalize('NFC')).digest('hex');
    const sourceCity = listing.city === 'phnom_penh' ? 'phnom_penh' : 'siem_reap';
    const rawPayload: LiveListingEnvelope & { listingExtraction: Record<string, unknown>; photos: string[]; sourceType: SourceType } = {
      ...envelope, listing: { ...listing, photos: photoUrls }, listingExtraction: listingFacts(listing),
      photos: photoUrls, sourceType: this.sourceType,
    };
    return {
      sourceIdentity: { sourceType: this.sourceType, externalSourceId: envelope.sourceId,
        name: envelope.sourceName, url: envelope.sourceUrl, city: sourceCity },
      externalId, raw: rawPayload,
      canonicalUrl: sourceUrl, sourceUrl, groupId: envelope.groupId, groupName: envelope.groupName,
      authorName: undefined, rawText, contentHash,
      mediaHash: photoUrls.length ? crypto.createHash('sha256').update(photoUrls.join('\n')).digest('hex') : undefined,
      publishedAt: listing.posted_at, classification: envelope.classification ?? 'HOUSING_SUPPLY',
      deterministicIdentifiers: [
        ...(listing.phone ? listing.phone.split(/[;,/]/).map((value) => ({ type: 'PHONE' as const, rawValue: value.trim(), normalizedValue: value.trim() })) : []),
        ...(listing.telegram_contact ? [{ type: 'TELEGRAM' as const, rawValue: listing.telegram_contact, normalizedValue: listing.telegram_contact }] : []),
        ...(listing.maps_url ? [{ type: 'MAPS_URL' as const, rawValue: listing.maps_url, normalizedValue: listing.maps_url }] : []),
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
