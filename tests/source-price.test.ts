import { parseSourceListingPrice, sourceMonthlyPrices } from '../src/modules/parser/source-price';

describe('source price extraction', () => {
  it('keeps monthly rent separate from electricity and water charges', () => {
    const original = [
      'Beautiful Apartment for Rent in Siem Reap – Svay Dangkum.',
      'Single Bed – $300/month.',
      'Electricity Price: 0.25$/KWh.',
      'Water Supply: $80/Month (Person).',
    ].join('\n');

    expect(parseSourceListingPrice(original)).toEqual({ price: 300, currency: 'USD' });
    expect(sourceMonthlyPrices(original)).toEqual([300]);
  });

  it('does not interpret utility rates as the advertised rent', () => {
    const original = 'Electricity Price: 0.25$/KWh.\nWater Supply: $80/Month (Person).';

    expect(parseSourceListingPrice(original)).toBeNull();
    expect(sourceMonthlyPrices(original)).toEqual([]);
  });

  it.each([
    ['369USD/ Villa per month', 369],
    ['ផ្ទះជួល មួយខែ 300$', 300],
    ['ផ្ទះ​ជួល​មួយ\u200bខែ300$ចរចារ', 300],
    ['house for rent, one month 300$', 300],
  ])('extracts explicit rent syntax from source: %s', (original, expected) => {
    expect(parseSourceListingPrice(original)).toEqual({ price: expected, currency: 'USD' });
    expect(sourceMonthlyPrices(original)).toEqual([expected]);
  });

  it('still excludes a utility tariff when a duration phrase appears nearby', () => {
    const original = 'Electricity: one month 300$/kWh';
    expect(parseSourceListingPrice(original)).toBeNull();
    expect(sourceMonthlyPrices(original)).toEqual([]);
  });

  it('recognizes Khmer per-one-month rates and preserves distinct lease tiers', () => {
    const original = '119$/ក្នុង1ខែ (12-month contract) 129$/ក្នុង1ខែ (under 12 months)';
    expect(parseSourceListingPrice(original)).toEqual({ price: 119, currency: 'USD' });
    expect(sourceMonthlyPrices(original)).toEqual([119, 129]);
  });
});
