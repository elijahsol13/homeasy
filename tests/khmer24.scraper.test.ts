import { toHighResImageUrl, KHMER24_TARGETS } from '../src/modules/parser/khmer24.scraper';

describe('Khmer24 API Scraper', () => {
  describe('toHighResImageUrl', () => {
    test('replaces /thumbs/ with /uploads/', () => {
      expect(toHighResImageUrl('https://images.khmer24.co/thumbs/sample.jpg')).toBe(
        'https://images.khmer24.co/uploads/sample.jpg',
      );
    });

    test('replaces /s/ (small) with /l/ (large)', () => {
      // Real Khmer24 CDN uses /s/ as a sub-path separator
      expect(toHighResImageUrl('https://images.khmer24.co/26-06-05/s/villa-front-b.jpg')).toBe(
        'https://images.khmer24.co/26-06-05/l/villa-front-b.jpg',
      );
    });

    test('replaces /m/ (medium) with /l/ (large)', () => {
      expect(toHighResImageUrl('https://images.khmer24.co/m/villa-pool.jpg')).toBe(
        'https://images.khmer24.co/l/villa-pool.jpg',
      );
    });

    test('leaves already full-resolution URLs unchanged', () => {
      const url = 'https://images.khmer24.co/26-06-05/villa-front-b.jpg';
      expect(toHighResImageUrl(url)).toBe(url);
    });
  });

  describe('KHMER24_TARGETS configuration', () => {
    test('has 10 targets covering Siem Reap and Phnom Penh', () => {
      expect(KHMER24_TARGETS).toHaveLength(10);
    });

    test('covers both siem_reap and phnom_penh cities', () => {
      const cities = new Set(KHMER24_TARGETS.map((t) => t.city));
      expect(cities.has('siem_reap')).toBe(true);
      expect(cities.has('phnom_penh')).toBe(true);
    });

    test('covers house, apartment, and room categories', () => {
      const categories = KHMER24_TARGETS.map((t) => t.category);
      expect(categories).toContain('house');
      expect(categories).toContain('apartment');
      expect(categories).toContain('room');
    });

    test('covers both rent and sale types', () => {
      const types = KHMER24_TARGETS.map((t) => t.type);
      expect(types).toContain('rent');
      expect(types).toContain('sale');
    });

    test('category slugs match expected Khmer24 API slugs', () => {
      const slugs = KHMER24_TARGETS.map((t) => t.categorySlug);
      expect(slugs).toContain('house-for-rent');
      expect(slugs).toContain('apartment-for-rent');
      expect(slugs).toContain('room-for-rent');
      expect(slugs).toContain('house-for-sale');
      expect(slugs).toContain('condo-for-sale');
    });
  });
});
