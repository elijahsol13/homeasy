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

  it.each([
    ['House for rent - Price 300$ - Bedroom 02 - Bathroom 03', 300],
    ['Villa for rent - Price: $300 - Bedroom 02 - Bathroom 02', 300],
    ['villa for rent - Price : 300$ - Bedroom 02 - Bathroom 02', 300],
    ['អាផាតមិនសម្រាប់ជួល\n💰 ថ្លៃឈ្នួល: $450 👉 ថ្លៃកក់: 01 (មួយខែ)', 450],
    ['ផ្ទះជួល\nថ្លៃ\u200bឈ្នួល\u200b: $400\nថ្លៃកក់: 01 (មួយខែ)\nថ្លៃភ្លើង: 1,000 KHR/KWh', 400],
  ])('recognizes source-labelled rent without /month: %s', (original, expected) => {
    expect(parseSourceListingPrice(original)).toEqual({ price: expected, currency: 'USD' });
    expect(sourceMonthlyPrices(original)).toEqual([expected]);
  });

  it.each([350, 250, 450])('reads a Markdown-bold monthly rent of $%s from the original listing', (expected) => {
    const original = `Apartment for rent in Siem Reap.\nMonthly Rent: **$${expected}**\nElectricity: $0.25/kWh`;
    expect(parseSourceListingPrice(original)).toEqual({ price: expected, currency: 'USD' });
    expect(sourceMonthlyPrices(original)).toEqual([expected]);
  });

  it('keeps Markdown-bold utility and deposit prices out of rent evidence', () => {
    const original = 'Apartment for rent\nMonthly Rent: **$350**\nElectricity: **$80**/month\nDeposit: **$350**';
    expect(sourceMonthlyPrices(original)).toEqual([350]);
    expect(sourceMonthlyPrices('Apartment for rent\nDeposit: **$350**\nElectricity: **$80**/month')).toEqual([]);
    expect(sourceMonthlyPrices('Apartment for sale\nSale Price: **$70,000**')).toEqual([]);
  });

  it('preserves both contradictory Markdown-bold monthly rents for review', () => {
    const original = 'Apartment for rent\nMonthly Rent: **$350**\nMonthly Rent: **$450**';
    expect(sourceMonthlyPrices(original)).toEqual([350, 450]);
  });

  it('does not promote an unlabeled sale price, a deposit or a utility charge into rent', () => {
    for (const original of [
      'House for sale - Price $300',
      'Price $300',
      'House for rent - Deposit $450',
      'House for rent - Electricity Price: $80/kWh',
    ]) {
      expect(sourceMonthlyPrices(original)).toEqual([]);
    }
  });

  it('retains multiple rent price labels as a conflict rather than picking one', () => {
    expect(sourceMonthlyPrices('Rooms for rent - Price $400 for one room - Price $500 for another room'))
      .toEqual([400, 500]);
    expect(sourceMonthlyPrices('House for rent - Price $350; House for sale - Sale Price $70,000'))
      .toEqual([350]);
  });

  it('does not carry a for-rent heading across unrelated distant price text', () => {
    const unrelated = 'Villa for rent in Siem Reap. ' + 'Features and nearby places. '.repeat(20)
      + '\nPrice $600 (unrelated classified post).';
    expect(sourceMonthlyPrices(unrelated)).toEqual([]);
    expect(parseSourceListingPrice(unrelated)).toBeNull();
  });

  it('does not promote a deposit label into rental price even when phrased as Price', () => {
    const original = 'House for rent. Deposit: Price $450.';
    expect(sourceMonthlyPrices(original)).toEqual([]);
    expect(parseSourceListingPrice(original)).toBeNull();
  });

  it('keeps Asking Price separate from labelled monthly rent evidence', () => {
    expect(sourceMonthlyPrices('Apartment for rent in Siem Reap. Asking Price: $450.')).toEqual([]);
  });
});
