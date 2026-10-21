import type { DatabaseSync } from 'node:sqlite';
import { assessSiemReapGeography } from './source-geography';
import { sourceRoomCounts } from './source-room-counts';
import { sourceAskingPrices, sourceMonthlyPrices } from './source-price';

export const MODERATION_POLICY_VERSION = 'source-corroborated-crossposts-v12';

export type ModerationCandidate = {
  id: number; status: string; availability_status: string; title: string; description: string;
  price: number | null; bedrooms: number | null; bathrooms: number | null; city: string | null; category: string | null;
  property_type: string | null; review_reason: string | null; source_type: string | null;
  source_url: string | null; raw_text: string | null; raw_payload_json: string | null;
  current_count: number; conflicting_url: number; legacy_aliases: number;
  decision_origin?: string | null;
  group_name?: string | null;
  /** Set only by crosspost analysis when another identical occurrence proves rent context. */
  contextual_rent_price_confirmed?: boolean;
  original_published_at: string | null; first_source_seen_at: string | null;
  matching_active_listings: number;
  primary_source_occurrence_id?: number | null;
};

export type ModerationDecision = { approved: boolean; reasons: string[] };

export type CurrentModerationSource = {
  occurrence_id: number; source_item_id: number; source_type: string;
  source_url: string | null; group_name?: string | null; raw_text: string | null; raw_payload_json: string | null;
};

/** Look for a sale offer about the advertised property, not an unrelated
 * shop/agency landmark such as Khmer "ហាងលក់សម្ភារៈកូនក្មេង".
 * Check the entire original: mixed rent/sale prices often follow a long intro.
 */
function advertisesPropertySale(raw: string): boolean {
  return /\b(?:for\s+sale|sale\s+only|selling\s+price|sale\s+price)\b|(?:សម្រាប់លក់|លក់ផ្ទះ|ផ្ទះ\s*លក់|វីឡា\s*លក់|ដីលក់|តម្លៃលក់|តំលៃលក់)/i.test(raw)
    || /(?:\$\s*\d[\d,]*|\bUSD\s*\d[\d,]*)\s*\(\s*sale\s*\)/i.test(raw)
    || /\b(?:sale|selling)\s*[:=-]\s*(?:\$\s*|USD\s*)\d/i.test(raw);
}

/** A persisted explicit model rejection must never be overturned by factual heuristics. */
function sourceExplicitlyRejected(rawPayloadJson: string | null): boolean {
  let payload: unknown;
  try { payload = JSON.parse(rawPayloadJson ?? '{}'); } catch { return false; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const root = payload as Record<string, unknown>;
  const listing = root.listing && typeof root.listing === 'object' && !Array.isArray(root.listing)
    ? root.listing as Record<string, unknown> : {};
  const facts = root.listingExtraction && typeof root.listingExtraction === 'object' && !Array.isArray(root.listingExtraction)
    ? root.listingExtraction as Record<string, unknown>
    : root.listingFacts && typeof root.listingFacts === 'object' && !Array.isArray(root.listingFacts)
      ? root.listingFacts as Record<string, unknown> : {};
  if (listing.is_real_estate === false || listing.is_supported_listing === false
    || facts.is_real_estate === false || facts.is_supported_listing === false
    || root.is_real_estate === false || root.is_supported_listing === false) return true;
  if (typeof listing.listing_facts_json === 'string') {
    try {
      const storedFacts: unknown = JSON.parse(listing.listing_facts_json);
      if (storedFacts && typeof storedFacts === 'object' && !Array.isArray(storedFacts)
        && ((storedFacts as Record<string, unknown>).is_real_estate === false
          || (storedFacts as Record<string, unknown>).is_supported_listing === false)) return true;
    } catch { /* Ignore malformed optional facts; other source checks still apply. */ }
  }
  return false;
}

function hasRentGroupContext(groupName: string | null | undefined): boolean {
  return /\b(?:rent|rental|lease)\b|ជួល/i.test(groupName ?? '');
}

function hasExplicitRentOffer(text: string): boolean {
  return /\b(?:for\s+rent|rent(?:al)?\s+(?:available|offer|property)|available\s+for\s+rent)\b|ជួល/i.test(text);
}

function sourceTitleFromPayload(rawPayloadJson: string | null): string {
  try {
    const payload = JSON.parse(rawPayloadJson ?? '{}') as { listing?: { source_title?: unknown } };
    return typeof payload.listing?.source_title === 'string' ? payload.listing.source_title : '';
  } catch { return ''; }
}

export function evaluateModerationCandidate(row: ModerationCandidate): ModerationDecision {
  const reasons: string[] = [];
  const raw = row.raw_text ?? '';
  const hold = (reason: string) => reasons.push(reason);
  const generatedDefaultHold = row.decision_origin === 'DEFAULT_PENDING'
    && row.review_reason === 'Canonical-only listing requires explicit moderation';
  if (row.review_reason && !generatedDefaultHold) hold('PRIOR_MANUAL_REVIEW_REASON');
  if (row.status !== 'active' || row.availability_status === 'rented' || row.availability_status === 'unavailable') hold('NOT_AVAILABLE');
  if (row.current_count !== 1) hold('AMBIGUOUS_SOURCE_BINDINGS');
  if (row.conflicting_url) hold('SOURCE_URL_CONFLICT');
  if (row.legacy_aliases) hold('LEGACY_ALIAS_REQUIRES_EXISTING_REVIEW');
  if (row.matching_active_listings) hold('POSSIBLE_DUPLICATE_LISTING');
  if (!row.source_url || !/^https:\/\//i.test(row.source_url)) hold('UNVERIFIED_SOURCE_URL');
  if (!row.title.trim() || !(row.category || row.property_type)) hold('MISSING_LISTING_FACTS');
  if (row.city !== 'siem_reap') hold('OUTSIDE_TARGET_CITY');
  if (!raw.trim()) hold('NO_ORIGINAL_SOURCE_TEXT');
  if (!['KHMER24', 'FACEBOOK_GROUP'].includes(row.source_type ?? '')) hold('UNSUPPORTED_SOURCE');

  // A source re-crawl is not a new publication. Use the earliest known
  // publication across *all* occurrences, including retired ones. When a
  // publication date is missing, require a recent first encounter instead.
  const published = row.original_published_at ? Date.parse(row.original_published_at) : NaN;
  const firstSeen = row.first_source_seen_at ? Date.parse(row.first_source_seen_at) : NaN;
  const referenceDate = Number.isFinite(published) ? published : firstSeen;
  if (!Number.isFinite(referenceDate)) hold('SOURCE_FRESHNESS_UNVERIFIED');
  else if (referenceDate > Date.now() + 24 * 60 * 60 * 1000) hold('SOURCE_DATE_IN_FUTURE');
  else if (referenceDate < Date.now() - 30 * 24 * 60 * 60 * 1000) hold('ORIGINAL_PUBLICATION_TOO_OLD');

  // The raw source must specifically advertise rent. Source-derived structured
  // fields are corroboration, never grounds to infer an offer from landmarks.
  // Only use the verbatim source heading if retained by the scraper. The
  // canonical title can be AI-generated, so it is not independent evidence.
  let sourceTitle = '';
  try {
    const data = JSON.parse(row.raw_payload_json ?? '{}') as { listing?: { source_title?: unknown } };
    if (typeof data.listing?.source_title === 'string') sourceTitle = data.listing.source_title;
  } catch { /* Malformed payload is separately reported below. */ }
  const geo = assessSiemReapGeography({ rawText: `${sourceTitle}\n${raw}`, title: row.title, description: row.description, city: row.city });
  if (geo.tier !== 'EXACT_CITY') hold(geo.flags.length ? geo.flags.join(',') : 'SOURCE_CITY_NOT_EXPLICIT');
  const headline = `${sourceTitle}\n${raw.slice(0, 650)}`;
  // Some property ads state only "$350/month". A single literal monthly
  // amount matching the canonical price independently proves a rental offer.
  // Multiple amounts and sale language still require human review below.
  const originalMonthlyPrices = sourceMonthlyPrices(raw);
  const unambiguousMonthlyRent = originalMonthlyPrices.length === 1
    && originalMonthlyPrices[0] === (row.price === null ? null : row.price / 100);
  if (!/(?:\brent(?:al)?\b|\blease\b|\bfor\s+rent\b|ជួល)/i.test(headline)
    && !unambiguousMonthlyRent) hold('SOURCE_RENT_NOT_EXPLICIT');
  if (advertisesPropertySale(`${sourceTitle}\n${raw}`)) hold('MIXED_OR_SALE_OFFER');
  if (/(?:already\s+rented|no\s+longer\s+available|rented\s+out)/i.test(raw)) hold('SOURCE_NO_LONGER_AVAILABLE');

  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.raw_payload_json ?? '{}') as Record<string, unknown>; } catch { hold('UNPARSEABLE_SOURCE_PAYLOAD'); }
  if (sourceExplicitlyRejected(row.raw_payload_json)) hold('AI_CLASSIFIED_UNSUPPORTED');
  const listing = (payload.listing ?? payload.listingFacts ?? payload.listingExtraction ?? {}) as Record<string, unknown>;
  const declaredPrice = listing.price == null ? NaN : Number(listing.price);
  const expectedPrice = row.price === null ? null : row.price / 100;
  const rawPrices = originalMonthlyPrices;
  const trustedKhmer24Price = row.source_type === 'KHMER24'
    && listing.source_price_origin === 'khmer24_json_ld_offer'
    && listing.source_price_currency === 'USD'
    && typeof listing.source_price === 'number'
    && Number.isFinite(listing.source_price) && listing.source_price > 0;
  const conflictingStructuredSourcePrice = trustedKhmer24Price
    && expectedPrice !== null && listing.source_price !== expectedPrice;
  if (conflictingStructuredSourcePrice) hold('CONTRADICTORY_STRUCTURED_SOURCE_PRICE');
  const exactTextPrice = expectedPrice !== null && rawPrices.length === 1 && rawPrices[0] === expectedPrice
    && !conflictingStructuredSourcePrice;
  if (!expectedPrice || (!Number.isFinite(declaredPrice) || declaredPrice !== expectedPrice) && !exactTextPrice) {
    hold('STRUCTURED_PRICE_MISMATCH');
  }
  // listing.price may be a stale AI extraction. A single literal monthly price
  // in the verbatim post independently corroborates the canonical value and
  // can supersede that stale field. Multiple price tiers remain ambiguous.
  // When the text has no monthly price, only pre-AI Khmer24 JSON-LD provenance
  // can establish the structured rent; a DOM header guess is diagnostic only.
  const khmer24StructuredRent = row.source_type === 'KHMER24'
    && String(listing.type ?? '').toLowerCase() === 'rent'
    && /(?:\bfor\s+rent\b|\brental\b|ជួល)/i.test(sourceTitle)
    && listing.source_price_origin === 'khmer24_json_ld_offer'
    && listing.source_price_currency === 'USD'
    && typeof listing.source_price === 'number'
    && Number.isFinite(listing.source_price) && listing.source_price > 0
    && listing.source_price === expectedPrice
    && declaredPrice === expectedPrice;
  const askingPrices = sourceAskingPrices(raw);
  const contextualRentPrice = row.source_type === 'FACEBOOK_GROUP'
    && (row.contextual_rent_price_confirmed || hasRentGroupContext(row.group_name))
    && hasExplicitRentOffer(headline)
    && !advertisesPropertySale(`${sourceTitle}\n${raw}`)
    && rawPrices.length === 0
    && askingPrices.length === 1
    && askingPrices[0] === expectedPrice;
  if ((!rawPrices.length && !khmer24StructuredRent && !contextualRentPrice)
    || (rawPrices.length > 0 && !rawPrices.includes(expectedPrice ?? -1))) hold('MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE');
  if (rawPrices.some(price => price !== expectedPrice)) hold('CONTRADICTORY_MONTHLY_PRICES');
  if (listing.city && !/siem[ _-]?reap|សៀមរាប/i.test(String(listing.city))) hold('STRUCTURED_CITY_CONFLICT');
  if (listing.type && /sale/i.test(String(listing.type))) hold('STRUCTURED_SALE_OFFER');

  const sourceRooms = sourceRoomCounts(`${sourceTitle}\n${raw}`);
  const canonicalRooms = sourceRoomCounts(`${row.title}\n${row.description}`);
  // Missing optional facts are an extraction-quality issue; conflicting
  // asserted facts remain a real moderation concern.
  if (sourceRooms.conflictingBedrooms) hold('CONTRADICTORY_SOURCE_BEDROOM_COUNTS');
  if (sourceRooms.conflictingBathrooms) hold('CONTRADICTORY_SOURCE_BATHROOM_COUNTS');
  if (row.bedrooms !== null && sourceRooms.bedrooms !== null && sourceRooms.bedrooms !== row.bedrooms) hold('BEDROOMS_CONTRADICT_SOURCE');
  if (row.bathrooms !== null && sourceRooms.bathrooms !== null && sourceRooms.bathrooms !== row.bathrooms) hold('BATHROOMS_CONTRADICT_SOURCE');
  if (!sourceRooms.conflictingBedrooms && sourceRooms.bedrooms === null
    && (row.bedrooms !== null || canonicalRooms.bedrooms !== null)) hold('UNSUPPORTED_CANONICAL_BEDROOM_COUNT');
  if (!sourceRooms.conflictingBathrooms && sourceRooms.bathrooms === null
    && (row.bathrooms !== null || canonicalRooms.bathrooms !== null)) hold('UNSUPPORTED_CANONICAL_BATHROOM_COUNT');
  if (sourceRooms.bedrooms !== null && canonicalRooms.bedrooms !== null
    && canonicalRooms.bedrooms !== sourceRooms.bedrooms) hold('CANONICAL_BEDROOM_TEXT_CONTRADICTS_SOURCE');
  if (sourceRooms.bathrooms !== null && canonicalRooms.bathrooms !== null
    && canonicalRooms.bathrooms !== sourceRooms.bathrooms) hold('CANONICAL_BATHROOM_TEXT_CONTRADICTS_SOURCE');
  return { approved: reasons.length === 0, reasons };
}

/** Facebook groups commonly repost the same offer. Only waive the one-source
 * rule when every *current* original independently corroborates the canonical
 * facts and the posts demonstrably refer to the same offer. */
export function evaluateCorroboratedCrossposts(
  row: ModerationCandidate, sources: readonly CurrentModerationSource[],
): ModerationDecision {
  const hold: ModerationDecision = { approved: false, reasons: ['AMBIGUOUS_SOURCE_BINDINGS'] };
  if (row.current_count < 2 || row.current_count > 12 || sources.length !== row.current_count
    || row.source_type !== 'FACEBOOK_GROUP' || row.primary_source_occurrence_id == null
    || !sources.some(source => source.occurrence_id === row.primary_source_occurrence_id)) return hold;

  const ids = new Set<number>();
  const urls = new Set<string>();
  const tokens = (raw: string): string[] => raw.normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  const numericFacts = (raw: string): string => [...new Set(
    [...raw.matchAll(/\d+(?:[.,]\d+)*/g)].map(match => match[0]!)
      .filter(value => value.replace(/\D/g, '').length <= 6),
  )].sort().join('|');
  const dice = (a: string[], b: string[]): number => {
    const counts = new Map<string, number>();
    for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
    let intersection = 0;
    for (const word of b) {
      const count = counts.get(word) ?? 0;
      if (count > 0) { intersection++; counts.set(word, count - 1); }
    }
    return (2 * intersection) / (a.length + b.length);
  };
  const first = sources[0]!;
  const firstRaw = first.raw_text?.trim() ?? '';
  const firstTokens = tokens(firstRaw);
  const firstNumbers = numericFacts(firstRaw);
  let firstAuthor = '';
  try {
    const payload = JSON.parse(first.raw_payload_json ?? '{}') as {userUrl?: unknown};
    if (typeof payload.userUrl === 'string') firstAuthor = payload.userUrl.trim();
  } catch { return hold; }
  if (firstRaw.length < 120 || firstTokens.length < 35) return hold;

  const expectedPrice = row.price === null ? null : row.price / 100;
  const contextualRentPriceConfirmed = expectedPrice !== null && sources.some(source => {
    if (!hasRentGroupContext(source.group_name) || source.source_type !== 'FACEBOOK_GROUP') return false;
    const raw = source.raw_text ?? '';
    const title = sourceTitleFromPayload(source.raw_payload_json);
    const headline = `${title}\n${raw.slice(0, 650)}`;
    const askingPrices = sourceAskingPrices(raw);
    return hasExplicitRentOffer(headline)
      && !advertisesPropertySale(`${title}\n${raw}`)
      && sourceMonthlyPrices(raw).length === 0
      && askingPrices.length === 1
      && askingPrices[0] === expectedPrice;
  });

  const reasons = new Set<string>();
  for (const source of sources) {
    const raw = source.raw_text?.trim() ?? '';
    const words = tokens(raw);
    if (source.source_type !== 'FACEBOOK_GROUP' || !source.source_url?.startsWith('https://')
      || ids.has(source.source_item_id) || urls.has(source.source_url)
      || raw.length < 120 || words.length < 35) return hold;
    ids.add(source.source_item_id);
    urls.add(source.source_url);

    let author = '';
    try {
      const payload = JSON.parse(source.raw_payload_json ?? '{}') as {userUrl?: unknown};
      if (typeof payload.userUrl === 'string') author = payload.userUrl.trim();
    } catch { return hold; }
    const exact = words.join(' ') === firstTokens.join(' ');
    // A short post can still be strongly corroborated when the same author
    // crossposts the exact full text; keep the word-count and per-source fact
    // checks, and require 160 chars for any different text or author.
    if (raw.length < 160 && (!exact || !firstAuthor || author !== firstAuthor)) return hold;
    // Minor formatting or repeated-word changes are acceptable only from the
    // same identifiable author, and never when numerical property facts differ.
    if (!exact && (!firstAuthor || author !== firstAuthor
      || numericFacts(raw) !== firstNumbers || dice(firstTokens, words) < 0.97)) return hold;

    const decision = evaluateModerationCandidate({ ...row,
      source_type: source.source_type, source_url: source.source_url,
      group_name: source.group_name, raw_text: source.raw_text, raw_payload_json: source.raw_payload_json,
      contextual_rent_price_confirmed: contextualRentPriceConfirmed,
      current_count: 1,
    });
    for (const reason of decision.reasons) reasons.add(reason);
  }
  return { approved: reasons.size === 0, reasons: [...reasons] };
}

/** Runs inside the caller's canonical SAVEPOINT, after source occurrences exist.
 * Rechecks current defaults and legacy system-generated holds; explicit legacy
 * alias conflicts and human-written review reasons stay outside auto-approval.
 */
export function reviewDefaultPending(db: DatabaseSync, onlyListingIds?: readonly number[]): { approved: number; held: number } {
  if (onlyListingIds?.length === 0) return { approved: 0, held: 0 };
  const scope = onlyListingIds?.length ? ` AND l.id IN (${onlyListingIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT l.id,l.status,l.availability_status,l.title,l.description,l.price,l.bedrooms,l.bathrooms,
    l.city,l.category,l.property_type,
    CASE WHEN m.decision_origin='INGESTION_VALIDATED_V1'
      AND m.review_reason LIKE 'INGESTION_VALIDATED_V1: held for manual review (%'
      THEN NULL ELSE m.review_reason END review_reason,
    m.decision_origin,s.source_type,o.group_name,
    l.primary_source_occurrence_id,
    COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,
    s.raw_text,s.raw_payload_json,
    (SELECT COALESCE(h.posted_at,t.published_at) FROM canonical_listing_source_occurrences h
      JOIN source_items t ON t.id=h.source_item_id WHERE h.listing_id=l.id
      AND COALESCE(julianday(h.posted_at),julianday(t.published_at)) IS NOT NULL
      ORDER BY COALESCE(julianday(h.posted_at),julianday(t.published_at)),h.id LIMIT 1) original_published_at,
    (SELECT h.first_seen_at FROM canonical_listing_source_occurrences h WHERE h.listing_id=l.id
      ORDER BY julianday(h.first_seen_at),h.id LIMIT 1) first_source_seen_at,
    (SELECT COUNT(*) FROM canonical_listings other WHERE other.id<>l.id AND other.status='active'
      AND lower(trim(other.title))=lower(trim(l.title)) AND other.price=l.price
      AND COALESCE(other.city,'')=COALESCE(l.city,'')
      AND COALESCE(other.bedrooms,-1)=COALESCE(l.bedrooms,-1)) matching_active_listings,
    (SELECT COUNT(*) FROM canonical_listing_source_occurrences x WHERE x.listing_id=l.id AND x.is_current=1) current_count,
    EXISTS(SELECT 1 FROM canonical_listing_source_occurrences x JOIN canonical_listing_source_occurrences y
      ON y.source_url=x.source_url AND y.listing_id<>x.listing_id AND y.is_current=1
      WHERE x.listing_id=l.id AND x.is_current=1 AND x.source_url IS NOT NULL) conflicting_url,
    (SELECT COUNT(*) FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') legacy_aliases
    FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
    LEFT JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
    LEFT JOIN source_items s ON s.id=o.source_item_id
    WHERE m.review_status='pending' AND (m.decision_origin='DEFAULT_PENDING'
      OR (m.decision_origin='INGESTION_VALIDATED_V1'
        AND m.review_reason LIKE 'INGESTION_VALIDATED_V1: held for manual review (%'))${scope}`)
    .all(...(onlyListingIds ?? [])) as unknown as ModerationCandidate[];
  const currentSources = db.prepare(`SELECT o.id occurrence_id,o.source_item_id,s.source_type,o.group_name,
    COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,s.raw_text,s.raw_payload_json
    FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
    WHERE o.listing_id=? AND o.is_current=1 ORDER BY o.id`);
  const update = db.prepare(`UPDATE canonical_listing_moderation SET review_status='approved',review_reason=NULL,
    decision_origin='INGESTION_VALIDATED_V1',policy_version=?,decision_evidence_json=?,
    previous_review_status='pending',decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
    decision_actor='AUTO_POLICY',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE listing_id=? AND review_status='pending' AND (
      (decision_origin='DEFAULT_PENDING' AND (review_reason IS NULL
        OR review_reason='Canonical-only listing requires explicit moderation'))
      OR (decision_origin='INGESTION_VALIDATED_V1'
        AND review_reason LIKE 'INGESTION_VALIDATED_V1: held for manual review (%'))`);
  let approved = 0;
  for (const row of rows) {
    const sources = row.current_count > 1
      ? currentSources.all(row.id) as CurrentModerationSource[] : [];
    const decision = row.current_count > 1
      ? evaluateCorroboratedCrossposts(row, sources)
      : evaluateModerationCandidate(row);
    if (!decision.approved) continue;
    approved += Number(update.run(MODERATION_POLICY_VERSION, JSON.stringify({sourceType:row.source_type,sourceUrl:row.source_url,
      priceCents:row.price,sourceCity:'EXACT_CITY',verifiedSourceItemIds:sources.map(source => source.source_item_id),
      checks:['monthly_price','rent_offer','source_geography','source_binding','source_rooms_consistency']}), row.id).changes);
  }
  return { approved, held: rows.length - approved };
}
