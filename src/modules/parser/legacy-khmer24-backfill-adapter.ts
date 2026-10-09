import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SourceAdapter, SourceRunContext, NormalizedSourceItem } from './ingestion-contracts';
import type { SourceIdentifierInput, SourceType } from '../../database/repositories/source-ingestion.repo';

export type LegacyPropertyRow = Record<string, unknown> & { id: number; __legacyDuplicateRows?: LegacyPropertyRow[] };

export interface LegacyKhmer24Assessment {
  recognized: boolean;
  externalId?: string;
  reason?: 'non_khmer24_provenance' | 'missing_stable_adid' | 'conflicting_urls';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validKhmer24Url(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /(^|\.)khmer24\.com$/i.test(url.hostname) ? url : null;
  } catch { return null; }
}

export function assessLegacyKhmer24Row(row: LegacyPropertyRow): LegacyKhmer24Assessment {
  const sourceUrl = stringValue(row.source_url);
  const originalUrl = stringValue(row.original_url);
  const source = validKhmer24Url(sourceUrl);
  const original = validKhmer24Url(originalUrl);
  if (!source && !original) return { recognized: false, reason: 'non_khmer24_provenance' };
  if ((sourceUrl && !source) || (originalUrl && !original)) return { recognized: false, reason: 'conflicting_urls' };
  const sourceAd = sourceUrl?.match(/adid-(\d+)/i)?.[1];
  const originalAd = originalUrl?.match(/adid-(\d+)/i)?.[1];
  if (sourceAd && originalAd && sourceAd !== originalAd) return { recognized: false, reason: 'conflicting_urls' };
  const externalId = sourceAd ?? originalAd;
  if (!externalId) return { recognized: false, reason: 'missing_stable_adid' };
  return { recognized: true, externalId: `adid:${externalId}` };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function contactText(value: unknown): string {
  const contact = typeof value === 'string' ? parseJson<Record<string, unknown>>(value, {})
    : value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.entries(contact).flatMap(([key, entry]) => {
    const values = Array.isArray(entry) ? entry : [entry];
    return values.filter((part) => typeof part === 'string' && part.trim())
      .map((part) => `${key}: ${String(part).trim()}`);
  }).join('\n');
}

function legacyRawText(row: LegacyPropertyRow): string {
  const content = stringValue(row.raw_text);
  return [content, row.title, row.description, row.location, row.primary_landmark, contactText(row.direct_contact), row.maps_url]
    .map(stringValue).filter((part): part is string => Boolean(part)).filter((part, index, all) => all.indexOf(part) === index).join('\n');
}

function completeness(row: LegacyPropertyRow): number {
  const rawText = stringValue(row.raw_text) ?? '';
  const photos = parseJson<string[]>(row.photos, []);
  const hashes = parseJson<string[]>(row.image_phashes, []);
  return rawText.length + (stringValue(row.description)?.length ?? 0) + photos.length * 20 + hashes.length * 50
    + (stringValue(row.title) ? 40 : 0) + (stringValue(row.direct_contact) && row.direct_contact !== '{}' ? 80 : 0);
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class LegacyKhmer24BackfillAdapter implements SourceAdapter<LegacyPropertyRow> {
  readonly sourceType: SourceType = 'KHMER24';

  constructor(private readonly db: DatabaseSync) {}

  async *fetchNewItems(_context: SourceRunContext): AsyncIterable<LegacyPropertyRow> {
    const rows = this.db.prepare('SELECT * FROM properties ORDER BY id').all() as unknown as LegacyPropertyRow[];
    const grouped = new Map<string, LegacyPropertyRow[]>();
    for (const row of rows) {
      const assessment = assessLegacyKhmer24Row(row);
      if (!assessment.recognized || !assessment.externalId) continue;
      const group = grouped.get(assessment.externalId) ?? [];
      group.push(row);
      grouped.set(assessment.externalId, group);
    }
    for (const [externalId, duplicates] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ordered = [...duplicates].sort((a, b) => completeness(b) - completeness(a) || a.id - b.id);
      const selected = { ...ordered[0]!, __legacyDuplicateRows: duplicates };
      // The adapter selects one deterministic snapshot per portal ad ID. Extra legacy rows
      // remain in the raw payload below, so their contacts and media are not discarded.
      selected.__legacyDuplicateRows = ordered;
      yield selected;
    }
  }

  normalize(row: LegacyPropertyRow): NormalizedSourceItem<LegacyPropertyRow> {
    const assessment = assessLegacyKhmer24Row(row);
    if (!assessment.recognized || !assessment.externalId) throw new Error(`Legacy property ${row.id} is not a stable Khmer24 item`);
    const sourceUrl = stringValue(row.source_url) ?? stringValue(row.original_url)!;
    const facts = {
      title_en: stringValue(row.title) ?? '',
      description_en: stringValue(row.description) ?? '',
      offer_type: row.type === 'rent' || row.type === 'sale' ? row.type : null,
      // Legacy `properties.price` is stored as USD cents (the Mini App divides by 100).
      // NormalizedSourceItem facts use the extraction contract's dollar amount.
      price: typeof row.price === 'number' && row.price > 0 ? row.price / 100 : null,
      currency: row.currency === 'USD' || row.currency === 'KHR' ? row.currency : null,
      category: ['apartment', 'house', 'room', 'hotel'].includes(String(row.category)) ? row.category : null,
      property_type: stringValue(row.property_type) ?? null,
      bedrooms: typeof row.bedrooms === 'number' ? row.bedrooms : null,
      bathrooms: typeof row.bathrooms === 'number' ? row.bathrooms : null,
      city: stringValue(row.city) ?? null,
      sangkat: stringValue(row.location) ?? null,
      explicit_location: stringValue(row.raw_location) ?? stringValue(row.location) ?? null,
      landmarks: parseJson<string[]>(row.landmarks, []),
      marketing_landmarks: parseJson<string[]>(row.marketing_landmarks, []),
      min_lease_months: typeof row.min_lease === 'number' ? row.min_lease : null,
      lease_term_text: null,
      deposit_amount: typeof row.deposit === 'number' && row.deposit > 0 ? row.deposit : null,
      deposit_months: null,
      has_pool: typeof row.has_pool === 'number' ? row.has_pool === 1 : null,
      electricity_type: null,
      electricity_rate: stringValue(row.electricity) ?? null,
      water_type: null,
      water_rate: stringValue(row.water) ?? null,
      cleaning: stringValue(row.cleaning) ?? null,
      restrictions: parseJson<string[]>(row.restrictions, []),
      pet_friendly: typeof row.pet_friendly === 'number' ? row.pet_friendly === 1 : null,
      discovered_amenities: parseJson<string[]>(row.amenities, []),
    };
    const duplicateRows = row.__legacyDuplicateRows ?? [row];
    const photoAssets = duplicateRows.flatMap((entry) => {
      const urls = parseJson<string[]>(entry.photos, []);
      const hashes = parseJson<string[]>(entry.image_phashes, []);
      const alignedHashes = hashes.length ? hashes : stringValue(entry.image_phash) ? [String(entry.image_phash)] : [];
      return urls.map((url, index) => ({ url, perceptualHash: alignedHashes[index] ?? null }));
    });
    const photos = [...new Set(photoAssets.map((asset) => asset.url))];
    const imagePhashes = [...new Set(photoAssets.flatMap((asset) => asset.perceptualHash ? [asset.perceptualHash] : []))];
    const directContact = parseJson<Record<string, unknown>>(row.direct_contact, {});
    const rawText = [...new Set(duplicateRows.map(legacyRawText).filter(Boolean))].join('\n');
    const raw: LegacyPropertyRow = { ...row, legacyPropertyId: row.id, legacyProperty: row, legacyDuplicateRows: duplicateRows, listingFacts: facts,
      photos, photoAssets, imagePhashes,
      directContact, legacyCreatedAt: row.created_at, legacyUpdatedAt: row.updated_at };
    const deterministicIdentifiers: SourceIdentifierInput[] = [];
    const append = (type: SourceIdentifierInput['type'], value: unknown) => {
      if (typeof value === 'string' && value.trim()) deterministicIdentifiers.push({ type, rawValue: value.trim(), normalizedValue: value.trim() });
    };
    append('PHONE', directContact.phone);
    append('WHATSAPP', directContact.whatsapp);
    append('TELEGRAM', directContact.telegram);
    append('EMAIL', directContact.email);
    append('MAPS_URL', row.maps_url);
    return {
      sourceIdentity: { sourceType: 'KHMER24', externalSourceId: 'legacy-inventory', name: 'Khmer24 legacy inventory',
        url: 'https://www.khmer24.com' },
      externalId: assessment.externalId,
      raw,
      canonicalUrl: sourceUrl,
      sourceUrl,
      authorName: stringValue(directContact.name),
      rawText,
      contentHash: sha256({ id: assessment.externalId, sourceUrl, facts, rawText, photos, imagePhashes, directContact }),
      publishedAt: stringValue(row.posted_at) ?? stringValue(row.created_at),
      classification: 'HOUSING_SUPPLY',
      deterministicIdentifiers,
    };
  }
}
