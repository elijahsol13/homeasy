import { enrichPropertyRecord, isNonRealEstateSpam, type PropertyRecord } from '../src/database/enrich-properties';

function createMockProp(overrides: Partial<PropertyRecord> = {}): PropertyRecord {
  return {
    id: 1,
    hash: 'test-hash-1',
    title: 'Test Listing',
    description: '',
    price: 35000,
    currency: 'USD',
    type: 'rent',
    category: 'house',
    bedrooms: null,
    bathrooms: null,
    deposit: null,
    min_lease: null,
    has_pool: 0,
    location: 'Siem Reap Thmey',
    city: 'siem_reap',
    maps_url: null,
    source_url: null,
    photos: '[]',
    image_phash: null,
    image_phashes: '[]',
    direct_contact: '{}',
    original_url: 'https://example.com/p1',
    reports_count: 0,
    is_active: 1,
    parsed_at: '2026-09-01T10:00:00Z',
    created_at: '2026-09-01T10:00:00Z',
    posted_at: null,
    updated_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

describe('Database Enrichment & Backfill Engine', () => {
  describe('Spam and Non-Real-Estate Filtering', () => {
    test('detects scooter and motorcycle ads', () => {
      const { isSpam } = isNonRealEstateSpam('Zoomer 017 មានកាតគ្រី 425$', '015667762 telegram');
      expect(isSpam).toBe(true);
    });

    test('detects taxi and airport transfer ads', () => {
      const { isSpam } = isNonRealEstateSpam('Looking for a reliable driver from PP city to PP airport', 'contact me');
      expect(isSpam).toBe(true);
    });

    test('detects fragrance oil delivery promotions', () => {
      const { isSpam } = isNonRealEstateSpam('បោះដុំ ប្រេងក្រអូប', 'FREE DELIVERY — ដឹកជញ្ជូនឥតគិតថ្លៃ');
      expect(isSpam).toBe(true);
    });

    test('detects pure land sales', () => {
      const { isSpam } = isNonRealEstateSpam('ដីលក់តម្លៃពិសេស | ចោមចៅ – ពោធិ៍សែនជ័យ', 'ដីទំហំ 5x20m');
      expect(isSpam).toBe(true);
    });

    test('does NOT flag legitimate apartments or villas as spam', () => {
      const { isSpam } = isNonRealEstateSpam(
        'Modern 2BR Apartment with Pool',
        'Close to airport and coffee shops, 5 mins from Pub Street',
      );
      expect(isSpam).toBe(false);
    });
  });

  describe('Field Extraction and Recovery', () => {
    test('recovers bedrooms and bathrooms from Khmer text', () => {
      const prop = createMockProp({
        title: 'ផ្ទះវីឡាលក់បន្ទាន់ 5បន្ទប់គេង 3បន្ទប់ទឹក',
        description: 'តម្លៃសមរម្យ',
      });
      const res = enrichPropertyRecord(prop);
      expect(res.updated).toBe(true);
      expect(res.patch.bedrooms).toBe(5);
      expect(res.patch.bathrooms).toBe(3);
    });

    test('recovers bedrooms = 1 for room category', () => {
      const prop = createMockProp({
        category: 'room',
        title: 'បន្ទប់ជួល',
        description: 'Size: 15m²',
      });
      const res = enrichPropertyRecord(prop);
      expect(res.updated).toBe(true);
      expect(res.patch.bedrooms).toBe(1);
    });

    test('recovers swimming pool flag from Khmer and English', () => {
      const propKhmer = createMockProp({
        title: 'ផ្ទះមានអាងហែលទឹក',
        has_pool: 0,
      });
      const resKhmer = enrichPropertyRecord(propKhmer);
      expect(resKhmer.patch.has_pool).toBe(1);

      const propEng = createMockProp({
        title: 'Lovely villa with private pool',
        has_pool: 0,
      });
      const resEng = enrichPropertyRecord(propEng);
      expect(resEng.patch.has_pool).toBe(1);
    });

    test('recovers specific sangkat from Khmer text when location was generic', () => {
      const prop = createMockProp({
        location: 'Siem Reap Thmey',
        title: 'ផ្ទះជួលនៅសង្កាត់ស្វាយដង្គុំ',
      });
      const res = enrichPropertyRecord(prop);
      expect(res.patch.location).toBe('Svay Dangkum');
    });

    test('recovers phone and telegram contacts from description', () => {
      const prop = createMockProp({
        direct_contact: '{}',
        description: 'Contact phone: 012 888 999, telegram @sr_agent',
      });
      const res = enrichPropertyRecord(prop);
      expect(res.patch.direct_contact).toBeDefined();
      const parsed = JSON.parse(res.patch.direct_contact as string);
      expect(parsed.phone).toBe('85512888999');
      expect(parsed.telegram).toBe('@sr_agent');
    });

    test('backfills posted_at safely when null', () => {
      const prop = createMockProp({
        posted_at: null,
        created_at: '2026-08-20T12:00:00Z',
      });
      const res = enrichPropertyRecord(prop);
      expect(res.patch.posted_at).toBe('2026-08-20T12:00:00Z');
    });
  });

  describe('Direct Extractor Functions with Khmer Support', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { extractBedrooms, extractBathrooms, extractHasPool, extractLocation } = require('../src/modules/parser/extractor');

    test('extracts bedrooms from Khmer and English', () => {
      expect(extractBedrooms('វីឡា 4បន្ទប់គេង')).toBe(4);
      expect(extractBedrooms('House with 3 bedrooms')).toBe(3);
      expect(extractBedrooms('Studio apartment')).toBe(0);
    });

    test('extracts bathrooms from Khmer and English', () => {
      expect(extractBathrooms('វីឡា 3បន្ទប់ទឹក')).toBe(3);
      expect(extractBathrooms('Apartment 2 bathrooms')).toBe(2);
    });

    test('extracts swimming pool from Khmer and English', () => {
      expect(extractHasPool('ផ្ទះមានអាងហែលទឹក')).toBe(true);
      expect(extractHasPool('Modern villa with pool')).toBe(true);
      expect(extractHasPool('Standard house no amenities')).toBe(false);
    });

    test('extracts Sangkat from Khmer names', () => {
      const loc1 = extractLocation('ផ្ទះជួលនៅសង្កាត់ស្វាយដង្គុំ');
      expect(loc1?.location).toBe('Svay Dangkum');
      expect(loc1?.city).toBe('siem_reap');

      const loc2 = extractLocation('Apartment in Boeung Keng Kang 1 បឹងកេងកង');
      expect(loc2?.location).toBe('BKK1');
      expect(loc2?.city).toBe('phnom_penh');
    });
  });
});
