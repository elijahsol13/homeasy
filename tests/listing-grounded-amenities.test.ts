import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { validateCanonicalListingBatch } from '../src/modules/parser/canonical-listing-extractor';

const candidate = {
  is_supported_listing: true, rejection_reason: null,
  title_en: 'Apartment for Rent', description_en: 'An apartment is available.',
  price: 220, currency: 'USD', category: 'apartment', property_type: 'Apartment',
  bedrooms: null, bathrooms: null, city: null, sangkat: null,
  explicit_location: null, landmarks: [], marketing_landmarks: [],
  min_lease_months: 6, lease_term_text: null,
  deposit_amount: 220, deposit_months: 1, has_pool: null,
  electricity_type: null, electricity_rate: null, water_type: null,
  water_rate: null, cleaning: null, restrictions: [], pet_friendly: null,
  discovered_amenities: ['free_wifi', 'car_parking', 'motorbike_parking', 'ac_all_rooms', 'air_conditioner'],
};

describe('source-grounded optional property facts', () => {
  test('keeps generic AC, but removes invented Wi-Fi, vehicle parking categories and all-room AC', () => {
    const source = 'Apartment $220/month. Internet connection: Included. Parking. 3 bedrooms with A/C. 6 months contract, 1 month deposit.';
    expect(validateCanonicalListingBatch({ items: [{ id: 'ad', result: candidate }] }, new Map([['ad', source]]))).toBe(true);
    const result = sanitizeListingFacts(candidate, source)!;
    expect(result.discovered_amenities).toEqual(['air_conditioner']);
    expect(result.deposit_amount).toBeNull();
    expect(result.deposit_months).toBe(1);
  });

  test('preserves specifically described amenities and explicit cash deposit', () => {
    const source = '2 bedroom apartment $450 per month. Free WiFi, car parking and motorbike parking. AC in every room. Deposit: USD 300.';
    const result = sanitizeListingFacts(candidate, source)!;
    expect(result.discovered_amenities).toEqual(['free_wifi', 'car_parking', 'motorbike_parking', 'ac_all_rooms']);
    expect(result.deposit_amount).toBe(300);
  });

  test('does not convert rent or one month of deposit into an unstated deposit amount', () => {
    const source = 'Rent: $220/month; deposit 1 month. Minimum contract 6 months.';
    expect(sanitizeListingFacts(candidate, source)?.deposit_amount).toBeNull();
    expect(sanitizeListingFacts(candidate, 'Rent $450 deposit 1 month')?.deposit_amount).toBeNull();
    const cashSource = 'Apartment for rent. Security deposit $250. Rental price $220/month.';
    expect(sanitizeListingFacts({ ...candidate, deposit_amount: 250 }, cashSource)?.deposit_amount).toBe(250);
    expect(sanitizeListingFacts(candidate, 'USD 300 deposit for this apartment')?.deposit_amount).toBe(300);
  });

  test('an ambiguous heat and cool water phrase does not establish a heater in the chip or description', () => {
    const source = 'Studio $220/month. Heat & Cool Water. A/C and refrigerator.';
    const model = { ...candidate, description_en: 'Studio with hot water heater, A/C and refrigerator.',
      discovered_amenities: ['hot_water_heater', 'air_conditioner', 'refrigerator'] };
    const result = sanitizeListingFacts(model, source)!;
    expect(result.discovered_amenities).toEqual(['air_conditioner', 'refrigerator']);
    expect(result.description_en.toLowerCase()).not.toContain('heater');
    expect(result.description_en).toContain('refrigerator');
    const confirmed = sanitizeListingFacts(model, '3 bathrooms with hot water. Studio $220/month.')!;
    expect(confirmed.discovered_amenities).toContain('hot_water_heater');
    expect(confirmed.description_en).toContain('hot water heater');
  });

  test('fully furnished does not establish a refrigerator or washing machine', () => {
    const alleged = { ...candidate, discovered_amenities: ['refrigerator', 'washing_machine', 'balcony'] };
    const source = 'Villa: 2 bedrooms, 3 bathrooms. Fully furnished. Balcony, parking. Rent $350/month.';
    expect(sanitizeListingFacts(alleged, source)?.discovered_amenities).toEqual(['balcony']);
    const explicit = `${source} Includes a fridge and washing machine.`;
    expect(sanitizeListingFacts(alleged, explicit)?.discovered_amenities).toEqual(['refrigerator', 'washing_machine', 'balcony']);
    const khmer = `${source} ទូទឹកកក និង ម៉ាស៊ីនបោកខោអាវ`;
    expect(sanitizeListingFacts(alleged, khmer)?.discovered_amenities).toEqual(['refrigerator', 'washing_machine', 'balcony']);
  });

  test('a generic kitchen does not establish a western kitchen', () => {
    const alleged = { ...candidate, discovered_amenities: ['western_kitchen'] };
    expect(sanitizeListingFacts(alleged, 'Villa with kitchen and private balcony.')?.discovered_amenities).toEqual([]);
    expect(sanitizeListingFacts(alleged, 'Villa with Western-style kitchen.')?.discovered_amenities).toEqual(['western_kitchen']);
  });
});
