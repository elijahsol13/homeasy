import { toHighResImageUrl, KHMER24_TARGETS } from '../src/modules/parser/khmer24.scraper';
import { parseKhmer24DetailHtml } from '../src/modules/parser/khmer24-http';

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

  describe('HTTP detail parser', () => {
    test('extracts a listing from Product JSON-LD', () => {
      const html = `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Apartment for rent',
        description: 'Central apartment',
        image: ['https://images.khmer24.co/a.jpg'],
        offers: {
          price: '350.00',
          priceCurrency: 'USD',
          seller: { telephone: ['012345678'], address: { streetAddress: 'BKK1' } },
        },
      })}</script>`;
      const listing = parseKhmer24DetailHtml(html, 'https://www.khmer24.com/en/test-adid-1', {
        category: 'apartment',
        city: 'phnom_penh',
        type: 'rent',
      });
      expect(listing).toMatchObject({ title: 'Apartment for rent', price: 350, phone: '012345678', location: 'BKK1' });
    });
  });

  describe('KHMER24_TARGETS configuration', () => {
    test('has three Siem Reap monthly-rental targets for the MVP', () => {
      expect(KHMER24_TARGETS).toHaveLength(3);
      expect(KHMER24_TARGETS.every((target) => target.city === 'siem_reap' && target.type === 'rent')).toBe(true);
    });

    test('covers house, apartment, and room categories', () => {
      const categories = KHMER24_TARGETS.map((t) => t.category);
      expect(categories).toContain('house');
      expect(categories).toContain('apartment');
      expect(categories).toContain('room');
    });

    test('category slugs match expected Khmer24 API slugs', () => {
      const slugs = KHMER24_TARGETS.map((t) => t.categorySlug);
      expect(slugs).toContain('house-for-rent');
      expect(slugs).toContain('apartment-for-rent');
      expect(slugs).toContain('room-for-rent');
      expect(slugs.some((slug) => slug.includes('sale'))).toBe(false);
    });
  });
});
