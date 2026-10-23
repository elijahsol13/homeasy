import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { validateTelegramInitData } from '../src/modules/api/auth';
import { env } from '../src/config/env';
import { buildApiServer } from '../src/modules/api/server';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';
import { TrackingLinkService } from '../src/services/tracking.service';
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
  const originalListingReadPath = env.LISTING_READ_PATH;

  beforeAll(async () => {
    // Legacy fixtures must not inherit the developer's canonical rollout settings.
    env.LISTING_READ_PATH = 'legacy';
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
    env.LISTING_READ_PATH = originalListingReadPath;
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

  describe('Tracked Mini App listing identity', () => {
    it('resolves canonical references and explicit legacy aliases without confusing numeric IDs', async () => {
      const previousPath = env.LISTING_READ_PATH;
      const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      try {
        const sourceRepo = new SourceIngestionRepository(db);
        const source = sourceRepo.upsertSource({
          sourceType: 'FACEBOOK_GROUP', externalSourceId: 'tracked-listing-regression', name: 'Tracked listing regression',
        });
        const sourceItem = sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId: 'tracked-property-unique',
          rawText: 'Distinctive tracked villa for rent in Siem Reap $1377/month, three bedrooms',
          sourceUrl: 'https://facebook.com/groups/tracked-listing-regression/posts/unique',
          contentHash: 'tracked-listing-unique', classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: {
            title_en: 'Unique tracking regression villa', description_en: 'Distinctive 3BR villa',
            price: 1377, currency: 'USD', category: 'house', bedrooms: 3,
            city: 'siem_reap', sangkat: 'Svay Dangkum', offer_type: 'rent',
          }, photos: [] },
        }).id;
        new CanonicalShadowService(db).run({ dryRun: false });
        const listing = db.prepare(`SELECT l.id, l.public_ref FROM canonical_listings l
          JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(sourceItem) as { id: number; public_ref: string };
        expect(listing).toBeDefined();
        db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);

        const service = new TrackingLinkService(container);
        const canonicalLink = service.createLink({ listingPublicRef: listing.public_ref }).link;
        // Canonical link storage contains a numeric canonical ID as attribution metadata;
        // this must never be used as a numeric legacy property ID.
        expect(canonicalLink.listing_id).toBe(listing.id);
        const opened = (slug: string, headers?: Record<string, string>) => app.inject({
          method: 'POST', url: `/api/v1/links/${slug}/opened`, headers,
        });

        env.LISTING_READ_PATH = 'canonical';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
        const canonicalOpened = await opened(canonicalLink.slug);
        expect(canonicalOpened.statusCode).toBe(200);
        expect(canonicalOpened.json()).toMatchObject({
          listingTarget: listing.public_ref,
          attribution: { listing_id: listing.id, listing_public_ref: listing.public_ref },
        });
        // Old bookmarked deep links must resolve to the approved survivor after
        // a duplicate merge, returning its canonical public reference.
        const formerRef = `lst_${'a'.repeat(32)}`;
        container.listingIdentityRepo.register('public_listing_ref', formerRef, listing.id);
        const formerDetail = await app.inject({ method: 'GET', url: `/api/v1/properties/${formerRef}` });
        expect(formerDetail.statusCode).toBe(200);
        expect(formerDetail.json().publicRef).toBe(listing.public_ref);
        // Legacy tracking IDs are only looked up through the explicit legacy alias namespace.
        container.listingIdentityRepo.register('legacy_property_id', 800003, listing.id);
        const oldAliasLink = container.trackedLinksRepo.createLink({ listingId: 800003 });
        expect((await opened(oldAliasLink.slug)).json().listingTarget).toBe(listing.public_ref);

        db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(listing.id);
        expect((await opened(canonicalLink.slug)).statusCode).toBe(404);
        expect((await opened(oldAliasLink.slug)).statusCode).toBe(404);
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [5550099];
        expect((await opened(canonicalLink.slug, { 'x-dev-telegram-id': '5550099' })).statusCode).toBe(404);

        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
        const legacyLink = container.trackedLinksRepo.createLink({ listingId: 1 });
        const legacyOpened = await opened(legacyLink.slug);
        expect(legacyOpened.statusCode).toBe(200);
        expect(legacyOpened.json().listingTarget).toBe(1);
        expect((await opened(canonicalLink.slug)).json().listingTarget).toBeNull();
      } finally {
        env.LISTING_READ_PATH = previousPath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
      }
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
        const addMapFixture = (externalId: string, price: number, lat?: number, lng?: number) => sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId,
          rawText: `Distinct apartment ${externalId} for rent in Sala Kamreuk, Siem Reap $${price}/month`,
          sourceUrl: `https://facebook.com/groups/api-fixture/posts/${externalId}`,
          contentHash: externalId, classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: {
            title_en: `Distinct apartment ${externalId}`, description_en: 'For rent in Sala Kamreuk, Siem Reap',
            price, currency: 'USD', category: 'apartment', bedrooms: 1, city: 'siem_reap', sangkat: 'Sala Kamreuk',
            offer_type: 'rent', ...(lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : {}),
          }, photos: [] },
        }).id;
        const outsideId = addMapFixture('api-map-newest-outside', 499, 13.39, 103.80);
        const areaA = addMapFixture('api-map-area-a', 240);
        const areaB = addMapFixture('api-map-area-b', 260);
        new CanonicalShadowService(db).run({ dryRun: false });
        const listing = db.prepare(`SELECT l.id,l.public_ref FROM canonical_listings l JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as { id: number; public_ref: string };
        db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);
        const mapFixtureIds = [outsideId, areaA, areaB].map((sourceItemId) => (db.prepare(`SELECT l.id FROM canonical_listings l
          JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(sourceItemId) as { id: number }).id);
        for (const id of mapFixtureIds) db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(id);
        db.prepare("UPDATE canonical_listing_source_occurrences SET posted_at='2026-10-16' WHERE listing_id=?").run(mapFixtureIds[0]);
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];

        const headers = { 'X-Dev-Telegram-Id': String(canaryId) };
        const canaryList = await app.inject({ method: 'GET', url: '/api/v1/properties?query=Canary', headers });
        if (canaryList.statusCode !== 200) throw new Error(canaryList.body);
        expect(canaryList.statusCode).toBe(200);
        expect(canaryList.json().items.some((item: { publicRef: string }) => item.publicRef === listing.public_ref)).toBe(true);

        const map = await app.inject({ method: 'GET', url: '/api/v1/properties/map', headers });
        const marker = map.json().markers.find((item: { publicRef?: string }) => item.publicRef === listing.public_ref);
        expect(marker).toBeDefined();
        expect(marker.isExact).toBe(true);
        expect(marker.coordinates).toEqual({ lat: 13.36, lng: 103.86 });

        // The newest exact candidate is outside this tiny viewport. Applying
        // LIMIT first would hide the older in-bounds pin, and cap area counts.
        const boundedMap = await app.inject({ method: 'GET',
          url: '/api/v1/properties/map?limit=1&minLat=13.355&maxLat=13.365&minLng=103.855&maxLng=103.865&paddingRatio=0', headers });
        expect(boundedMap.statusCode).toBe(200);
        const boundedMarkers = boundedMap.json().markers as Array<{
          publicRef?: string; isExact: boolean; location: string; count?: number;
        }>;
        expect(boundedMarkers.filter((m) => m.isExact).map((m) => m.publicRef)).toEqual([listing.public_ref]);
        expect(boundedMarkers.find((m) => !m.isExact && m.location === 'Sala Kamreuk')?.count).toBe(2);
        const cappedMap = await app.inject({ method: 'GET', url: '/api/v1/properties/map?limit=1', headers });
        const cappedMarkers = cappedMap.json().markers as typeof boundedMarkers;
        expect(cappedMarkers.filter((m) => m.isExact)).toHaveLength(1);
        expect(cappedMarkers.find((m) => !m.isExact && m.location === 'Sala Kamreuk')?.count).toBe(2);

        // T24: cluster drilldown must use the exact map cohort. An exact GPS
        // listing in the same district is a different marker, not a member.
        const clusterKey = (boundedMap.json().markers as Array<{ isExact: boolean; location: string; locationKey: string | null }>)
          .find((m) => !m.isExact && m.location === 'Sala Kamreuk')?.locationKey;
        expect(clusterKey).toBeTruthy();
        const clusterUrl = `/api/v1/properties?map_cluster_key=${encodeURIComponent(clusterKey!)}&limit=1`;
        const firstClusterPage = await app.inject({ method: 'GET', url: clusterUrl, headers });
        const secondClusterPage = await app.inject({ method: 'GET', url: `${clusterUrl}&page=2`, headers });
        expect(firstClusterPage.statusCode).toBe(200);
        expect(firstClusterPage.json()).toMatchObject({ total: 2, totalPages: 2 });
        expect(secondClusterPage.json()).toMatchObject({ total: 2, page: 2 });
        const memberIds = [firstClusterPage, secondClusterPage].map((response) => response.json().items[0].id);
        expect(new Set(memberIds)).toEqual(new Set(mapFixtureIds.slice(1)));
        expect(memberIds).not.toContain(mapFixtureIds[0]);

        const stalePriceFilter = await app.inject({ method: 'GET', url: `${clusterUrl}&min_price=800&max_price=250`, headers });
        expect(stalePriceFilter.json().total).toBe(0);
        expect((await app.inject({ method: 'GET', url: '/api/v1/properties?map_cluster_key=invalid!', headers })).statusCode).toBe(400);
        expect((await app.inject({ method: 'GET', url: '/api/v1/properties?map_cluster_key=siem_reap:missing', headers })).json().total).toBe(0);

        db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(mapFixtureIds[2]);
        try {
          const moderatedMap = await app.inject({ method: 'GET', url: '/api/v1/properties/map', headers });
          expect(moderatedMap.json().markers.find((m: { isExact: boolean; locationKey: string }) => !m.isExact && m.locationKey === clusterKey)?.count).toBe(1);
          expect((await app.inject({ method: 'GET', url: clusterUrl, headers })).json().total).toBe(1);
        } finally {
          db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(mapFixtureIds[2]);
        }

        const detail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}`, headers });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().publicRef).toBe(listing.public_ref);
        expect(detail.json().coordinates).toEqual({ lat: 13.36, lng: 103.86 });

        // Bad source GPS must never become an exact pin, even when present in facts.
        const originalFacts = (db.prepare('SELECT listing_facts_json AS facts FROM canonical_listings WHERE id=?')
          .get(listing.id) as { facts: string }).facts;
        const invalidFacts = { ...JSON.parse(originalFacts) as Record<string, unknown>, latitude: 13.1, longitude: 103.8 };
        db.prepare('UPDATE canonical_listings SET listing_facts_json=? WHERE id=?')
          .run(JSON.stringify(invalidFacts), listing.id);
        try {
          const invalidDetail = await app.inject({ method: 'GET', url: `/api/v1/properties/${listing.public_ref}`, headers });
          expect(invalidDetail.json().coordinates).toBeNull();
          const invalidMap = await app.inject({ method: 'GET', url: '/api/v1/properties/map', headers });
          expect(invalidMap.json().markers.some((item: { publicRef?: string; isExact: boolean }) =>
            item.publicRef === listing.public_ref && item.isExact)).toBe(false);
        } finally {
          db.prepare('UPDATE canonical_listings SET listing_facts_json=? WHERE id=?').run(originalFacts, listing.id);
        }

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

    it('preserves legacy favorites and tracked links through canary toggles and moderation visibility', async () => {
      const previousPath = env.LISTING_READ_PATH;
      const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      const fixtureDb = new DatabaseSync(':memory:');
      let fixtureApp: FastifyInstance | undefined;
      try {
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
        runMigrations(fixtureDb);
        const fixture = createContainer({ db: fixtureDb });
        const legacyId = Number(fixtureDb.prepare(`INSERT INTO properties
          (hash,title,price,type,location,city,is_active) VALUES (?,?,?,?,?,?,1)`).run(
          'rollback-legacy-one', 'Rollback legacy apartment', 25000, 'rent', 'Wat Bo', 'siem_reap',
        ).lastInsertRowid);
        const sourceRepo = new SourceIngestionRepository(fixtureDb);
        const source = sourceRepo.upsertSource({
          sourceType: 'FACEBOOK_GROUP', externalSourceId: 'rollback-api-fixture', name: 'Rollback API fixture',
        });
        const sourceItemId = sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId: 'rollback-api-listing',
          rawText: 'Rollback canary apartment for rent in Wat Bo, Siem Reap $250/month',
          sourceUrl: 'https://facebook.com/groups/rollback-api-fixture/posts/1',
          contentHash: 'rollback-api-listing', classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: {
            title_en: 'Rollback canary apartment', description_en: 'Apartment for rent in Wat Bo',
            price: 250, currency: 'USD', category: 'apartment', bedrooms: 1,
            city: 'siem_reap', sangkat: 'Wat Bo', offer_type: 'rent',
          }, photos: [] },
        }).id;
        new CanonicalShadowService(fixtureDb).run({ dryRun: false });
        const listing = fixtureDb.prepare(`SELECT l.id,l.public_ref FROM canonical_listings l
          JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(sourceItemId) as { id: number; public_ref: string };
        expect(listing).toBeDefined();
        fixtureDb.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);
        fixture.listingIdentityRepo.register('legacy_property_id', legacyId, listing.id);
        const legacyLink = fixture.trackedLinksRepo.createLink({ listingId: legacyId });
        const canonicalLink = fixture.trackedLinksRepo.createLink({ listingPublicRef: listing.public_ref });

        fixtureApp = await buildApiServer({ container: fixture, logger: false });
        await fixtureApp.ready();
        const canaryId = 445566778;
        const headers = { 'X-Dev-Telegram-Id': String(canaryId) };
        const get = (url: string) => fixtureApp!.inject({ method: 'GET', url, headers });
        const opened = (slug: string) => fixtureApp!.inject({ method: 'POST', url: `/api/v1/links/${slug}/opened`, headers });
        const toggle = (payload: Record<string, string | number>) => fixtureApp!.inject({
          method: 'POST', url: '/api/v1/favorites/toggle', headers, payload,
        });

        expect((await toggle({ propertyId: legacyId })).json().isFavorite).toBe(true);
        expect((await get('/api/v1/favorites')).json().items.map((item: { id: number }) => item.id)).toEqual([legacyId]);
        expect((await opened(legacyLink.slug)).json().listingTarget).toBe(legacyId);

        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];
        expect((await get('/api/v1/favorites')).json().items.map((item: { publicRef: string }) => item.publicRef))
          .toEqual([listing.public_ref]);
        expect((await get(`/api/v1/properties/${listing.public_ref}`)).json().isFavorite).toBe(true);
        expect((await opened(legacyLink.slug)).json().listingTarget).toBe(listing.public_ref);
        expect((await opened(canonicalLink.slug)).json().listingTarget).toBe(listing.public_ref);

        expect((await toggle({ publicRef: listing.public_ref })).json().isFavorite).toBe(false);
        expect((await get('/api/v1/favorites')).json().total).toBe(0);
        expect((await get(`/api/v1/properties/${listing.public_ref}`)).json().isFavorite).toBe(false);

        // A canary unsave only changes its canonical view; legacy rollback is intact.
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
        expect((await get('/api/v1/favorites')).json().items.map((item: { id: number }) => item.id)).toEqual([legacyId]);
        expect((await opened(legacyLink.slug)).json().listingTarget).toBe(legacyId);
        expect((await opened(canonicalLink.slug)).json().listingTarget).toBeNull();

        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];
        expect((await toggle({ publicRef: listing.public_ref })).json().isFavorite).toBe(true);
        fixtureDb.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(listing.id);
        expect((await get('/api/v1/favorites')).json().total).toBe(0);
        expect((await get(`/api/v1/properties/${listing.public_ref}`)).statusCode).toBe(404);
        expect((await opened(legacyLink.slug)).statusCode).toBe(404);
        expect((await opened(canonicalLink.slug)).statusCode).toBe(404);

        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
        expect((await get('/api/v1/favorites')).json().items.map((item: { id: number }) => item.id)).toEqual([legacyId]);
        expect((await opened(legacyLink.slug)).json().listingTarget).toBe(legacyId);
        fixtureDb.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];
        expect((await get('/api/v1/favorites')).json().items.map((item: { publicRef: string }) => item.publicRef))
          .toEqual([listing.public_ref]);
      } finally {
        env.LISTING_READ_PATH = previousPath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
        if (fixtureApp) await fixtureApp.close();
        fixtureDb.close();
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

    it('serves complete canonical metadata beyond 500 cards only to the allowlisted cohort', async () => {
      const previousPath = env.LISTING_READ_PATH;
      const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      const canaryId = 99117733;
      const path = '/api/v1/filters/metadata?city=siem_reap';
      db.exec('SAVEPOINT canonical_metadata_api_fixture');
      try {
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryId];
        const baseline = container.canonicalListingRepo.getMetadata('siem_reap');
        const sourceId = new SourceIngestionRepository(db).upsertSource({
          sourceType: 'FACEBOOK_GROUP', externalSourceId: 'metadata-overflow-fixture', name: 'Metadata overflow fixture',
        });
        const insertSource = db.prepare(`INSERT INTO source_items
          (id,source_registry_id,source_type,external_id,raw_text,raw_payload_json,classification)
          VALUES (?,?,'FACEBOOK_GROUP',?,'For rent in Siem Reap','{}','HOUSING_SUPPLY')`);
        const insertListing = db.prepare(`INSERT INTO canonical_listings
          (id,public_ref,status,availability_status,price,currency,title,category,city,sangkat,explicit_location,first_seen_at,last_seen_at,primary_source_occurrence_id,listing_facts_json)
          VALUES (? ,?,'active','available',?,'USD','Metadata fixture',?,'siem_reap',?,?,'2020-01-01',?,?,'{"offer_type":"rent"}')`);
        const insertOccurrence = db.prepare(`INSERT INTO canonical_listing_source_occurrences
          (id,source_item_id,listing_id,source_registry_id,first_seen_at,last_seen_at,is_current)
          VALUES (?,?,?,?,'2020-01-01',?,1)`);
        const approve = db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES (?,'approved')");
        for (let index = 0; index < 502; index += 1) {
          const id = 800000 + index;
          const isHouse = index === 500;
          const isRoom = index === 501;
          const cityOnly = index === 499;
          const seenAt = isHouse || isRoom ? '2020-01-01' : '2026-10-15';
          insertSource.run(id, sourceId, `metadata-overflow-${index}`);
          insertListing.run(id, `lst_${String(id).padStart(32, '0')}`,
            isHouse ? 5000 : isRoom ? 990000 : 30000,
            isHouse ? 'house' : isRoom ? 'room' : 'apartment',
            isHouse ? '  Wat Bo  ' : isRoom ? '  Old Market  ' : cityOnly ? '  ' : 'Sala Kamreuk',
            '  ', seenAt, id);
          insertOccurrence.run(id, id, id, sourceId, seenAt);
          approve.run(id);
        }
        const cardPage = container.canonicalListingRepo.searchProperties({ city: 'siem_reap', type: 'rent', limit: 500 });
        expect(cardPage.items).toHaveLength(500);
        expect(cardPage.items.map((property) => property.id)).not.toContain(800500);
        expect(cardPage.items.map((property) => property.id)).not.toContain(800501);

        const canonicalResponse = await app.inject({ method: 'GET', url: path, headers: { 'X-Dev-Telegram-Id': String(canaryId) } });
        expect(canonicalResponse.statusCode).toBe(200);
        const body = canonicalResponse.json();
        const categoryCounts = Object.fromEntries(body.categories.map((entry: { id: string; count: number }) => [entry.id, entry.count]));
        const locationCounts = Object.fromEntries(body.locations.map((entry: { name: string; count: number }) => [entry.name, entry.count]));
        const baselineCategory = (category: string) => baseline.categories.find((entry) => entry.category === category)?.count ?? 0;
        const baselineLocation = (location: string) => baseline.locations.find((entry) => entry.location === location)?.count ?? 0;
        expect(categoryCounts.apartment).toBe(baselineCategory('apartment') + 500);
        expect(categoryCounts.house).toBe(baselineCategory('house') + 1);
        expect(categoryCounts.room).toBe(baselineCategory('room') + 1);
        expect(locationCounts['Sala Kamreuk']).toBe(baselineLocation('Sala Kamreuk') + 499);
        expect(locationCounts['Sla Kram'] ?? 0).toBe(baselineLocation('Sla Kram'));
        expect(locationCounts.siem_reap).toBeUndefined();
        expect(locationCounts['Wat Bo']).toBeUndefined();
        expect(locationCounts['Old Market']).toBeUndefined();
        expect(body.priceRange).toEqual({ minUsd: 50, maxUsd: 9900 });

        const cityFiltered = await app.inject({ method: 'GET', url: '/api/v1/properties?locations=siem_reap&limit=50', headers: { 'X-Dev-Telegram-Id': String(canaryId) } });
        expect(cityFiltered.statusCode).toBe(200);
        expect(cityFiltered.json().items.some((item: { publicRef?: string }) =>
          item.publicRef === `lst_${String(800499).padStart(32, '0')}`)).toBe(true);

        const legacyResponse = await app.inject({ method: 'GET', url: path });
        expect(legacyResponse.statusCode).toBe(200);
        expect(legacyResponse.json().priceRange).toEqual({ minUsd: 350, maxUsd: 1200 });
      } finally {
        env.LISTING_READ_PATH = previousPath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
        db.exec('ROLLBACK TO canonical_metadata_api_fixture');
        db.exec('RELEASE canonical_metadata_api_fixture');
      }
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
      const fullPhotos = Array.from({ length: 11 }, (_, i) => `https://example.com/legacy-${i}.jpg`);
      db.prepare('UPDATE properties SET photos=? WHERE id=?').run(JSON.stringify(fullPhotos), pendingId);

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
      expect(body.property.photos).toEqual(fullPhotos);

      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/properties/${pendingId}/review`,
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
        payload: { action: 'reject' },
      });
      expect(again.statusCode).toBe(409);
    });

    it('lets an allowlisted admin review canonical listings while the global path is legacy', async () => {
      const previousPath = env.LISTING_READ_PATH;
      const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      const fullPhotos = Array.from({ length: 11 }, (_, i) => `https://example.com/canonical-${i}.jpg`);
      try {
        const sourceRepo = new SourceIngestionRepository(db);
        const source = sourceRepo.upsertSource({
          sourceType: 'FACEBOOK_GROUP', externalSourceId: 'api-admin-canary-review', name: 'API admin canary review',
        });
        const itemId = sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId: 'api-admin-canary-review-1',
          rawText: 'Admin canary review apartment for rent in Siem Reap, Wat Bo, $325/month',
          sourceUrl: 'https://facebook.com/groups/api-admin-canary-review/posts/1',
          contentHash: 'api-admin-canary-review-1', classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: {
            title_en: 'Admin canary review apartment in Wat Bo', description_en: 'Apartment for rent in Siem Reap',
            price: 325, currency: 'USD', category: 'apartment', bedrooms: 1, city: 'siem_reap',
            sangkat: 'Wat Bo', offer_type: 'rent',
          }, photos: fullPhotos },
        }).id;
        new CanonicalShadowService(db).run({ dryRun: false });
        const listing = db.prepare(`SELECT l.id, l.public_ref FROM canonical_listings l
          JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as { id: number; public_ref: string };
        expect(listing).toBeDefined();
        db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(listing.id);
        const rejectedSourceItemId = sourceRepo.upsertSourceItemDetailed(source, {
          sourceType: 'FACEBOOK_GROUP', externalId: 'api-admin-canary-review-2',
          rawText: 'Admin canary review house for rent in Siem Reap, Wat Bo, $800/month',
          sourceUrl: 'https://facebook.com/groups/api-admin-canary-review/posts/2',
          contentHash: 'api-admin-canary-review-2', classification: 'HOUSING_SUPPLY',
          rawPayload: { listingExtraction: {
            title_en: 'Admin canary review house in Wat Bo', description_en: 'House for rent in Siem Reap',
            price: 800, currency: 'USD', category: 'house', bedrooms: 3, city: 'siem_reap',
            sangkat: 'Wat Bo', offer_type: 'rent',
          }, photos: [] },
        }).id;
        new CanonicalShadowService(db).run({ dryRun: false });
        const toReject = db.prepare(`SELECT l.id, l.public_ref FROM canonical_listings l
          JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
          WHERE o.source_item_id=? AND o.is_current=1`).get(rejectedSourceItemId) as { id: number; public_ref: string };
        expect(toReject).toBeDefined();
        expect(toReject.id).not.toBe(listing.id);
        db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(toReject.id);
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [ADMIN_TG_ID];

        const adminHeaders = { 'x-dev-telegram-id': String(ADMIN_TG_ID) };
        const publicList = await app.inject({ method: 'GET', url: '/api/v1/properties?query=Admin%20canary%20review' });
        expect(publicList.json().items.some((item: { publicRef?: string }) => item.publicRef === listing.public_ref)).toBe(false);
        const reviewQueue = await app.inject({
          method: 'GET', url: '/api/v1/properties?review_status=pending&query=Admin%20canary%20review', headers: adminHeaders,
        });
        expect(reviewQueue.statusCode).toBe(200);
        expect(reviewQueue.json().items).toEqual(expect.arrayContaining([
          expect.objectContaining({ publicRef: listing.public_ref, reviewStatus: 'pending' }),
          expect.objectContaining({ publicRef: toReject.public_ref, reviewStatus: 'pending' }),
        ]));
        const adminDetail = await app.inject({
          method: 'GET', url: `/api/v1/properties/${listing.public_ref}`, headers: adminHeaders,
        });
        expect(adminDetail.statusCode).toBe(200);
        expect([...adminDetail.json().photos].sort()).toEqual([...fullPhotos].sort());

        // A canonical numeric ID must never be interpreted as a legacy alias.
        const numericReview = await app.inject({
          method: 'POST', url: `/api/v1/properties/${listing.id}/review`, headers: adminHeaders,
          payload: { action: 'approve' },
        });
        expect(numericReview.statusCode).toBe(400);
        expect((db.prepare('SELECT review_status FROM canonical_listing_moderation WHERE listing_id=?')
          .get(listing.id) as { review_status: string }).review_status).toBe('pending');

        const approved = await app.inject({
          method: 'POST', url: `/api/v1/properties/${listing.public_ref}/review`, headers: adminHeaders,
          payload: { action: 'approve' },
        });
        expect(approved.statusCode).toBe(200);
        expect(approved.json()).toMatchObject({ publicRef: listing.public_ref, reviewStatus: 'approved' });
        expect([...approved.json().property.photos].sort()).toEqual([...fullPhotos].sort());
        const reviewRow = () => db.prepare('SELECT review_status,decision_origin FROM canonical_listing_moderation WHERE listing_id=?')
          .get(listing.id);
        expect(reviewRow()).toMatchObject({ review_status: 'approved', decision_origin: 'EXPLICIT_CANONICAL' });
        const visible = await app.inject({
          method: 'GET', url: '/api/v1/properties?query=Admin%20canary%20review', headers: adminHeaders,
        });
        expect(visible.json().items.some((item: { publicRef: string }) => item.publicRef === listing.public_ref)).toBe(true);

        const rejected = await app.inject({
          method: 'POST', url: `/api/v1/properties/${listing.public_ref}/review`, headers: adminHeaders,
          payload: { action: 'reject' },
        });
        expect(rejected.statusCode).toBe(409);
        expect(reviewRow()).toMatchObject({ review_status: 'approved', decision_origin: 'EXPLICIT_CANONICAL' });
        // The second listing went offline while awaiting moderation: it
        // cannot be approved, but an admin may still reject/close the queue.
        db.prepare("UPDATE canonical_listings SET status='inactive',availability_status='removed' WHERE id=?")
          .run(toReject.id);
        const unavailableApproval = await app.inject({
          method: 'POST', url: `/api/v1/properties/${toReject.public_ref}/review`, headers: adminHeaders,
          payload: { action: 'approve' },
        });
        expect(unavailableApproval.statusCode).toBe(409);
        expect(db.prepare('SELECT review_status FROM canonical_listing_moderation WHERE listing_id=?')
          .get(toReject.id)).toMatchObject({ review_status: 'pending' });
        const rejectedPending = await app.inject({
          method: 'POST', url: `/api/v1/properties/${toReject.public_ref}/review`, headers: adminHeaders,
          payload: { action: 'reject' },
        });
        expect(rejectedPending.statusCode).toBe(200);
        expect(db.prepare('SELECT review_status,decision_origin FROM canonical_listing_moderation WHERE listing_id=?')
          .get(toReject.id)).toMatchObject({ review_status: 'rejected', decision_origin: 'EXPLICIT_CANONICAL' });
        const hidden = await app.inject({
          method: 'GET', url: '/api/v1/properties?query=Admin%20canary%20review', headers: adminHeaders,
        });
        expect(hidden.json().items.some((item: { publicRef: string }) => item.publicRef === listing.public_ref)).toBe(true);
        expect(hidden.json().items.some((item: { publicRef: string }) => item.publicRef === toReject.public_ref)).toBe(false);

        // Admin queues must retain rejected/inactive inventory for review,
        // while neither its list nor detail becomes available to the public.
        const allQueue = await app.inject({
          method: 'GET', url: '/api/v1/properties?review_status=all&query=Admin%20canary%20review', headers: adminHeaders,
        });
        expect(allQueue.json().items).toEqual(expect.arrayContaining([
          expect.objectContaining({ publicRef: toReject.public_ref, reviewStatus: 'rejected' }),
        ]));
        const adminInactiveDetail = await app.inject({
          method: 'GET', url: `/api/v1/properties/${toReject.public_ref}`, headers: adminHeaders,
        });
        expect(adminInactiveDetail.statusCode).toBe(200);
        const publicInactiveDetail = await app.inject({
          method: 'GET', url: `/api/v1/properties/${toReject.public_ref}`,
        });
        expect(publicInactiveDetail.statusCode).toBe(404);
      } finally {
        env.LISTING_READ_PATH = previousPath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
      }
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
