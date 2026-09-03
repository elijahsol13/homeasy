import { computeHammingDistance } from '../src/modules/parser/phash';
import { normalizePhoneNumber, formatPhoneNumber } from '../src/modules/parser/normalizer';
import { parseCustomBudgetInput } from '../src/modules/bot/handlers/filters.handler';
import { createContainer, type AppContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';

describe('Ingestion & Deduplication Engine', () => {
  let container: AppContainer;

  beforeAll(() => {
    container = createContainer({ dbPath: ':memory:' });
    runMigrations(container.db);
  });

  describe('Hamming Distance Calculation', () => {
    test('identical hashes return distance 0', () => {
      const h1 = '1100110011001100110011001100110011001100110011001100110011001100';
      const h2 = '1100110011001100110011001100110011001100110011001100110011001100';
      expect(computeHammingDistance(h1, h2)).toBe(0);
    });

    test('hashes with 2 bit differences return distance 2', () => {
      const h1 = '1100110011001100110011001100110011001100110011001100110011001100';
      const h2 = '1100110011001100110011001100110011001100110011001100110011001111';
      expect(computeHammingDistance(h1, h2)).toBe(2);
    });

    test('null or invalid length hashes return Infinity', () => {
      expect(computeHammingDistance(null, '1100')).toBe(Infinity);
      expect(computeHammingDistance('11', '1100')).toBe(Infinity);
    });
  });

  describe('Cambodian Phone Number Normalization & Formatting', () => {
    test('normalizes +855 format', () => {
      expect(normalizePhoneNumber('+855 12 345 678')).toBe('85512345678');
      expect(normalizePhoneNumber('+85512345678')).toBe('85512345678');
    });

    test('normalizes local 0-prefix format', () => {
      expect(normalizePhoneNumber('012-345-678')).toBe('85512345678');
      expect(normalizePhoneNumber('012 345 678')).toBe('85512345678');
    });

    test('handles invalid phone numbers gracefully', () => {
      expect(normalizePhoneNumber(undefined)).toBeNull();
      expect(normalizePhoneNumber('123')).toBeNull();
    });

    test('formats phone into clean Cambodian international mask', () => {
      expect(formatPhoneNumber('85512345678')).toBe('+855 12 345 678');
      expect(formatPhoneNumber('012-345-678')).toBe('+855 12 345 678');
      expect(formatPhoneNumber('+855 96 934 3456')).toBe('+855 96 934 3456');
    });

    test('formats multiple phone numbers in one string', () => {
      expect(formatPhoneNumber('012345678 / 0969343456')).toBe('+855 12 345 678 / +855 96 934 3456');
    });
  });

  describe('Custom Budget Input Parsing', () => {
    test('parses range formats', () => {
      expect(parseCustomBudgetInput('150-300')).toEqual({ min: 150, max: 300 });
      expect(parseCustomBudgetInput('$150 - $300')).toEqual({ min: 150, max: 300 });
      expect(parseCustomBudgetInput('150 to 300')).toEqual({ min: 150, max: 300 });
      expect(parseCustomBudgetInput('150..300')).toEqual({ min: 150, max: 300 });
      expect(parseCustomBudgetInput('150/300')).toEqual({ min: 150, max: 300 });
      expect(parseCustomBudgetInput('150 300')).toEqual({ min: 150, max: 300 });
      expect(parseCustomBudgetInput('150 до 300')).toEqual({ min: 150, max: 300 });
    });

    test('parses upper limits (under / max / до)', () => {
      expect(parseCustomBudgetInput('under 300')).toEqual({ min: 0, max: 300 });
      expect(parseCustomBudgetInput('< $350')).toEqual({ min: 0, max: 350 });
      expect(parseCustomBudgetInput('max 500')).toEqual({ min: 0, max: 500 });
      expect(parseCustomBudgetInput('до 250')).toEqual({ min: 0, max: 250 });
    });

    test('parses lower limits (from / min / от / +)', () => {
      expect(parseCustomBudgetInput('from 200')).toEqual({ min: 200, max: undefined });
      expect(parseCustomBudgetInput('> $300')).toEqual({ min: 300, max: undefined });
      expect(parseCustomBudgetInput('min 150')).toEqual({ min: 150, max: undefined });
      expect(parseCustomBudgetInput('200+')).toEqual({ min: 200, max: undefined });
      expect(parseCustomBudgetInput('от 250')).toEqual({ min: 250, max: undefined });
    });

    test('parses single number as upper limit', () => {
      expect(parseCustomBudgetInput('250')).toEqual({ min: 0, max: 250 });
      expect(parseCustomBudgetInput('$350')).toEqual({ min: 0, max: 350 });
    });

    test('returns null for invalid inputs', () => {
      expect(parseCustomBudgetInput('')).toBeNull();
      expect(parseCustomBudgetInput('hello world')).toBeNull();
    });
  });

  describe('End-to-End Ingestion & Deduplication Pipeline', () => {
    const uniqueSuffix = Date.now().toString().slice(-5);
    const testPhone = `097${uniqueSuffix}12`;
    const testLocation = 'Chreav';

    const baseListing = {
      title: `Chreav Garden House with Pool #${uniqueSuffix}`,
      description: 'Cozy 2BR house in Chreav. 1 month deposit, min 6 mos lease.',
      price: 500,
      currency: 'USD',
      type: 'rent',
      category: 'house',
      location: testLocation,
      city: 'siem_reap',
      deposit: 500,
      min_lease: 6,
      has_pool: true,
      phone: `+855 ${testPhone.slice(1, 3)} ${testPhone.slice(3, 6)} ${testPhone.slice(6)}`,
      telegram_contact: 'chreavhomes',
      url: `https://example.com/chreav-${uniqueSuffix}`,
    };

    test('inserts unique property and extracts structured fields', async () => {
      const res = await container.ingestionService.ingestRawListing(baseListing);
      expect(res.status).toBe('inserted');
      expect(res.propertyId).toBeDefined();

      const saved = container.propertiesRepo.getPropertyById(res.propertyId!);
      expect(saved).toBeDefined();
      expect(saved?.price).toBe(50000); // 500 USD in cents
      expect(saved?.category).toBe('house');
      expect(saved?.has_pool).toBe(true);
      expect(saved?.min_lease).toBe(6);
      expect(saved?.deposit).toBe(50000);
      expect(saved?.location).toBe('Chreav');
    });

    test('flags duplicate when weighted similarity score >= 75 (same agent, near price, same category)', async () => {
      const duplicateListing = {
        title: `Repost: Beautiful Villa in Chreav Area #${uniqueSuffix}`,
        description: '2BR house for rent with pool',
        price: 510, // $510 vs $500 (2% diff -> +30 pts)
        type: 'rent',
        category: 'house', // (+15 pts)
        bedrooms: 2, // (+25 pts)
        bathrooms: 2,
        location: testLocation,
        city: 'siem_reap',
        phone: testPhone, // Same agent phone (+20 pts) -> 90 pts total
        url: `https://example.com/chreav-repost-${uniqueSuffix}`,
      };

      const res = await container.ingestionService.ingestRawListing(duplicateListing);
      expect(res.status).toBe('duplicate');
      expect(res.duplicateOfId).toBeDefined();
      expect(res.reason).toContain('similarity score');
    });

    test('allows same agent to list a DIFFERENT property in the same Sangkat', async () => {
      // Same agent (+20 pts) & Sangkat, but smaller house with very different price $200 vs $500 (+0 pts) and 1BR vs 2BR (+0 pts) -> score = 35 < 75
      const differentListing = {
        title: `Cozy 1BR House in Chreav for rent #${uniqueSuffix}`,
        description: 'Small 1BR house in Chreav, low budget.',
        price: 200,
        type: 'rent',
        category: 'house',
        bedrooms: 1,
        bathrooms: 1,
        location: testLocation,
        city: 'siem_reap',
        phone: testPhone, // Same agent
        url: `https://example.com/chreav-diff-${uniqueSuffix}`,
      };

      const res = await container.ingestionService.ingestRawListing(differentListing);
      expect(res.status).toBe('inserted');
      expect(res.propertyId).toBeDefined();
    });

    test('time-decay deduplication: excludes properties older than 45 days from dedup candidates', () => {
      const db = container.db;
      // Insert a property with created_at set to 50 days ago
      const oldDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
      const insertResult = db
        .prepare(
          `INSERT INTO properties (hash, title, description, price, currency, type, location, city, created_at, is_active)
           VALUES ('old-hash-123', 'Old House in Chreav', 'Old description', 50000, 'USD', 'rent', 'Chreav', 'siem_reap', ?, 1)`,
        )
        .run(oldDate);

      const candidates = container.propertiesRepo.findRecentPropertiesForDedup('siem_reap', 'Chreav');
      const foundOld = candidates.some((p) => p.id === Number(insertResult.lastInsertRowid));
      expect(foundOld).toBe(false);
    });
  });
});
