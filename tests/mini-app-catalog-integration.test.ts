import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createContainer } from '../src/container';
import { env } from '../src/config/env';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { buildApiServer } from '../src/modules/api/server';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

type CatalogItem = { id: number; bedrooms: number | null; priceUsd: number; location: string; category: string };
type CatalogPage = { page: number; limit: number; total: number; totalPages: number; items: CatalogItem[] };
type MapResponse = { count: number; markers: Array<{ isExact: boolean; count?: number; locationKey: string | null; bedrooms: number | null; priceUsd: number; publicRef?: string }> };

/** Six independent offers; their source and legacy copies exist only in RAM. */
const offers = [
  { bedrooms: 2, price: 200, category: 'apartment', location: 'Sala Kamreuk' },
  { bedrooms: 3, price: 300, category: 'house', location: 'Sala Kamreuk' },
  { bedrooms: 4, price: 400, category: 'house', location: 'Wat Bo' },
  { bedrooms: 5, price: 500, category: 'house', location: 'Wat Bo' },
  { bedrooms: 6, price: 600, category: 'house', location: 'Wat Bo' },
  { bedrooms: null, price: 700, category: 'apartment', location: 'Wat Bo' },
] as const;

describe('Mini App listing query integration through Fastify and in-memory SQLite', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let requestCounter = 0;
  const originalReadPath = env.LISTING_READ_PATH;
  const originalShadow = env.LISTING_READ_SHADOW;

  const request = (params = '') => app.inject({
    method: 'GET', url: `/api/v1/properties${params ? `?${params}` : ''}`,
    headers: { 'x-forwarded-for': `198.51.100.${1 + (requestCounter++ % 240)}` },
  });

  const list = async (params = ''): Promise<CatalogPage> => {
    const response = await request(params);
    expect(response.statusCode).toBe(200);
    return response.json() as CatalogPage;
  };
  const bedrooms = (page: CatalogPage) => page.items.map((item) => item.bedrooms);
  const map = async (params = ''): Promise<MapResponse> => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/properties/map${params ? `?${params}` : ''}` });
    expect(response.statusCode).toBe(200);
    return response.json() as MapResponse;
  };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    const container = createContainer({ db });
    const sources = new SourceIngestionRepository(db);
    const sourceId = sources.upsertSource({
      sourceType: 'FACEBOOK_GROUP', externalSourceId: 'mini-app-http-integration', name: 'Test fixtures',
    });

    offers.forEach((offer, i) => {
      const title = `Integration ${i} ${offer.bedrooms ?? 'unknown'} bedroom house ${offer.location}`;
      const date = `2026-10-${String(10 + i).padStart(2, '0')}T12:00:00Z`;
      container.propertiesRepo.insertProperty({
        hash: `mini-app-integration-${i}`, title,
        description: `Independent rental offer ${i} in ${offer.location}, Siem Reap`,
        price: offer.price * 100, currency: 'USD', type: 'rent', category: offer.category,
        bedrooms: offer.bedrooms, bathrooms: 2, deposit: null, min_lease: 6,
        has_pool: false, location: offer.location, city: 'siem_reap',
        maps_url: null, source_url: null, original_url: '', photos: [], direct_contact: {}, posted_at: date,
      });
      sources.upsertSourceItemDetailed(sourceId, {
        sourceType: 'FACEBOOK_GROUP', externalId: `mini-app-offer-${i}`,
        sourceUrl: `https://facebook.com/groups/mini-app-http-integration/posts/${i}`,
        contentHash: `mini-app-offer-${i}`,
        rawText: `${title}: independent rental property ${i} in Siem Reap for $${offer.price}/month`,
        classification: 'HOUSING_SUPPLY',
        rawPayload: { listingExtraction: {
          title_en: title, description_en: `Independent rental property ${i} in ${offer.location}, Siem Reap`,
          price: offer.price, currency: 'USD', category: offer.category,
          bedrooms: offer.bedrooms, bathrooms: 2, city: 'siem_reap',
          sangkat: offer.location, offer_type: 'rent', min_lease_months: 6,
        }, photos: [] },
      });
    });

    new CanonicalShadowService(db).run({ dryRun: false });
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved'").run();
    // The fixture uses independent source identities; lock the unknown-bedroom
    // case to SQL NULL even if upstream extraction infers it from the title.
    db.prepare("UPDATE canonical_listings SET bedrooms=NULL, price=0 WHERE title LIKE 'Integration 5 %'").run();
    expect((db.prepare('SELECT COUNT(*) AS count FROM canonical_listings').get() as { count: number }).count).toBe(6);
    env.LISTING_READ_SHADOW = false;
    app = await buildApiServer({ container, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) db.close();
    env.LISTING_READ_PATH = originalReadPath;
    env.LISTING_READ_SHADOW = originalShadow;
  });

  for (const path of ['legacy', 'canonical'] as const) {
    describe(`${path} catalog path`, () => {
      beforeEach(() => { env.LISTING_READ_PATH = path; });

      it('returns a safe first page with default sort and complete count (A)', async () => {
        const result = await list();
        expect(result).toMatchObject({ page: 1, limit: 20, total: 6, totalPages: 1 });
        expect(result.items).toHaveLength(6);
        expect(result.items.every((item) => item.id > 0)).toBe(true);
      });

      it('applies 4+ BR and a mixed 2 BR / 4+ BR selection (C)', async () => {
        const four = await list('bedrooms=4&sort=price_asc');
        const mixed = await list('bedrooms=2,4&sort=price_asc');
        expect(bedrooms(four)).toEqual([4, 5, 6]);
        expect(four.total).toBe(3);
        expect(bedrooms(mixed)).toEqual([2, 4, 5, 6]);
        expect(mixed.total).toBe(4);
      });

      it('uses identical cohort filters for map clusters and list, including cluster-key navigation', async () => {
        const selectedLocation = path === 'legacy' ? 'Sla Kram' : 'Wat Bo';
        const params = `category=house&locations_json=${encodeURIComponent(JSON.stringify([selectedLocation]))}&min_price=350&max_price=550&bedrooms=4&bathrooms=2&min_lease_max=6&query=Integration`;
        const feed = await list(params);
        expect(feed.total).toBe(2);
        const markers = await map(`${params}&limit=1`);
        expect(markers.markers.filter((item) => item.isExact)).toHaveLength(0);
        expect(markers.markers.reduce((count, marker) => count + (marker.count ?? 1), 0)).toBe(feed.total);
        const cluster = markers.markers.find((marker) => !marker.isExact);
        expect(cluster?.locationKey).toBeTruthy();
        const fromCluster = await list(`${params}&map_cluster_key=${encodeURIComponent(cluster!.locationKey!)}`);
        expect(fromCluster.total).toBe(2);
        expect(bedrooms(fromCluster)).toEqual(expect.arrayContaining([4, 5]));
      });

      it('updates map clusters for 4+ BR, mixed selections and empty filtered cohorts', async () => {
        const mapTotal = async (params: string) =>
          (await map(params)).markers.reduce((count, marker) => count + (marker.count ?? 1), 0);
        expect(await mapTotal('bedrooms=4')).toBe(3);
        expect(await mapTotal('bedrooms=2,4')).toBe(4);
        expect(await mapTotal('bedrooms=3')).toBe(1);
        expect(await mapTotal('bedrooms=4&category=room')).toBe(0);
        expect(await mapTotal('')).toBe(6);
      });

      it('combines category, location, price, rooms, and correct pagination (B, D)', async () => {
        // Legacy stores the canonical administrative location (Sla Kram),
        // while canonical uses the source's displayed Wat Bo location.
        const selectedLocation = path === 'legacy' ? 'Sla Kram' : 'Wat Bo';
        const shared = `category=house&locations_json=${encodeURIComponent(JSON.stringify([selectedLocation]))}&min_price=350&max_price=550&bedrooms=4`;
        const asc = await list(`${shared}&sort=price_asc`);
        expect(asc.total).toBe(2);
        expect(asc.items.map((item) => item.priceUsd)).toEqual([400, 500]);
        expect(asc.items.every((item) => item.category === 'house' && item.location === selectedLocation)).toBe(true);

        const desc = await list(`${shared}&sort=price_desc`);
        expect(desc.items.map((item) => item.priceUsd)).toEqual([500, 400]);

        const page2 = await list(`${shared}&sort=price_asc&limit=1&page=2`);
        expect(page2).toMatchObject({ total: 2, limit: 1, page: 2, totalPages: 2 });
        expect(page2.items.map((item) => item.priceUsd)).toEqual([500]);

        const newest = await list(`${shared}&sort=newest`);
        expect(newest.total).toBe(2);
        expect(newest.items.map((item) => item.priceUsd).sort()).toEqual([400, 500]);
      });

      it('filters geography without breaking JSON location aliases (B, G)', async () => {
        const selectedLocation = path === 'legacy' ? 'Sla Kram' : 'Wat Bo';
        const result = await list(`locations_json=${encodeURIComponent(JSON.stringify([selectedLocation]))}&sort=price_asc`);
        expect(result.total).toBe(4);
        expect(result.items.every((item) => item.location === selectedLocation)).toBe(true);
      });

      it('returns empty matches and rejects invalid numeric values before SQLite (H)', async () => {
        const empty = await list('category=room&bedrooms=4');
        expect(empty).toMatchObject({ total: 0, totalPages: 0, items: [] });
        const invalid = await request('category=house&bedrooms=4&max_price=abc&sort=price_asc');
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().message).toContain('max_price');
      });
    });
  }

  it('preserves canonical unknown-price matches but excludes unknown-bedroom matches (C)', async () => {
    env.LISTING_READ_PATH = 'canonical';
    const result = await list('bedrooms=4&min_price=100&max_price=650&sort=price_asc');
    expect(bedrooms(result)).toEqual([4, 5, 6]);
  });

  it('rejects malformed map cluster keys and returns zero for a valid but nonexistent cluster (G, H)', async () => {
    env.LISTING_READ_PATH = 'canonical';
    const bad = await request('map_cluster_key=siem_reap:bad%2Fkey');
    expect(bad.statusCode).toBe(400);
    const absent = await list('map_cluster_key=siem_reap:absent');
    expect(absent.total).toBe(0);
  });

  it('documents the current Siem Reap rental-only API policy for saved city/type (F)', async () => {
    for (const path of ['legacy', 'canonical'] as const) {
      env.LISTING_READ_PATH = path;
      const result = await list('city=phnom_penh&type=sale');
      expect(result.total).toBe(6);
    }
  });
});
