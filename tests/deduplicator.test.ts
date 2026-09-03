import {
  calculateSimilarityScore,
  checkDuplicate,
  isMultiImagePhashMatch,
} from '../src/modules/matcher/deduplicator';
import type { CleanProperty } from '../src/modules/parser/schemas';
import type { Property } from '../src/database/repositories/properties.repo';

function mockCleanProperty(overrides: Partial<CleanProperty> = {}): CleanProperty {
  return {
    title: 'Modern 2BR Apartment with Pool in Sala Kamreuk',
    description: 'Lovely modern 2BR apartment in Sala Kamreuk with swimming pool.',
    price: 50000, // $500 in cents
    currency: 'USD',
    type: 'rent',
    category: 'apartment',
    bedrooms: 2,
    bathrooms: 2,
    deposit: 50000,
    min_lease: 6,
    has_pool: true,
    location: 'Sala Kamreuk',
    city: 'siem_reap',
    maps_url: null,
    source_url: null,
    photos: [],
    image_phash: null,
    image_phashes: [],
    direct_contact: { phone: '85512345678' },
    original_url: 'https://example.com/prop-1',
    ...overrides,
  };
}

function mockDbProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 101,
    hash: 'sample-hash-1',
    title: 'Modern 2BR Apartment in Sala Kamreuk',
    description: 'Existing listing in Sala Kamreuk',
    price: 50000, // $500 in cents
    currency: 'USD',
    type: 'rent',
    category: 'apartment',
    bedrooms: 2,
    bathrooms: 2,
    deposit: 50000,
    min_lease: 6,
    has_pool: true,
    location: 'Sala Kamreuk',
    city: 'siem_reap',
    maps_url: null,
    source_url: null,
    photos: [],
    image_phash: null,
    image_phashes: [],
    direct_contact: { phone: '85512345678' },
    original_url: 'https://example.com/prop-1',
    reports_count: 0,
    is_active: 1,
    parsed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Deduplicator Engine', () => {
  describe('Multi-Image pHash Verification (Trigger 1)', () => {
    const hashA1 = '1100110011001100110011001100110011001100110011001100110011001100';
    const hashA2 = '1111000011110000111100001111000011110000111100001111000011110000';
    const hashA3 = '1010101010101010101010101010101010101010101010101010101010101010';

    const hashB1 = '1100110011001100110011001100110011001100110011001100110011001101'; // distance 1 to A1
    const hashB2 = '1111000011110000111100001111000011110000111100001111000011110011'; // distance 2 to A2
    const hashDiff = '0000000000000000000000000000000000000000000000000000000000000000';

    test('flags duplicate when 2 or more hashes match within threshold', () => {
      const result = isMultiImagePhashMatch([hashA1, hashA2, hashA3], [hashB1, hashB2, hashDiff]);
      expect(result.isMatch).toBe(true);
      expect(result.matchCount).toBe(2);
    });

    test('does not flag duplicate when only 1 of 3 hashes match', () => {
      const result = isMultiImagePhashMatch([hashA1, hashA2, hashA3], [hashB1, hashDiff, hashDiff]);
      expect(result.isMatch).toBe(false);
      expect(result.matchCount).toBe(1);
    });

    test('flags duplicate when both listings only have 1 hash and it matches', () => {
      const result = isMultiImagePhashMatch([hashA1], [hashB1]);
      expect(result.isMatch).toBe(true);
      expect(result.matchCount).toBe(1);
    });

    test('returns false for completely different hashes or empty sets', () => {
      expect(isMultiImagePhashMatch([], [hashA1]).isMatch).toBe(false);
      expect(isMultiImagePhashMatch([hashA1], [hashDiff]).isMatch).toBe(false);
    });
  });

  describe('Weighted Similarity Scoring Matrix (Trigger 2)', () => {
    test('computes exact 90 points for identical listing attributes', () => {
      const newProp = mockCleanProperty({ price: 50000, bedrooms: 2, bathrooms: 2, category: 'apartment' });
      const existing = mockDbProperty({ price: 50000, bedrooms: 2, bathrooms: 2, category: 'apartment' });

      const res = calculateSimilarityScore(newProp, existing);
      expect(res.breakdown.price).toBe(30);
      expect(res.breakdown.bedsBaths).toBe(25);
      expect(res.breakdown.phone).toBe(20);
      expect(res.breakdown.category).toBe(15);
      expect(res.score).toBe(90);
      expect(res.isDuplicate).toBe(true);
    });

    test('awards price points when price is within ±5%', () => {
      const newProp = mockCleanProperty({ price: 52000 }); // $520 vs $500 (4% diff)
      const existing = mockDbProperty({ price: 50000 });

      const res = calculateSimilarityScore(newProp, existing);
      expect(res.breakdown.price).toBe(30);
      expect(res.score).toBe(90);
      expect(res.isDuplicate).toBe(true);
    });

    test('awards 0 price points when price exceeds ±5%', () => {
      const newProp = mockCleanProperty({ price: 55000 }); // $550 vs $500 (10% diff)
      const existing = mockDbProperty({ price: 50000 });

      const res = calculateSimilarityScore(newProp, existing);
      expect(res.breakdown.price).toBe(0);
      expect(res.score).toBe(60); // 25 + 20 + 15 = 60 (< 75)
      expect(res.isDuplicate).toBe(false);
    });
  });

  describe('False Positive Prevention (Agent with multiple properties in same Sangkat)', () => {
    test('allows same agent with different price in same Sangkat', () => {
      // Same agent (+20), same Sangkat, same category (+15), but house for $250 vs villa for $800
      const newProp = mockCleanProperty({
        price: 25000, // $250
        category: 'house',
        bedrooms: 1,
        bathrooms: 1,
        direct_contact: { phone: '012345678' },
      });
      const existing = mockDbProperty({
        price: 80000, // $800
        category: 'house',
        bedrooms: 3,
        bathrooms: 3,
        direct_contact: { phone: '+855 12 345 678' },
      });

      const res = calculateSimilarityScore(newProp, existing);
      expect(res.breakdown.phone).toBe(20);
      expect(res.breakdown.category).toBe(15);
      expect(res.breakdown.price).toBe(0);
      expect(res.breakdown.bedsBaths).toBe(0);
      expect(res.score).toBe(35);
      expect(res.isDuplicate).toBe(false);
    });

    test('allows same agent with same category & price but different bedrooms', () => {
      // Same agent (+20), same category (+15), same price (+30), but 1BR vs 3BR (bedsBaths = 0)
      const newProp = mockCleanProperty({
        price: 50000,
        bedrooms: 1,
        bathrooms: 1,
        category: 'apartment',
      });
      const existing = mockDbProperty({
        price: 50000,
        bedrooms: 3,
        bathrooms: 2,
        category: 'apartment',
      });

      const res = calculateSimilarityScore(newProp, existing);
      expect(res.score).toBe(65); // 30 + 0 + 20 + 15 = 65 (< 75)
      expect(res.isDuplicate).toBe(false);
    });

    test('allows different agent with generic standard apartment in same Sangkat without photo match', () => {
      // Different agent (phone = 0), same price (+30), same beds/baths (+25), same category (+15) -> 70 pts (< 75)
      const newProp = mockCleanProperty({
        price: 40000,
        bedrooms: 1,
        bathrooms: 1,
        category: 'apartment',
        direct_contact: { phone: '089888777' },
      });
      const existing = mockDbProperty({
        price: 40000,
        bedrooms: 1,
        bathrooms: 1,
        category: 'apartment',
        direct_contact: { phone: '097111222' },
      });

      const res = calculateSimilarityScore(newProp, existing);
      expect(res.breakdown.phone).toBe(0);
      expect(res.score).toBe(70); // 30 + 25 + 0 + 15 = 70 (< 75)
      expect(res.isDuplicate).toBe(false);
    });
  });

  describe('Master checkDuplicate Function', () => {
    test('triggers duplicate on multi-image pHash match', () => {
      const hash1 = '1100110011001100110011001100110011001100110011001100110011001100';
      const hash2 = '1111000011110000111100001111000011110000111100001111000011110000';

      const newProp = mockCleanProperty({
        image_phashes: [hash1, hash2],
        price: 99999, // very different price
      });
      const existing = mockDbProperty({
        id: 42,
        image_phashes: [hash1, hash2],
        price: 30000,
      });

      const check = checkDuplicate(newProp, [existing]);
      expect(check.isDuplicate).toBe(true);
      expect(check.duplicateOfId).toBe(42);
      expect(check.trigger).toBe('multi_phash');
    });

    test('triggers duplicate on high similarity score', () => {
      const newProp = mockCleanProperty({
        price: 50000,
        bedrooms: 2,
        bathrooms: 2,
        category: 'house',
        direct_contact: { phone: '012345678' },
      });
      const existing = mockDbProperty({
        id: 77,
        price: 51000, // 2% diff (+30)
        bedrooms: 2,  // (+25)
        bathrooms: 2,
        category: 'house', // (+15)
        direct_contact: { phone: '+855 12 345 678' }, // (+20)
      });

      const check = checkDuplicate(newProp, [existing]);
      expect(check.isDuplicate).toBe(true);
      expect(check.duplicateOfId).toBe(77);
      expect(check.trigger).toBe('similarity_score');
      expect(check.score).toBe(90);
    });
  });
});

