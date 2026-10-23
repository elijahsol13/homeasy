import { validateCanonicalListingBatch } from '../src/modules/parser/canonical-listing-extractor';

const emptyFacts = {
  is_supported_listing: true, rejection_reason: null,
  title_en: 'Apartment for Rent', description_en: 'An apartment is available.',
  price: null, currency: null, category: null, property_type: null,
  bedrooms: null, bathrooms: null, city: null, sangkat: null,
  explicit_location: null, landmarks: [], marketing_landmarks: [],
  min_lease_months: null, lease_term_text: null,
  deposit_amount: null, deposit_months: null, has_pool: null,
  electricity_type: null, electricity_rate: null, water_type: null,
  water_rate: null, cleaning: null, restrictions: [], pet_friendly: null,
  discovered_amenities: [],
};

const byId = new Map([['one', 'Apartment for rent. Unknown price and amenities.']]);
const batch = (result: unknown) => ({ items: [{ id: 'one', result }] });

describe('canonical AI JSON contract', () => {
  test('allows all unmentioned facts to remain null or empty', () => {
    expect(validateCanonicalListingBatch(batch(emptyFacts), byId)).toBe(true);
  });

  test('ignores catalog-unknown amenity labels while keeping typed structure strict', () => {
    expect(validateCanonicalListingBatch(batch({ ...emptyFacts,
      discovered_amenities: ['free_wifi', 'roof terrace', 'unlisted_id'],
    }), byId)).toBe(true);
    expect(validateCanonicalListingBatch(batch({ ...emptyFacts,
      discovered_amenities: ['unlisted_id', 12],
    }), byId)).not.toBe(true);
  });

  test.each([
    ['inferred boolean as a string', { pet_friendly: 'false' }],
    ['wrong property enum', { property_type: 'Castle' }],
    ['untyped lists', { discovered_amenities: ['AC', 23] }],
    ['unknown utility type', { electricity_type: 'cheap' }],
    ['fractional bedroom count', { bedrooms: 1.5 }],
    ['unknown field', { extra_amenity: 'unverified' }],
    ['list too long', { landmarks: Array(40).fill('X') }],
  ])('rejects %s before sanitizing instead of hiding invalid data', (_reason, delta) => {
    expect(validateCanonicalListingBatch(batch({ ...emptyFacts, ...delta }), byId)).not.toBe(true);
  });

  test('rejects missing fields rather than interpreting absence as a negative', () => {
    const { has_pool: omitted, ...incomplete } = emptyFacts;
    expect(omitted).toBeNull();
    expect(validateCanonicalListingBatch(batch(incomplete), byId)).not.toBe(true);
  });
});
