import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createContainer } from '../src/container';
import { env } from '../src/config/env';
import { runMigrations } from '../src/database/migrate';
import { buildApiServer } from '../src/modules/api/server';
import { Khmer24LiveAdapter, type LiveListingEnvelope } from '../src/modules/parser/live-source-adapters';
import { classifyKhmer24Listing, enrichListingsWithLLM } from '../src/modules/parser/khmer24.scraper';
import type { RawListing } from '../src/modules/parser/schemas';
import type { LLMExtractedListing } from '../src/modules/parser/extractor';

jest.mock('../src/modules/parser/extractor', () => {
  const original = jest.requireActual('../src/modules/parser/extractor');
  return { ...original, extractListingsBatchWithLLM: jest.fn() };
});

import { extractListingsBatchWithLLM } from '../src/modules/parser/extractor';
const mockedBatch = extractListingsBatchWithLLM as jest.Mock;

// These fixtures match the un-enriched shape returned by scrapeListingDetail.
// No requests to Khmer24, LLM calls, or production DB writes occur here.
describe('Khmer24 raw listing → canonical ingestion → public API', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let container: ReturnType<typeof createContainer>;
  const originalReadPath = env.LISTING_READ_PATH;
  const originalCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;

  const rawListing = (id: string, overrides: Partial<RawListing> = {}): RawListing => ({
    title: `House for rent in Wat Bo ${id}`,
    description: 'House for rent in Siem Reap, $450 per month.',
    raw_text: 'House for rent in Siem Reap, $450 per month.',
    source_url: `https://www.khmer24.com/en/post-adid-${id}`,
    url: `https://www.khmer24.com/en/post-adid-${id}`,
    type: 'rent', category: 'house', city: 'siem_reap',
    location: 'Wat Bo', price: 450, currency: 'USD', photos: [],
    ...overrides,
  });

  const ingest = (listing: RawListing, classification?: LiveListingEnvelope['classification'], observedAt = '2026-10-16T00:00:00Z') => {
    const adapter = new Khmer24LiveAdapter(async function* () {
      yield { sourceId: 'siem-reap', sourceName: 'Khmer24', sourceUrl: 'https://www.khmer24.com/', listing, classification };
    });
    return container.ingestionService.ingestBatch(adapter, {
      runType: 'DISCOVERY', ingestionMethod: 'KHMER24_SCRAPER', parserVersion: 'khmer24-canonical-v1', observedAt,
    });
  };

  beforeEach(async () => {
    mockedBatch.mockReset();
    env.LISTING_READ_PATH = 'canonical';
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    container = createContainer({ db });
    app = await buildApiServer({ container, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    env.LISTING_READ_PATH = originalReadPath;
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = originalCanaries;
  });

  it('records a raw unclassified item without publishing it, and dedupes a second sighting', async () => {
    const raw = rawListing('901001');
    expect(raw.posted_at).toBeUndefined();
    expect(classifyKhmer24Listing(raw)).toBe('UNCLASSIFIED');
    const first = await ingest(raw, classifyKhmer24Listing(raw));
    expect(first).toMatchObject({ inputItems: 1, processedItems: 1, newSourceItems: 1, newVersions: 1, errors: [] });
    expect(db.prepare('SELECT external_id,classification,published_at FROM source_items').get())
      .toEqual({ external_id: '901001', classification: 'UNCLASSIFIED', published_at: null });
    const extraction = JSON.parse((db.prepare('SELECT raw_payload_json FROM source_items').get() as { raw_payload_json: string }).raw_payload_json).listingExtraction;
    expect(extraction).toMatchObject({ price: 450, currency: 'USD', category: 'house', city: 'siem_reap' });
    expect(extraction.offer_type).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({ n: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/v1/properties' })).json().total).toBe(0);

    const again = await ingest(raw, classifyKhmer24Listing(raw), '2026-10-16T01:00:00Z');
    expect(again).toMatchObject({ unchangedSourceItems: 1, newVersions: 0, errors: [] });
    expect(db.prepare('SELECT COUNT(*) n FROM source_item_versions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT last_seen_at FROM source_items').get()).toEqual({ last_seen_at: '2026-10-16T01:00:00Z' });
  });

  it('carries an explicit source publication timestamp into canonical source records', async () => {
    const raw = rawListing('901004', { posted_at: '2026-10-15 11:04:55' });
    const first = await ingest(raw, classifyKhmer24Listing(raw));
    expect(first).toMatchObject({ newSourceItems: 1, newVersions: 1, errors: [] });
    expect(db.prepare('SELECT published_at FROM source_items WHERE external_id=?').get('901004'))
      .toEqual({ published_at: '2026-10-15 11:04:55' });
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({ n: 0 });
  });

  it('automatically publishes a corroborated rental with no substantive review flags', async () => {
    const photos = Array.from({ length: 11 }, (_, i) => `https://example.com/house-photo-${i + 1}.jpg`);
    const raw = rawListing('901002', {
      photos, bedrooms: 3, bathrooms: 3, min_lease: 12,
      raw_text: 'House for rent in Siem Reap, 3 bedrooms and 3 bathrooms, $450 per month.',
      is_real_estate: true,
      listing_facts_json: JSON.stringify({ offer_type: 'rent', title_en: 'Test house Wat Bo',
        description_en: 'House for rent $450/month', category: 'house', city: 'siem_reap', sangkat: 'Wat Bo',
        bedrooms: 3, bathrooms: 3, min_lease_months: 12 }),
    });
    expect(classifyKhmer24Listing(raw)).toBe('HOUSING_SUPPLY');
    const result = await ingest(raw, classifyKhmer24Listing(raw));
    expect(result).toMatchObject({ processedItems: 1, newSourceItems: 1, errors: [] });
    const listing = db.prepare(`SELECT l.id,l.public_ref,m.review_status FROM canonical_listings l
      JOIN canonical_listing_moderation m ON m.listing_id=l.id`) .get() as { id: number; public_ref: string; review_status: string };
    expect(listing).toBeDefined();
    expect(listing.review_status).toBe('approved');
    const list = await app.inject({ method: 'GET', url: '/api/v1/properties' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, items: [{ publicRef: listing.public_ref, priceUsd: 450, city: 'siem_reap', type: 'rent' }] });
    expect(list.json().items[0].photos).toHaveLength(8);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ bedrooms: 3, bathrooms: 3, minLeaseMonths: 12, postedAt: null });
    expect([...detail.json().photos].sort()).toEqual([...photos].sort());
    const map = await app.inject({ method: 'GET', url: '/api/v1/properties/map' });
    expect(map.statusCode).toBe(200);
    expect(map.json().markers.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({ n: 1 });

    const again = await ingest(raw, classifyKhmer24Listing(raw), '2026-10-16T01:00:00Z');
    expect(again).toMatchObject({ unchangedSourceItems: 1, newVersions: 0, errors: [] });
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({ n: 1 });
  });

  it('preserves a Khmer24 property pin through canonical ingestion, public detail, list and map', async () => {
    const raw = rawListing('901020', {
      title: 'Villa with source-confirmed location 901020',
      latitude: 13.358721,
      longitude: 103.857632,
      maps_url: 'https://www.google.com/maps?q=13.358721,103.857632',
      is_real_estate: true,
      listing_facts_json: JSON.stringify({
        offer_type: 'rent', category: 'house', city: 'siem_reap', sangkat: 'Wat Bo',
        latitude: 13.388888, longitude: 103.899999,
        maps_url: 'https://www.google.com/maps?q=13.388888,103.899999',
      }),
    });
    const result = await ingest(raw, classifyKhmer24Listing(raw));
    expect(result).toMatchObject({ newSourceItems: 1, errors: [] });
    const listing = db.prepare(`SELECT l.id,l.public_ref,m.review_status FROM canonical_listings l
      JOIN canonical_listing_moderation m ON m.listing_id=l.id`).get() as {
        id: number; public_ref: string; review_status: string;
      };
    expect(listing.review_status).toBe('approved');

    const source = db.prepare('SELECT raw_payload_json FROM source_items').get() as { raw_payload_json: string };
    const extracted = JSON.parse(source.raw_payload_json).listingExtraction;
    expect(extracted).toMatchObject({
      latitude: 13.358721, longitude: 103.857632,
      maps_url: 'https://www.google.com/maps?q=13.358721,103.857632',
    });

    const list = await app.inject({ method: 'GET', url: '/api/v1/properties' });
    expect(list.json().items[0]).toMatchObject({
      publicRef: listing.public_ref, coordinatePrecision: 'exact',
      coordinates: { lat: 13.358721, lng: 103.857632 },
    });
    const detail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}` });
    expect(detail.json()).toMatchObject({
      coordinatePrecision: 'exact', coordinates: { lat: 13.358721, lng: 103.857632 },
      mapsUrl: 'https://www.google.com/maps?q=13.358721,103.857632',
    });
    const map = await app.inject({ method: 'GET', url: '/api/v1/properties/map' });
    expect(map.json().markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicRef: listing.public_ref, isExact: true,
        coordinates: { lat: 13.358721, lng: 103.857632 } }),
    ]));
  });

  it('keeps district-only Khmer24 listings approximate in detail, list and map', async () => {
    const raw = rawListing('901021', {
      title: 'District-only Khmer24 villa 901021',
      location: 'Sala Kamreuk',
      is_real_estate: true,
      listing_facts_json: JSON.stringify({
        offer_type: 'rent', category: 'house', city: 'siem_reap', sangkat: 'Sala Kamreuk',
      }),
    });
    const result = await ingest(raw, classifyKhmer24Listing(raw));
    expect(result).toMatchObject({ newSourceItems: 1, errors: [] });
    const listing = db.prepare('SELECT l.id,l.public_ref FROM canonical_listings l').get() as {
      id: number; public_ref: string;
    };
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);

    const list = await app.inject({ method: 'GET', url: '/api/v1/properties' });
    expect(list.json().items[0]).toMatchObject({
      publicRef: listing.public_ref, coordinatePrecision: 'district', coordinates: null,
    });
    const detail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}` });
    expect(detail.json()).toMatchObject({ coordinatePrecision: 'district', coordinates: null });
    const map = await app.inject({ method: 'GET', url: '/api/v1/properties/map' });
    expect(map.json().markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ isExact: false, coordinatePrecision: 'district' }),
    ]));
    expect(map.json().markers.some((marker: { isExact: boolean; publicRef?: string }) =>
      marker.isExact && marker.publicRef === listing.public_ref)).toBe(false);
  });

  it('quarantines a sale mistakenly found in the rent category when explicitly rejected by enrichment', async () => {
    const raw = rawListing('901003', {
      title: 'House for sale', description: 'Sale price $79,000', raw_text: 'House for sale $79000',
      price: 79000, is_real_estate: false,
    });
    expect(raw.type).toBe('rent'); // A category-feed label is not evidence of transaction type.
    expect(classifyKhmer24Listing(raw)).toBe('IRRELEVANT');
    const result = await ingest(raw, classifyKhmer24Listing(raw));
    expect(result).toMatchObject({ newSourceItems: 1, processedItems: 1, errors: [] });
    expect(db.prepare('SELECT classification FROM source_items').get()).toEqual({ classification: 'IRRELEVANT' });
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({ n: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/v1/properties' })).json().total).toBe(0);
  });

  it('persists every enriched source with rejection reasons and quarantines unverified records', async () => {
    const negative = rawListing('901010', {
      raw_text: 'Verbatim Khmer24 sale offer', is_real_estate: true,
    });
    const positive = rawListing('901011', { raw_text: 'Verbatim Khmer24 rental offer' });
    const unavailable = rawListing('901012', {
      raw_text: 'Original description with no AI reply', is_real_estate: true,
    });
    const baseLlm: LLMExtractedListing = {
      is_real_estate: true, title_en: 'House for rent in Wat Bo', description_en: 'Monthly house rental in Wat Bo.',
      price: 450, currency: 'USD', category: 'house', bedrooms: 2, bathrooms: 1,
      min_lease: null, has_pool: null, pet_friendly: null, location: 'Wat Bo',
      phone_numbers: [], maps_url: null,
    };
    mockedBatch.mockResolvedValue(new Map([
      [0, { ...baseLlm, is_real_estate: false, admission_reason: 'Sale price, not rental',
        canonical_facts: { rejection_reason: 'Sale listing', price: null } as LLMExtractedListing['canonical_facts'] }],
      [1, { ...baseLlm, canonical_facts: {
        offer_type: 'rent', price: 450, currency: 'USD', category: 'house', city: 'siem_reap',
      } as unknown as LLMExtractedListing['canonical_facts'] }],
      // Third ID deliberately missing: it must stay UNCLASSIFIED, even with stale is_real_estate=true.
    ]));

    const originals = [negative, positive, unavailable];
    const enriched = await enrichListingsWithLLM(originals, { inclusive: true });
    expect(enriched).toHaveLength(3);
    const adapter = new Khmer24LiveAdapter(async function* () {
      for (const listing of enriched) yield {
        sourceId: 'siem-reap', sourceName: 'Khmer24', sourceUrl: 'https://www.khmer24.com/',
        listing, classification: classifyKhmer24Listing(listing),
      };
    });
    const result = await container.ingestionService.ingestBatch(adapter, {
      runType: 'DISCOVERY', ingestionMethod: 'KHMER24_SCRAPER', parserVersion: 'khmer24-canonical-v1',
      observedAt: '2026-10-16T00:00:00Z',
    });

    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ inputItems: 3, processedItems: 3, newSourceItems: 3, errors: [] });
    const rows = db.prepare('SELECT external_id,classification,raw_text,raw_payload_json FROM source_items ORDER BY external_id').all() as
      { external_id: string; classification: string; raw_text: string; raw_payload_json: string }[];
    expect(rows.map(({ external_id, classification }) => [external_id, classification])).toEqual([
      ['901010', 'IRRELEVANT'], ['901011', 'HOUSING_SUPPLY'], ['901012', 'UNCLASSIFIED'],
    ]);
    expect(rows.map((row) => row.raw_text)).toEqual(originals.map((listing) => listing.raw_text));
    const rejectedPayload = JSON.parse(rows[0].raw_payload_json);
    expect(rejectedPayload.listing).toMatchObject({
      is_real_estate: false, review_reason: 'Sale price, not rental',
      raw_text: negative.raw_text,
    });
    expect(rejectedPayload.listingExtraction).toMatchObject({ rejection_reason: 'Sale listing' });
    const missingPayload = JSON.parse(rows[2].raw_payload_json);
    expect(missingPayload.listing).toMatchObject({
      is_real_estate: null, review_reason: 'LLM extraction unavailable', raw_text: unavailable.raw_text,
    });
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT review_status FROM canonical_listing_moderation').get()).toEqual({ review_status: 'pending' });
    const list = await app.inject({ method: 'GET', url: '/api/v1/properties' });
    const map = await app.inject({ method: 'GET', url: '/api/v1/properties/map' });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(0);
    expect(map.statusCode).toBe(200);
    expect(map.json().markers).toHaveLength(0);
  });
});
