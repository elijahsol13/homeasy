import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';

describe('explicit author monthly rent wins over stale or fabricated model values', () => {
  const model = { is_supported_listing: true, title_en: 'House for rent', description_en: 'House for rent.',
    price: 350, currency: 'USD', property_type: 'Private House' };

  test.each([
    ['Rental Price: $450/Month', 450],
    ['Price: $220/month (negotiable)', 220],
    ['Rental Price: USD 400 / month', 400],
    ['Monthly rent: 380 USD', 380],
  ])('uses author rent in %s', (text, expected) => {
    expect(sanitizeListingFacts(model, `House for rent.\n${text}\nWater: $10/Month (pax)`))
      .toMatchObject({ price: expected, currency: 'USD' });
  });

  test('retains model price when monthly amount is not explicitly recognizable', () => {
    expect(sanitizeListingFacts(model, 'House for rent. Deposit $700. Water: $5/month.')?.price).toBe(350);
  });

  test('retains a labelled rent when water is mentioned later on the same line', () => {
    expect(sanitizeListingFacts(model, 'Price: $450/month. Water price: $5/month. Electricity: $0.25/kWh.'))
      .toMatchObject({ price: 450, currency: 'USD' });
  });

  test('ignores a water price before the rental price on the same line', () => {
    expect(sanitizeListingFacts(model, 'Water price: $5/month; Rental Price: $600/month.'))
      .toMatchObject({ price: 600, currency: 'USD' });
  });

  test('supports rent amount followed by the currency', () => {
    expect(sanitizeListingFacts(model, 'Rental Price: 450 USD/month'))
      .toMatchObject({ price: 450, currency: 'USD' });
  });

  test('does not choose a price when the author advertises two conflicting monthly rents', () => {
    const source = 'House for rent. Rental Price: $450/month furnished. Rental Price: $380/month unfurnished.';
    expect(sanitizeListingFacts(model, source)).toMatchObject({ price: null, currency: null });
  });

  test('preserves null for absent model rent even when an explicit author rent is found', () => {
    expect(sanitizeListingFacts({ ...model, price: null }, 'House for rent. Rental Price: $450/month'))
      .toMatchObject({ price: 450, currency: 'USD' });
  });
});
