import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { validateTelegramInitData } from '../src/modules/api/auth';
import { env } from '../src/config/env';
import { buildApiServer } from '../src/modules/api/server';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';
import type { FastifyInstance } from 'fastify';

/**
 * Helper to generate a valid Telegram initData query string for a given bot token.
 */
function createMockTelegramInitData(
  user: { id: number; first_name: string; username?: string },
  botToken: string,
  authDate: number = Math.floor(Date.now() / 1000),
): string {
  const params = new Map<string, string>();
  params.set('auth_date', authDate.toString());
  params.set('query_id', 'AAHdF6IQAAAAAN0XohD1xZc_');
  params.set('user', JSON.stringify(user));

  const sortedKeys = Array.from(params.keys()).sort();
  const dataCheckString = sortedKeys.map((k) => `${k}=${params.get(k)}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  params.set('hash', hash);

  const searchParams = new URLSearchParams();
  params.forEach((v, k) => searchParams.set(k, v));
  return searchParams.toString();
}

describe('Telegram Mini App (TMA) Backend API', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let container: ReturnType<typeof createContainer>;
  const testBotToken = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_TEST';

  beforeAll(async () => {
    // In-memory database for isolated, lightning-fast testing
    db = new DatabaseSync(':memory:');
    runMigrations(db);

    container = createContainer({ db });

    // Seed test properties
    container.propertiesRepo.insertProperty({
      hash: 'test_hash_1',
      title: 'Modern 1BR Apartment in Sala Kamreuk with Pool',
      description: 'Cozy modern apartment. Electricity EDC ~$0.20/kWh, Water included. No Pets allowed.',
      price: 35000, // $350
      currency: 'USD',
      type: 'rent',
      category: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      deposit: 35000,
      min_lease: 6,
      has_pool: true,
      location: 'Sala Kamreuk',
      city: 'siem_reap',
      maps_url: 'https://www.google.com/maps/search/?api=1&query=13.3512,103.8645',
      source_url: 'https://facebook.com/groups/test/posts/111',
      original_url: 'https://facebook.com/groups/test/posts/111',
      photos: ['https://example.com/photo1.jpg', 'https://example.com/photo2.jpg'],
      direct_contact: { phone: '+85512345678', telegram: '@sr_agent' },
      is_active: 1,
    });

    container.propertiesRepo.insertProperty({
      hash: 'test_hash_2',
      title: 'Luxury 3BR Private Villa in Slor Kram',
      description: 'Spacious villa with garden. Electricity $0.25/kWh, Water $5/person. Pet friendly.',
      price: 120000, // $1200
      currency: 'USD',
      type: 'rent',
      category: 'house',
      bedrooms: 3,
      bathrooms: 3,
      deposit: 240000,
      min_lease: 12,
      has_pool: true,
      location: 'Slor Kram',
      city: 'siem_reap',
      maps_url: 'https://www.google.com/maps/search/?api=1&query=13.3645,103.8712',
      source_url: 'https://facebook.com/groups/test/posts/222',
      original_url: 'https://facebook.com/groups/test/posts/222',
      photos: ['https://example.com/villa.jpg'],
      direct_contact: { phone: '+85587654321' },
      is_active: 1,
    });

    container.propertiesRepo.insertProperty({
      hash: 'test_hash_3',
      title: 'Studio Room in Sla Kram',
      description: 'Affordable studio near the market.',
      price: 45000, // $450
      currency: 'USD',
      type: 'rent',
      category: 'room',
      bedrooms: 0,
      bathrooms: 1,
      deposit: 45000,
      min_lease: 1,
      has_pool: false,
      location: 'Sla Kram',
      city: 'siem_reap',
      maps_url: null,
      source_url: 'https://khmer24.com/p-333',
      original_url: 'https://khmer24.com/p-333',
      photos: [],
      direct_contact: {},
      is_active: 1,
    });

    app = await buildApiServer({ container, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  // ─── 1. Telegram initData Authentication ──────────────────────────────────────

  describe('Telegram WebApp HMAC Authentication', () => {
    const mockUser = { id: 987654321, first_name: 'Alex', username: 'alex_tma' };

    it('validates genuine Telegram initData successfully', () => {
      const validInitData = createMockTelegramInitData(mockUser, testBotToken);
      const result = validateTelegramInitData(validInitData, testBotToken);

      expect(result.isValid).toBe(true);
      expect(result.data?.user.id).toBe(mockUser.id);
      expect(result.data?.user.first_name).toBe(mockUser.first_name);
      expect(result.data?.user.username).toBe(mockUser.username);
    });

    it('validates URI-encoded initData containing non-ASCII / Cyrillic characters', () => {
      const cyrillicUser = { id: 12345678, first_name: 'Илья', username: 'ilya_dev' };
      const rawInitData = createMockTelegramInitData(cyrillicUser, testBotToken);
      const encodedInitData = encodeURIComponent(rawInitData);

      const result = validateTelegramInitData(encodedInitData, testBotToken);
      expect(result.isValid).toBe(true);
      expect(result.data?.user.id).toBe(cyrillicUser.id);
      expect(result.data?.user.first_name).toBe('Илья');
    });

    it('rejects tampered data with mismatched HMAC hash', () => {
      const validInitData = createMockTelegramInitData(mockUser, testBotToken);
      // Tamper user ID in payload
      const tampered = validInitData.replace(String(mockUser.id), '999999999');
      const result = validateTelegramInitData(tampered, testBotToken);

      expect(result.isValid).toBe(false);
      expect(result.error).toMatch(/Invalid HMAC signature/i);
    });

    it('rejects expired initData when maxAgeSeconds is exceeded', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 100000; // >24h old
      const expiredInitData = createMockTelegramInitData(mockUser, testBotToken, oldTimestamp);
      const result = validateTelegramInitData(expiredInitData, testBotToken, 86400);

      expect(result.isValid).toBe(false);
      expect(result.error).toMatch(/expired/i);
    });

    it('rejects empty or missing hash strings gracefully', () => {
      expect(validateTelegramInitData('', testBotToken).isValid).toBe(false);
      expect(validateTelegramInitData('user=123', testBotToken).isValid).toBe(false);
    });
  });

  // ─── 2. Health Endpoint ───────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns server health status and property count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.stats.properties).toBe(3);
      expect(typeof body.uptime).toBe('number');
    });
  });

  // ─── 3. Properties Catalog Endpoint ───────────────────────────────────────────

  describe('GET /api/v1/properties', () => {
    it('returns paginated property list with rich DTO fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.items.length).toBe(3);

      const first = body.items[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('title');
      expect(first).toHaveProperty('priceUsd');
      expect(first).toHaveProperty('propertyType');
      expect(first).toHaveProperty('specs');
      expect(first).toHaveProperty('contact');
    });

    it('keeps the public catalog scoped to Siem Reap during the MVP', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?city=phnom_penh',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.items.every((item: { city: string; type: string }) => item.city === 'siem_reap' && item.type === 'rent')).toBe(true);
    });

    it('filters properties by price range and pool', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?city=siem_reap&max_price=500&has_pool=true',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.items[0].priceUsd).toBe(350);
      expect(body.items[0].hasPool).toBe(true);
    });

    it('sorts properties by price ascending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?sort=price_asc',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items[0].priceUsd).toBe(350);
      expect(body.items[1].priceUsd).toBe(450);
      expect(body.items[2].priceUsd).toBe(1200);
    });

    it('extracts Cambodian utilities and restrictions into DTO specs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?city=siem_reap&max_price=400',
      });

      const prop = res.json().items[0];
      expect(prop.specs.electricity).toMatch(/EDC/);
      expect(prop.specs.water).toMatch(/Included/);
      expect(prop.specs.restrictions).toContain('🚫 No Pets');
      expect(prop.contact.telegram).toBe('@sr_agent');
      expect(prop.contact.telegramLink).toBe('https://t.me/sr_agent');
    });
  });

  // ─── 4. Single Property Detail Endpoint ───────────────────────────────────────

  describe('GET /api/v1/properties/:id', () => {
    it('uses canonical list, map, detail, and favorites for an allowlisted user only', async () => {
      const priorPath = env.LISTING_READ_PATH;
      const priorCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      const canaryId = 1122334455;
      try {
        const sourceRepo = new SourceIngestionRepository(db);
        const source = sourceRepo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'api-canary-fixture', name: 'API canary fixture' });
        const itemId = sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId: 'api-canary-approved', rawText: 'Apartment for rent in Wat Bo $300/month. WhatsApp +85512345678',
          sourceUrl: 'https://facebook.com/groups/api-fixture/posts/canary', contentHash: 'api-canary-approved', classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: { title_en: 'Canary apartment in Wat Bo', description_en: 'Apartment for rent in Wat Bo, Siem Reap', price: 300, currency: 'USD', category: 'apartment', property_type: 'Apartment', bedrooms: 1, city: 'siem_reap', sangkat: 'Wat Bo', offer_type: 'rent', latitude: 13.36, longitude: 103.86 }, photos: [] },
        }).id;
        new CanonicalShadowService(db).run({ dryRun: false });
        const listing = db.prepare(`SELECT l.id,l.public_ref FROM canonical_listings l JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as { id: number; public_ref: string };
        db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];

        const headers = { 'X-Dev-Telegram-Id': String(canaryId) };
        const canaryList = await app.inject({ method: 'GET', url: '/api/v1/properties?query=Canary', headers });
        if (canaryList.statusCode !== 200) throw new Error(canaryList.body);
        expect(canaryList.statusCode).toBe(200);
        expect(canaryList.json().items.some((item: { publicRef: string }) => item.publicRef === listing.public_ref)).toBe(true);

        const map = await app.inject({ method: 'GET', url: '/api/v1/properties/map', headers });
        expect(map.json().markers.some((marker: { publicRef?: string }) => marker.publicRef === listing.public_ref)).toBe(true);

        const detail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}`, headers });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().publicRef).toBe(listing.public_ref);

        const toggle = await app.inject({ method: 'POST', url: '/api/v1/favorites/toggle', headers, payload: { publicRef: listing.public_ref } });
        expect(toggle.statusCode).toBe(200);
        const favorites = await app.inject({ method: 'GET', url: '/api/v1/favorites', headers });
        expect(favorites.json().items.some((item: { publicRef: string }) => item.publicRef === listing.public_ref)).toBe(true);

        db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(listing.id);
        const hiddenList = await app.inject({ method: 'GET', url: '/api/v1/properties?query=Canary', headers });
        expect(hiddenList.json().items.some((item: { publicRef: string }) => item.publicRef === listing.public_ref)).toBe(false);
        const hiddenMap = await app.inject({ method: 'GET', url: '/api/v1/properties/map', headers });
        expect(hiddenMap.json().markers.some((marker: { publicRef?: string }) => marker.publicRef === listing.public_ref)).toBe(false);
        const hiddenFavorite = await app.inject({ method: 'POST', url: '/api/v1/favorites/toggle', headers, payload: { publicRef: listing.public_ref } });
        expect(hiddenFavorite.statusCode).toBe(404);
        const tracking = container.trackedLinksRepo.createLink({ listingPublicRef: listing.public_ref });
        const hiddenTracking = await app.inject({ method: 'POST', url: `/api/v1/links/${tracking.slug}/opened`, headers });
        expect(hiddenTracking.statusCode).toBe(404);

        const nonCanaryList = await app.inject({ method: 'GET', url: '/api/v1/properties?query=Canary', headers: { 'X-Dev-Telegram-Id': '9988776655' } });
        expect(nonCanaryList.json().items.some((item: { publicRef?: string }) => item.publicRef === listing.public_ref)).toBe(false);
        const nonCanaryRefDetail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}`, headers: { 'X-Dev-Telegram-Id': '9988776655' } });
        expect(nonCanaryRefDetail.statusCode).toBe(404);
      } finally {
        env.LISTING_READ_PATH = priorPath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = priorCanaries;
      }
    });

    it('does not expose pending or rejected canonical listings by public reference', async () => {
      const priorReadPath = env.LISTING_READ_PATH;
      try {
        const sourceRepo = new SourceIngestionRepository(db);
        const source = sourceRepo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'api-moderation-fixture', name: 'API moderation fixture' });
        const itemId = sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId: 'api-moderation-pending', rawText: 'Apartment for rent in Wat Bo $300/month',
          sourceUrl: 'https://facebook.com/groups/api-fixture/posts/pending', contentHash: 'api-moderation-fixture', classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: { title_en: 'Test apartment in Wat Bo', description_en: 'For rent in Wat Bo', price: 300, currency: 'USD', category: 'apartment', property_type: 'Apartment', bedrooms: 1, city: 'siem_reap', sangkat: 'Wat Bo', offer_type: 'rent' }, photos: [] },
        }).id;
        new CanonicalShadowService(db).run({ dryRun: false });
        const listing = db.prepare(`SELECT l.id,l.public_ref FROM canonical_listings l JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as { id: number; public_ref: string };
        env.LISTING_READ_PATH = 'canonical';

        const pending = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}` });
        expect(pending.statusCode).toBe(404);
        db.prepare("UPDATE canonical_listing_moderation SET review_status='rejected' WHERE listing_id=?").run(listing.id);
        const rejected = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}` });
        expect(rejected.statusCode).toBe(404);
      } finally {
        env.LISTING_READ_PATH = priorReadPath;
      }
    });

    it('returns property detail by ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties/1',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(1);
      expect(body.location).toBe('Sala Kamreuk');
      expect(body.coordinates).toEqual({ lat: 13.3512, lng: 103.8645 });
    });

    it('returns 404 for non-existent property', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties/99999',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid ID format', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties/abc',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── 5. Map Markers Endpoint ──────────────────────────────────────────────────

  describe('GET /api/v1/properties/map', () => {
    it('returns lightweight map markers with coordinates', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties/map?city=siem_reap',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.city).toBe('siem_reap');
      expect(body.count).toBe(3);
      expect(body.markers[0]).toHaveProperty('coordinates');
      expect(body.markers[0]).toHaveProperty('priceUsd');
      expect(body.markers[0].isExact).toBe(true);
    });

    it('returns Sangkat cluster markers for non-GPS properties', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties/map?city=siem_reap',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.city).toBe('siem_reap');
      // Property 3 in Sla Kram has no maps_url / GPS coordinates, so it forms a Sangkat cluster
      expect(body.count).toBe(3);
      const cluster = body.markers.find((m: { isExact: boolean; location: string }) => !m.isExact && m.location === 'Sla Kram');
      expect(cluster).toBeDefined();
      expect(cluster.isExact).toBe(false);
      expect(cluster.count).toBe(1);
    });
  });

  // ─── 6. Filters Metadata Endpoint ─────────────────────────────────────────────

  describe('GET /api/v1/filters/metadata', () => {
    it('returns dynamic filter options for Siem Reap', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/filters/metadata?city=siem_reap',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.currentCity).toBe('siem_reap');
      expect(body.cities.length).toBe(1);
      expect(body.locations.some((l: { name: string }) => l.name === 'Sala Kamreuk')).toBe(true);
      expect(body.priceRange.minUsd).toBe(350);
      expect(body.priceRange.maxUsd).toBe(1200);
    });
  });

  // ─── 7. Favorites Endpoint (Authenticated) ────────────────────────────────────

  describe('Favorites Management (/api/v1/favorites)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/favorites',
      });

      expect(res.statusCode).toBe(401);
    });

    it('toggles favorite and retrieves saved list with dev auth', async () => {
      const devHeaders = { 'X-Dev-Telegram-Id': '1122334455' };

      // 1. Initially empty favorites
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/v1/favorites',
        headers: devHeaders,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().total).toBe(0);

      // 2. Add property #1 to favorites
      const toggleRes1 = await app.inject({
        method: 'POST',
        url: '/api/v1/favorites/toggle',
        headers: devHeaders,
        payload: { propertyId: 1 },
      });
      expect(toggleRes1.statusCode).toBe(200);
      expect(toggleRes1.json().isFavorite).toBe(true);
      expect(toggleRes1.json().totalFavorites).toBe(1);

      // 3. Verify property #1 is in list and has isFavorite = true
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/v1/favorites',
        headers: devHeaders,
      });
      expect(res2.json().total).toBe(1);
      expect(res2.json().items[0].id).toBe(1);
      expect(res2.json().items[0].isFavorite).toBe(true);

      // 4. Toggle property #1 off (remove)
      const toggleRes2 = await app.inject({
        method: 'POST',
        url: '/api/v1/favorites/toggle',
        headers: devHeaders,
        payload: { propertyId: 1 },
      });
      expect(toggleRes2.statusCode).toBe(200);
      expect(toggleRes2.json().isFavorite).toBe(false);
      expect(toggleRes2.json().totalFavorites).toBe(0);
    });
  });

  describe('Removed remote authentication surface', () => {
    it('does not expose the remote browser endpoint', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/remote-browser?token=test' });
      expect(response.statusCode).toBe(404);
    });
  });

  // ─── Admin review filters ────────────────────────────────────────────────────

  describe('Admin review-status filtering', () => {
    const ADMIN_TG_ID = 299321244;
    const NON_ADMIN_TG_ID = 111222333;

    beforeAll(() => {
      if (!env.ADMIN_IDS.includes(ADMIN_TG_ID)) {
        env.ADMIN_IDS.push(ADMIN_TG_ID);
      }

      container.propertiesRepo.insertProperty({
        hash: 'test_hash_pending_1',
        title: 'Uncertain Listing Awaiting Review',
        description: 'Possibly real estate, unclear from text.',
        price: 20000,
        currency: 'USD',
        type: 'rent',
        category: 'apartment',
        bedrooms: 1,
        bathrooms: 1,
        deposit: 20000,
        min_lease: 1,
        has_pool: null,
        location: 'Svay Dangkum',
        city: 'siem_reap',
        maps_url: null,
        source_url: 'https://khmer24.com/p-999',
        original_url: 'https://khmer24.com/p-999',
        photos: [],
        direct_contact: {},
        is_active: 0,
        review_status: 'pending',
      });
    });

    it('ignores review_status param for unauthenticated public requests', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?review_status=pending',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.items.every((i: { id: number }) => i.id)).toBe(true);
      expect(body.items.some((i: { title: string }) => i.title === 'Uncertain Listing Awaiting Review')).toBe(false);
    });

    it('ignores review_status param for authenticated non-admin users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?review_status=pending',
        headers: { 'x-dev-telegram-id': String(NON_ADMIN_TG_ID) },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.some((i: { title: string }) => i.title === 'Uncertain Listing Awaiting Review')).toBe(false);
    });

    it('returns pending listings to admins via review_status=pending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?review_status=pending',
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].title).toBe('Uncertain Listing Awaiting Review');
      expect(body.items[0].reviewStatus).toBe('pending');
    });

    it('returns all listings including inactive via review_status=all for admins', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?review_status=all',
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(4);
    });
  });

  describe('POST /api/v1/properties/:id/review', () => {
    const ADMIN_TG_ID = 299321244;
    let pendingId: number;

    it('rejects unauthenticated requests with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/properties/1/review',
        payload: { action: 'approve' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects authenticated non-admin users with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/properties/1/review',
        headers: { 'x-dev-telegram-id': '111222333' },
        payload: { action: 'approve' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('approves a pending listing as admin and idempotently rejects a second action', async () => {
      const pending = container.propertiesRepo.searchProperties({ reviewStatus: 'pending' } as never);
      pendingId = pending.items[0]?.id;
      expect(pendingId).toBeGreaterThan(0);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/properties/${pendingId}/review`,
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
        payload: { action: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.property.reviewStatus).toBe('approved');

      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/properties/${pendingId}/review`,
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
        payload: { action: 'reject' },
      });
      expect(again.statusCode).toBe(409);
    });
  });

  describe('GET /api/v1/me', () => {
    it('reports isAdmin=false for anonymous requests', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.authenticated).toBe(false);
      expect(body.isAdmin).toBe(false);
    });

    it('reports isAdmin=true for a configured admin Telegram ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { 'x-dev-telegram-id': '299321244' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.authenticated).toBe(true);
      expect(body.isAdmin).toBe(true);
    });
  });
});
