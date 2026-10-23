import type { Property } from '../src/database/repositories/properties.repo';
import { toPropertyDTO } from '../src/modules/api/dto';
import { factualListingFallback } from '../src/modules/parser/listing-editorial';

const property = (amenities: string[], hasPool: boolean | null = null): Property => ({
  id: 1, hash: 'display-fixture', title: 'Rental apartment', description: 'A rental apartment.',
  price: 25000, currency: 'USD', type: 'rent', category: 'apartment', bedrooms: 2, bathrooms: 1,
  deposit: null, min_lease: null, has_pool: hasPool, location: 'Sala Kamreuk', city: 'siem_reap',
  maps_url: null, source_url: null, original_url: '', photos: [], direct_contact: {},
  created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:00:00Z',
  amenities,
} as unknown as Property);

describe('bounded, readable listing detail data', () => {
  test('renders canonical amenity IDs as catalog labels, removes duplicate synonyms and unknown IDs', () => {
    const result = toPropertyDTO(property([
      'washing_machine', 'Washing Machine', 'car_parking', 'alien_hottub', 'ac_all_rooms', 'free_wifi',
    ]));
    expect(result.specs.amenities).toEqual([
      'Washing Machine', 'Car Parking', 'Air Conditioning (All Rooms)', 'Free WiFi',
    ]);
    expect(result.specs.amenities).not.toContain('alien_hottub');
  });

  test('does not duplicate the swimming pool badge or silently invent absent amenities', () => {
    expect(toPropertyDTO(property(['swimming_pool', 'pool'], true)).specs.amenities).toEqual([]);
    expect(toPropertyDTO(property([], null)).specs.amenities).toEqual([]);
  });

  test('exposes a stated deposit duration without manufacturing cash from monthly rent', () => {
    const withDuration = toPropertyDTO({ ...property([]), listing_facts_json: '{"deposit_months":1}' });
    expect(withDuration.depositMonths).toBe(1);
    expect(withDuration.depositUsd).toBeNull();
    expect(toPropertyDTO({ ...property([]), listing_facts_json: '{"deposit_months":"1"}' }).depositMonths).toBeNull();
    expect(toPropertyDTO({ ...property([]), listing_facts_json: '{invalid}' }).depositMonths).toBeNull();
  });

  test('writes a short factual fallback from verified author room counts instead of repeating raw advertising', () => {
    const sourceText = 'Modern! For rent. 2 bedrooms, 1 bathroom. Call 012345678 for the best deal!!!';
    const description = factualListingFallback({ sourceText, category: 'apartment', bedrooms: 2, bathrooms: 1 });
    expect(description).toBe('Apartment for rent with 2 bedrooms and 1 bathroom.');
    expect(description).not.toContain('012345678');
  });

  test('avoids unverified metadata and conflicting room totals in fallback copy', () => {
    const description = factualListingFallback({
      sourceText: 'Bedroom 1\nBedroom 3\nBathrooms: 2', propertyType: 'Studio', bedrooms: 3, bathrooms: 2,
    });
    expect(description).toBe('Studio for rent with 2 bathrooms.');
  });
});
