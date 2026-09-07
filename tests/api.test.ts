import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { validateTelegramInitData } from '../src/modules/api/auth';
import { buildApiServer } from '../src/modules/api/server';
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
  const testBotToken = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_TEST';

  beforeAll(async () => {
    // In-memory database for isolated, lightning-fast testing
    db = new DatabaseSync(':memory:');
    runMigrations(db);

    const container = createContainer({ db });

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
      title: 'Studio Room in BKK1 Phnom Penh',
      description: 'Affordable studio near Aeon 1.',
      price: 25000, // $250
      currency: 'USD',
      type: 'rent',
      category: 'room',
      bedrooms: 0,
      bathrooms: 1,
      deposit: 25000,
      min_lease: 1,
      has_pool: false,
      location: 'BKK1',
      city: 'phnom_penh',
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

    it('filters properties by city', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties?city=phnom_penh',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.items[0].city).toBe('phnom_penh');
      expect(body.items[0].location).toBe('BKK1');
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
      expect(body.items[0].priceUsd).toBe(250);
      expect(body.items[1].priceUsd).toBe(350);
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
      expect(body.count).toBe(2);
      expect(body.markers[0]).toHaveProperty('coordinates');
      expect(body.markers[0]).toHaveProperty('priceUsd');
      expect(body.markers[0].isExact).toBe(true);
    });

    it('returns Sangkat cluster markers for non-GPS properties', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/properties/map?city=phnom_penh',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.city).toBe('phnom_penh');
      // Property 3 in BKK1 has no maps_url / GPS coordinates, so it forms a Sangkat cluster
      expect(body.count).toBe(1);
      expect(body.markers[0].isExact).toBe(false);
      expect(body.markers[0].count).toBe(1);
      expect(body.markers[0].location).toBe('BKK1');
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
      expect(body.cities.length).toBeGreaterThanOrEqual(2);
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

  // ─── 8. Tiered Rate Limiting ──────────────────────────────────────────────────

  describe('Tiered Rate Limiting Protection', () => {
    it('enforces heavy route rate limit (max 5 req/min on /admin/remote-browser)', async () => {
      // Perform 5 requests (allowed)
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/admin/remote-browser?token=invalid_test_token',
        });
        // 401 or 400 is expected for invalid token, but not 429 yet
        expect(res.statusCode).not.toBe(429);
      }

      // 6th request must be rejected with 429 Too Many Requests
      const blockedRes = await app.inject({
        method: 'GET',
        url: '/admin/remote-browser?token=invalid_test_token',
      });
      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.json()).toHaveProperty('error', 'Too Many Requests');
      expect(blockedRes.json().message).toContain('Too many remote browser connection attempts');
    });
  });
});
