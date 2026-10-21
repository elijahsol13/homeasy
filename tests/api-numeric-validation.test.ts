import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createContainer } from '../src/container';
import { env } from '../src/config/env';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { buildApiServer } from '../src/modules/api/server';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

describe('catalog numeric HTTP query validation', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let requestNumber = 0;
  const previousReadPath = env.LISTING_READ_PATH;
  const previousShadow = env.LISTING_READ_SHADOW;

  const get = (url: string) => app.inject({
    method: 'GET', url,
    // Isolate the requests from the global per-IP rate limiter, not the API code.
    headers: { 'x-forwarded-for': `192.0.2.${1 + (requestNumber++ % 250)}` },
  });

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    const container = createContainer({ db });
    for (const [i, price] of [350, 1200].entries()) {
      container.propertiesRepo.insertProperty({
        hash: `numeric-http-legacy-${i}`, title: `Numeric validation house ${i}`,
        description: 'For rent in Sala Kamreuk, Siem Reap', price: price * 100,
        currency: 'USD', type: 'rent', category: 'house', bedrooms: i + 1,
        bathrooms: i + 1, deposit: null, min_lease: 6, has_pool: false,
        location: 'Sala Kamreuk', city: 'siem_reap', maps_url: null,
        source_url: null, original_url: '', photos: [], direct_contact: {},
      });
    }

    const sources = new SourceIngestionRepository(db);
    const source = sources.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'numeric-http-test', name: 'Numeric HTTP test' });
    for (const [i, price] of [350, 1200].entries()) {
      sources.upsertSourceItemDetailed(source, {
        sourceType: 'FACEBOOK_GROUP', externalId: `numeric-http-${i}`,
        sourceUrl: `https://facebook.com/groups/numeric-http-test/posts/${i}`,
        contentHash: `numeric-http-${i}`,
        rawText: `Distinct house ${i} for rent in Siem Reap for $${price}/month`,
        classification: 'HOUSING_SUPPLY',
        rawPayload: { listingExtraction: {
          title_en: `Numeric validation house ${i}`, description_en: 'House for rent in Sala Kamreuk, Siem Reap',
          price, currency: 'USD', category: 'house', bedrooms: i + 1, bathrooms: i + 1,
          city: 'siem_reap', sangkat: 'Sala Kamreuk', offer_type: 'rent',
        }, photos: [] },
      });
    }
    new CanonicalShadowService(db).run({ dryRun: false });
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved'").run();
    env.LISTING_READ_SHADOW = false;
    app = await buildApiServer({ container, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
    env.LISTING_READ_PATH = previousReadPath;
    env.LISTING_READ_SHADOW = previousShadow;
  });

  for (const path of ['legacy', 'canonical'] as const) {
    describe(`${path} read path`, () => {
      beforeEach(() => { env.LISTING_READ_PATH = path; });

      it.each([
        ['page=abc', 'page'], ['page=NaN', 'page'], ['page=Infinity', 'page'],
        ['page=1.5', 'page'], ['page=0', 'page'], ['page=-1', 'page'],
        ['page=9007199254740992', 'page'], ['page=9007199254740991&limit=2', 'page'],
        ['page=', 'page'], ['page=1&page=2', 'page'],
        ['limit=bad', 'limit'], ['limit=1.1', 'limit'], ['limit=0', 'limit'],
        ['limit=-1', 'limit'], ['limit=Infinity', 'limit'], ['limit=', 'limit'],
        ['min_price=bad', 'min_price'], ['min_price=1.5', 'min_price'],
        ['min_price=10abc', 'min_price'], ['min_price=90071992547410', 'min_price'],
        ['max_price=Infinity', 'max_price'], ['max_price=-1', 'max_price'],
        ['min_lease_max=oops', 'min_lease_max'], ['min_lease_max=1.5', 'min_lease_max'],
        ['bedrooms=1,NaN', 'bedrooms'], ['bedrooms=1.5', 'bedrooms'],
        ['bathrooms=Infinity', 'bathrooms'], ['bathrooms=2,', 'bathrooms'],
      ])('returns 400 for invalid %s before querying %s', async (query, field) => {
        const res = await get(`/api/v1/properties?${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain(field);
      });

      it('keeps defaults, positive pages, filters, zero minimum and page-size cap', async () => {
        const defaultRes = await get('/api/v1/properties');
        expect(defaultRes.statusCode).toBe(200);
        expect(defaultRes.json()).toMatchObject({ page: 1, limit: 20, total: 2 });

        const second = await get('/api/v1/properties?page=2&limit=1&min_price=350&sort=price_asc');
        expect(second.statusCode).toBe(200);
        expect(second.json()).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
        expect(second.json().items.map((p: { priceUsd: number }) => p.priceUsd)).toEqual([1200]);

        const max = await get('/api/v1/properties?limit=9999999&max_price=400&min_price=0&min_lease_max=0');
        expect(max.statusCode).toBe(200);
        expect(max.json()).toMatchObject({ page: 1, limit: 50, total: 1 });
        expect(max.json().items[0].priceUsd).toBe(350);

        const selected = await get('/api/v1/properties?bedrooms=1,2&bathrooms=1,2&min_lease_max=6');
        expect(selected.statusCode).toBe(200);
        expect(selected.json().total).toBe(2);
      });

      it.each([
        ['limit=cat', 'limit'], ['limit=1.5', 'limit'], ['limit=0', 'limit'],
        ['minLat=Infinity&maxLat=14&minLng=103&maxLng=104', 'minLat'],
        ['minLat=13&maxLat=14&minLng=103&maxLng=NaN', 'maxLng'],
        ['minLat=13junk&maxLat=14&minLng=103&maxLng=104', 'minLat'],
        ['minLat=13&maxLat=14&minLng=103&maxLng=104&paddingRatio=Infinity', 'paddingRatio'],
        ['minLat=13&maxLat=14&minLng=103&maxLng=104&paddingRatio=-1', 'paddingRatio'],
        ['minLat=13&maxLat=14&minLng=103&maxLng=104&paddingRatio=1e309', 'paddingRatio'],
        ['minLat=13&maxLat=15&minLng=103&maxLng=104&paddingRatio=1e308', 'paddingRatio'],
      ])('returns 400 for invalid map %s (%s)', async (query, field) => {
        const res = await get(`/api/v1/properties/map?${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain(field);
      });

      it('preserves map limits and finite decimal bounds', async () => {
        expect((await get('/api/v1/properties/map?limit=9999999')).statusCode).toBe(200);
        const response = await get('/api/v1/properties/map?limit=1&minLat=13.3&maxLat=13.4&minLng=103.8&maxLng=103.9&paddingRatio=0');
        expect(response.statusCode).toBe(200);
        expect(Array.isArray(response.json().markers)).toBe(true);
      });
    });
  }

  it('keeps canonical listings with unknown prices visible under a valid price filter', async () => {
    env.LISTING_READ_PATH = 'canonical';
    const row = db.prepare('SELECT id, price FROM canonical_listings ORDER BY price ASC LIMIT 1')
      .get() as { id: number; price: number };
    db.prepare('UPDATE canonical_listings SET price=0 WHERE id=?').run(row.id);
    try {
      const result = await get('/api/v1/properties?min_price=1000&limit=1&page=2&sort=price_asc');
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ total: 2, page: 2, limit: 1 });
      expect(result.json().items[0].priceUsd).toBe(0);
    } finally {
      db.prepare('UPDATE canonical_listings SET price=? WHERE id=?').run(row.price, row.id);
    }
  });
});
