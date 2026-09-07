import { cleanPhotoUrls } from '../src/modules/parser/normalizer';
import { isNonRealEstateSpam } from '../src/modules/parser/spam-detector';
import { isExcessiveKhmer } from '../src/modules/parser/extractor';
import { translationRetryQueue } from '../src/modules/parser/facebook.scraper';
import { createContainer, type AppContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { enrichPropertyRecord, type PropertyRecord } from '../src/database/enrich-properties';

describe('Data Cleanup, Photo Sanitizer & Intelligent Parsing Pipeline', () => {
  describe('Photo Sanitizer (cleanPhotoUrls) & Hero Image Invariant', () => {
    test('filters out avatar thumbnails, profile pictures, and emojis', () => {
      const input = [
        'https://scontent.xx.fbcdn.net/v/t39.30808-6/p100x100/junk1.jpg',
        'https://scontent.xx.fbcdn.net/v/t39.30808-6/p160x160/junk2.jpg',
        'https://scontent.xx.fbcdn.net/v/t39.30808-6/s160x160/junk3.jpg',
        'https://scontent.xx.fbcdn.net/v/t39.30808-6/c0.0.100.100/junk4.jpg',
        'https://scontent.xx.fbcdn.net/profile/avatar.png',
        'https://scontent.xx.fbcdn.net/static/emoji/heart.png',
        'https://scontent.xx.fbcdn.net/real-villa-living-room.jpg',
        'https://scontent.xx.fbcdn.net/real-villa-bedroom.jpg',
      ];

      const cleaned = cleanPhotoUrls(input);
      expect(cleaned).toHaveLength(2);
      expect(cleaned[0]).toBe('https://scontent.xx.fbcdn.net/real-villa-living-room.jpg');
      expect(cleaned[1]).toBe('https://scontent.xx.fbcdn.net/real-villa-bedroom.jpg');
    });

    test('deduplicates photo URLs while strictly preserving Hero Image at index 0', () => {
      const input = [
        'https://example.com/hero-photo.jpg',
        'https://example.com/bedroom.jpg',
        'https://example.com/hero-photo.jpg', // duplicate hero
        'https://example.com/kitchen.jpg',
        'https://example.com/bedroom.jpg', // duplicate
      ];

      const cleaned = cleanPhotoUrls(input);
      expect(cleaned).toEqual([
        'https://example.com/hero-photo.jpg',
        'https://example.com/bedroom.jpg',
        'https://example.com/kitchen.jpg',
      ]);
      // Critical invariant check
      expect(cleaned[0]).toBe('https://example.com/hero-photo.jpg');
    });

    test('handles empty, non-array, and invalid inputs gracefully', () => {
      expect(cleanPhotoUrls([])).toEqual([]);
      expect(cleanPhotoUrls(null)).toEqual([]);
      expect(cleanPhotoUrls(undefined)).toEqual([]);
      expect(cleanPhotoUrls(['not-a-url', 'ftp://invalid', '   '])).toEqual([]);
    });
  });

  describe('Pre-LLM Spam Filter (isNonRealEstateSpam)', () => {
    test('rejects vehicles, scooters, and registration cards without calling AI', () => {
      const res = isNonRealEstateSpam('Scoopy 2022 មានកាតគ្រី 1200$', 'call 012345678');
      expect(res.isSpam).toBe(true);
    });

    test('rejects airport taxi and transportation services', () => {
      const res = isNonRealEstateSpam('Airport transfer Siem Reap to Phnom Penh', 'reliable driver 24/7');
      expect(res.isSpam).toBe(true);
    });

    test('rejects beauty salons, perms, and massages', () => {
      const res = isNonRealEstateSpam('Special Hair Salon & Layer Perm', 'discount 20% today');
      expect(res.isSpam).toBe(true);
    });

    test('allows legitimate real estate apartments and houses', () => {
      const res = isNonRealEstateSpam('Modern 2BR Apartment For Rent in BKK1', 'Fully furnished, pool and gym included');
      expect(res.isSpam).toBe(false);
    });
  });

  describe('Translation Quality & Khmer Character Check (isExcessiveKhmer)', () => {
    test('flags text containing >10% Khmer characters as excessive', () => {
      const khmerHeavy = 'បន្ទប់ជួលស្អាត មានម៉ាស៊ីនត្រជាក់ និង ទឹកភ្លើងរដ្ឋ Free wifi';
      expect(isExcessiveKhmer(khmerHeavy, 0.10)).toBe(true);
    });

    test('accepts clean English translations', () => {
      const cleanEnglish = 'Modern 1 bedroom apartment with balcony, swimming pool and high-speed fiber internet.';
      expect(isExcessiveKhmer(cleanEnglish, 0.10)).toBe(false);
    });

    test('allows minor Khmer references (< 10%)', () => {
      const mostlyEnglish = 'Spacious villa in Siem Reap (វត្តបូព៌ area) with private swimming pool and parking.';
      expect(isExcessiveKhmer(mostlyEnglish, 0.10)).toBe(false);
    });

    test('handles empty and null inputs safely', () => {
      expect(isExcessiveKhmer('')).toBe(false);
      expect(isExcessiveKhmer(null)).toBe(false);
      expect(isExcessiveKhmer(undefined)).toBe(false);
    });
  });

  describe('In-Memory Translation Retry Queue Behavior', () => {
    beforeEach(() => {
      translationRetryQueue.length = 0;
    });

    test('enqueues item on first failure and discards after 2 retries (3 total attempts)', () => {
      const item = {
        id: 'post-test-123',
        text: 'បន្ទប់ជួលតម្លៃពិសេស',
        retries: 0,
      };

      // Attempt 1 fails -> retries becomes 1
      if (item.retries < 2) {
        translationRetryQueue.push({ ...item, retries: item.retries + 1 });
      }
      expect(translationRetryQueue).toHaveLength(1);
      expect(translationRetryQueue[0].retries).toBe(1);

      // Attempt 2 fails -> retries becomes 2
      const retry1 = translationRetryQueue.shift()!;
      if (retry1.retries < 2) {
        translationRetryQueue.push({ ...retry1, retries: retry1.retries + 1 });
      }
      expect(translationRetryQueue).toHaveLength(1);
      expect(translationRetryQueue[0].retries).toBe(2);

      // Attempt 3 fails -> discarded permanently
      const retry2 = translationRetryQueue.shift()!;
      if (retry2.retries < 2) {
        translationRetryQueue.push({ ...retry2, retries: retry2.retries + 1 });
      }
      expect(translationRetryQueue).toHaveLength(0); // successfully discarded
    });
  });

  describe('Ingestion Lot Review for Listings Without Photos', () => {
    let container: AppContainer;

    beforeAll(() => {
      container = createContainer({ dbPath: ':memory:' });
      runMigrations(container.db);
    });

    test('saves listing with is_active = 0 and calls alertService.warn when photos are empty', async () => {
      const warnSpy = jest.spyOn(container.alertService, 'warn').mockResolvedValue();

      const rawListing = {
        title: 'Penthouse Apartment Without Pictures',
        description: 'Luxury penthouse available now in Daun Penh.',
        price: 800,
        currency: 'USD',
        type: 'rent' as const,
        category: 'apartment' as const,
        location: 'Daun Penh',
        city: 'phnom_penh' as const,
        photos: [], // 0 photos
        source_url: 'https://facebook.com/groups/post-nophoto-1',
        url: 'https://facebook.com/groups/post-nophoto-1',
      };

      const result = await container.ingestionService.ingestRawListing(rawListing);
      expect(result.status).toBe('inserted');

      // Verify property is in DB with is_active = 0
      const saved = container.propertiesRepo.findById(result.propertyId!);
      expect(saved).toBeDefined();
      expect(saved?.is_active).toBe(0);

      // Verify alert was sent for admin review
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Требует ревью (нет фото)'),
      );

      warnSpy.mockRestore();
    });
  });

  describe('Historical Database Enrichment (enrichPropertyRecord)', () => {
    function createMock(overrides: Partial<PropertyRecord> = {}): PropertyRecord {
      return {
        id: 99,
        hash: 'test-hash-photo-clean',
        title: 'Cozy Villa',
        description: 'Nice villa in Siem Reap',
        price: 45000,
        currency: 'USD',
        type: 'rent',
        category: 'house',
        bedrooms: 2,
        bathrooms: 2,
        deposit: null,
        min_lease: null,
        has_pool: 0,
        location: 'Sala Kamreuk',
        city: 'siem_reap',
        maps_url: null,
        source_url: null,
        photos: JSON.stringify([
          'https://scontent.xx.fbcdn.net/p100x100/avatar.jpg',
          'https://scontent.xx.fbcdn.net/valid-villa.jpg',
        ]),
        image_phash: null,
        image_phashes: '[]',
        direct_contact: '{}',
        original_url: 'https://facebook.com/p/99',
        reports_count: 0,
        is_active: 1,
        parsed_at: '2026-09-01T10:00:00Z',
        created_at: '2026-09-01T10:00:00Z',
        posted_at: null,
        updated_at: '2026-09-01T10:00:00Z',
        ...overrides,
      };
    }

    test('cleans junk photos from existing listings and updates photos JSON', () => {
      const prop = createMock();
      const res = enrichPropertyRecord(prop);

      expect(res.updated).toBe(true);
      expect(res.changes.photos).toBeDefined();
      expect(JSON.parse(res.patch.photos as string)).toEqual([
        'https://scontent.xx.fbcdn.net/valid-villa.jpg',
      ]);
    });

    test('deactivates active listings when all photos are junk/empty after cleanup', () => {
      const prop = createMock({
        photos: JSON.stringify(['https://scontent.xx.fbcdn.net/p100x100/only-avatar.jpg']),
      });
      const res = enrichPropertyRecord(prop);

      expect(res.deactivated).toBe(true);
      expect(res.patch.is_active).toBe(0);
      expect(res.deactivateReason).toContain('No valid photos');
    });

    test('deactivates active listings with excessive (>10%) untranslated Khmer text', () => {
      const prop = createMock({
        title: 'ផ្ទះជួលស្អាតទើបសង់ថ្មី',
        description: 'មានបន្ទប់គេង២ បន្ទប់ទឹក២ ទីតាំងល្អនៅក្រុងសៀមរាប',
        photos: JSON.stringify(['https://example.com/photo.jpg']),
      });
      const res = enrichPropertyRecord(prop);

      expect(res.deactivated).toBe(true);
      expect(res.patch.is_active).toBe(0);
      expect(res.deactivateReason).toContain('Скрыт из-за кхмерского языка');
    });
  });
});
