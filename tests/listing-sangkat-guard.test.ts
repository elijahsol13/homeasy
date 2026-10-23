import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';

const generated = {
  title_en: '3-Bedroom House in Sala Kram',
  description_en: 'A three-bedroom house in Sala Kram is available for rent.',
  property_type: 'Private House',
  category: 'house',
  bedrooms: 3,
  city: 'Siem Reap',
  sangkat: 'Sala Kram',
};

describe('administrative locality and property-type source guards', () => {
  it('preserves an explicit Sla Kram source over model-invented Sala Kram', () => {
    const source = '3-Bedroom Apartment in Sla Kram\nSla Kram, 5 minutes drive to Pub Street.';
    const result = sanitizeListingFacts(generated, source, { platform_location: 'Sla Kram, Siem Reap, Siem Reap' });
    expect(result).toMatchObject({ sangkat: 'Sla Kram', property_type: 'Apartment', category: 'apartment', bedrooms: 3 });
    expect(result?.title_en).not.toMatch(/sala kram|house/i);
    expect(result?.description_en).not.toMatch(/sala kram|house/i);
  });

  it("trusts the author's explicit sangkat ahead of contradictory platform metadata", () => {
    expect(sanitizeListingFacts({ ...generated, sangkat: 'Sala Kamreuk' },
      'House for rent in Sla Kram.', { platform_location: 'Sala Kamreuk, Siem Reap' })?.sangkat)
      .toBe('Sla Kram');
  });

  it('accepts an exact official platform sangkat only when author is silent', () => {
    expect(sanitizeListingFacts(generated, 'Private house for monthly rent.',
      { platform_location: 'Sangkat Sla Kram, Siem Reap' })?.sangkat).toBe('Sla Kram');
    expect(sanitizeListingFacts(generated, 'Private house for monthly rent.')?.sangkat).toBeNull();
  });

  it('refuses to promote landmarks, hybrid spelling, or contradictory authors to sangkat', () => {
    expect(sanitizeListingFacts({ ...generated, sangkat: 'Wat Bo' },
      'House near Wat Bo and Pub Street.')?.sangkat).toBeNull();
    expect(sanitizeListingFacts(generated,
      'House is described as being in Sla Kram and in Sala Kamreuk.')?.sangkat).toBeNull();
  });

  it('does not confuse the Khmer city name with Sangkat Siem Reap', () => {
    expect(sanitizeListingFacts(generated,
      'ផ្ទះសម្រាប់ជួលនៅក្រុងសៀមរាប (house for rent in Siem Reap city)')?.sangkat).toBeNull();
    expect(sanitizeListingFacts(generated,
      'House for rent in Sangkat Siem Reap, Krong Siem Reap')?.sangkat).toBe('Siem Reap');
  });

  it('keeps an explicitly described villa when generic source heading says house', () => {
    const villa = sanitizeListingFacts({ ...generated, property_type: 'Private Villa' },
      '5 Bedrooms House for Rent in Siem Reap\nFully furnished villa with private garden.');
    expect(villa?.property_type).toBe('Private Villa');
    expect(villa?.category).toBe('house');
  });

  it('retains an explicitly extracted studio subtype under an apartment source heading', () => {
    expect(sanitizeListingFacts({ ...generated, property_type: 'Studio' },
      'Apartment for rent\nSelf-contained studio with kitchenette.')?.property_type).toBe('Studio');
  });
});
