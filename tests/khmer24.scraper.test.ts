import { toHighResImageUrl, KHMER24_TARGETS, postToRawListing } from '../src/modules/parser/khmer24.scraper';
import { RawListingSchema } from '../src/modules/parser/schemas';
import type { PropertyCategory } from '../src/config/settings';

// ─── Re-export private function for testing via module augmentation ───────────
// Since postToRawListing is not exported, we test it through the public interface
// and replicate its logic here as a local helper for unit testing.

type K24Post = Parameters<typeof postToRawListing>[0];
type ScrapeTarget = (typeof KHMER24_TARGETS)[0];

function mockPost(overrides: Partial<K24Post> = {}): K24Post {
  return {
    id: '13611069',
    title: 'Luxury 3BR Villa in Sala Kamreuk with Private Pool',
    price: '1200.00',
    photos: [
      'https://images.khmer24.co/26-06-05/villa-front-b.jpg',
      'https://images.khmer24.co/26-06-05/villa-pool-c.jpg',
    ],
    description: 'Stunning 3 bedroom villa in Sala Kamreuk. Pool, garden, parking.',
    condition: { value: 'rent', title: 'Rent', field: 'listing_type' },
    location: {
      id: '37',
      en_name: 'Siem Reap',
      en_name2: 'Siem Reap, Siem Reap',
      en_name3: 'Sala Kamreuk, Siem Reap, Siem Reap',
      slug: 'siem-reap',
    },
    category: { id: '77', en_name: 'House For Rent', slug: 'house-for-rent' },
    object_highlight_specs: {
      bedroom: { title: 'Bedroom', field: 'bedroom', value: '3', display_value: '3 Bedrooms', value_slug: '3' },
      bathroom: { title: 'Bathroom', field: 'bathroom', value: '2', display_value: '2 Bathrooms', value_slug: '2' },
    },
    link: 'https://www.khmer24.com/post-adid-13611069',
    user: { id: '310653', name: 'Sala Kamreuk Homes', username: 'salakamreukhomes' },
    ...overrides,
  };
}

const houseTarget: ScrapeTarget = {
  name: 'Siem Reap — Houses for Rent',
  category: 'house' as PropertyCategory,
  city: 'siem_reap',
  categorySlug: 'house-for-rent',
  locationSlug: 'siem-reap',
};

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
    test('has exactly 3 Siem Reap targets', () => {
      expect(KHMER24_TARGETS).toHaveLength(3);
    });

    test('all targets point to siem_reap city', () => {
      KHMER24_TARGETS.forEach((t) => {
        expect(t.city).toBe('siem_reap');
        expect(t.locationSlug).toBe('siem-reap');
      });
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
    });
  });

  describe('postToRawListing JSON mapping', () => {
    test('correctly maps all top-level fields from a K24 post', () => {
      const post = mockPost();
      const listing = postToRawListing(post, houseTarget);

      expect(listing.title).toBe('Luxury 3BR Villa in Sala Kamreuk with Private Pool');
      expect(listing.price).toBe(1200);
      expect(listing.currency).toBe('USD');
      expect(listing.type).toBe('rent');
      expect(listing.category).toBe('house');
      expect(listing.city).toBe('siem_reap');
      expect(listing.url).toBe('https://www.khmer24.com/post-adid-13611069');
      expect(listing.source_url).toBe('https://www.khmer24.com/post-adid-13611069');
    });

    test('extracts Sangkat from en_name3 (most specific level)', () => {
      const listing = postToRawListing(mockPost(), houseTarget);
      expect(listing.location).toBe('Sala Kamreuk'); // first segment of en_name3
    });

    test('falls back to en_name when en_name3 is not available', () => {
      const post = mockPost({
        location: { id: '37', en_name: 'Siem Reap', slug: 'siem-reap' },
      });
      const listing = postToRawListing(post, houseTarget);
      expect(listing.location).toBe('Siem Reap');
    });

    test('maps bedroom and bathroom counts from object_highlight_specs', () => {
      const listing = postToRawListing(mockPost(), houseTarget);
      expect(listing.bedrooms).toBe(3);
      expect(listing.bathrooms).toBe(2);
    });

    test('returns undefined for bedrooms when value is "more"', () => {
      const post = mockPost({
        object_highlight_specs: {
          bedroom: { title: 'Bedroom', field: 'bedroom', value: 'more', display_value: 'More Bedrooms', value_slug: 'more' },
        },
      });
      const listing = postToRawListing(post, houseTarget);
      expect(listing.bedrooms).toBeUndefined();
    });

    test('includes all photos from the API response', () => {
      const listing = postToRawListing(mockPost(), houseTarget);
      expect(listing.photos).toHaveLength(2);
      expect(listing.photos![0]).toBe('https://images.khmer24.co/26-06-05/villa-front-b.jpg');
    });

    test('includes phone when provided', () => {
      const listing = postToRawListing(mockPost(), houseTarget, '+85512345678');
      expect(listing.phone).toBe('+85512345678');
    });

    test('generates fallback URL from post ID when link is absent', () => {
      const post = mockPost({ link: undefined, short_link: undefined });
      const listing = postToRawListing(post, houseTarget);
      expect(listing.url).toBe('https://www.khmer24.com/post-adid-13611069');
    });

    test('mapped listing passes RawListingSchema validation', () => {
      const listing = postToRawListing(mockPost(), houseTarget, '+85512345678');
      const result = RawListingSchema.safeParse(listing);
      expect(result.success).toBe(true);
    });
  });
});
