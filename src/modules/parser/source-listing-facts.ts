import { sourceAssertsSiemReapPropertyCity } from './source-geography';
import { sourceRoomCounts } from './source-room-counts';

type SourceRentalType = { category: 'house' | 'apartment'; property_type: 'Private Villa' | 'Private House' | 'Apartment' };

/** Use an explicit offer for one property, never an agency portfolio or a sale/rent mix. */
function sourceRentalType(raw: string): SourceRentalType | null {
  if (/\b(?:for\s+sale|selling\s+price|sale\s+price|for\s+sell)\b|(?:សម្រាប់លក់|លក់ផ្ទះ)/iu.test(raw)) return null;

  const offered = new Set<'villa' | 'house' | 'apartment'>();
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim().replace(/^[\s\p{P}\p{S}]+/u, '');
    if (/\b(?:agency|office|showroom|exhibition|walking\s+distance|nearby|looking\s+for|we\s+(?:handle|offer|manage))\b/i.test(text)) continue;
    for (const match of text.matchAll(/\b(villa|house|apartment)\s+for\s+(?:rent|lease)\b/gi)) {
      offered.add(match[1]!.toLowerCase() as 'villa' | 'house' | 'apartment');
    }
    if (/ផ្ទះវិឡាសម្រាប់ជួល/u.test(text)) offered.add('villa');
    else if (/អាផាតមិនសម្រាប់ជួល/u.test(text)) offered.add('apartment');
    else if (/ផ្ទះសម្រាប់ជួល/u.test(text)) offered.add('house');
  }
  if (offered.size !== 1) return null;
  if (offered.has('villa')) return { category: 'house', property_type: 'Private Villa' };
  if (offered.has('house')) return { category: 'house', property_type: 'Private House' };
  return { category: 'apartment', property_type: 'Apartment' };
}

/** A missing or malformed room count must not erase a previously observed count. */
export function validRoomCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Live adapters store listingExtraction; historic Khmer24 imports store listingFacts. */
export function sourceListingFacts(payload: Record<string, unknown>, originalRawText?: string | null): Record<string, unknown> {
  const legacy = record(payload.listingFacts);
  const extracted = record(payload.listingExtraction);
  const facts = { ...legacy, ...extracted };
  for (const field of ['bedrooms', 'bathrooms'] as const) {
    const count = validRoomCount(extracted[field]) ?? validRoomCount(legacy[field]);
    if (count === null) delete facts[field];
    else facts[field] = count;
  }
  if ((facts.city === null || facts.city === undefined || facts.city === '')
    && sourceAssertsSiemReapPropertyCity(originalRawText)) facts.city = 'siem_reap';
  const raw = originalRawText ?? '';
  const sourceType = sourceRentalType(raw);
  if (sourceType) {
    for (const field of ['category', 'property_type'] as const) {
      if (facts[field] === null || facts[field] === undefined || facts[field] === '') facts[field] = sourceType[field];
    }
    const counts = sourceRoomCounts(raw);
    for (const field of ['bedrooms', 'bathrooms'] as const) {
      if (validRoomCount(facts[field]) === null && counts[field] !== null
        && !counts[field === 'bedrooms' ? 'conflictingBedrooms' : 'conflictingBathrooms']) facts[field] = counts[field];
    }
  }
  return facts;
}
