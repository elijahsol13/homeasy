import { sourceListingFacts } from '../src/modules/parser/source-listing-facts';

describe('recover missing source-backed listing facts', () => {
  it.each([
    ['Beautiful 04-Bedroom Villa for Rent in Siem Reap\nBedroom: 04\nBathroom: 05',
      { category: 'house', property_type: 'Private Villa', bedrooms: 4, bathrooms: 5, city: 'siem_reap' }],
    ['1-BEDROOM APARTMENT FOR RENT IN SVAY DANGKUM, SIEM REAP\nLocation: Siem Reap\n1 Bedroom\n1 Bathroom',
      { category: 'apartment', property_type: 'Apartment', bedrooms: 1, bathrooms: 1, city: 'siem_reap' }],
    ['ផ្ទះវិឡាសម្រាប់ជួល\n- តម្លៃ 300$/ខែ\n- បន្ទប់គេង 02\n- បន្ទប់ទឹក 01\nទីតាំង ស្វាយដង្គំ ក្រុងសៀមរាប\n- villa for rent',
      { category: 'house', property_type: 'Private Villa', bedrooms: 2, bathrooms: 1, city: 'siem_reap' }],
    ['Traditional Khmer-Style House for Rent in Siem Reap\n2 Bedrooms',
      { category: 'house', property_type: 'Private House', bedrooms: 2, city: 'siem_reap' }],
  ])('restores only supported evidence from the original: %s', (source, expected) => {
    expect(sourceListingFacts({}, source)).toMatchObject(expected);
  });

  it('keeps mixed sale/rent and multiple property types for review', () => {
    expect(sourceListingFacts({}, 'Villa for sale and apartment for rent in Siem Reap'))
      .not.toHaveProperty('category');
    expect(sourceListingFacts({}, 'Villa for rent\nApartment for rent in Siem Reap'))
      .not.toHaveProperty('property_type');
  });

  it('does not invent categories from agency descriptions or proximity text', () => {
    expect(sourceListingFacts({}, 'Agency office: Siem Reap\nWe handle villas and apartments.'))
      .toEqual({});
    expect(sourceListingFacts({}, 'Walking distance to a house for rent exhibition.'))
      .not.toHaveProperty('category');
  });

  it('preserves AI facts and does not infer conflicting original room counts', () => {
    expect(sourceListingFacts({ listingExtraction: {
      category: 'apartment', property_type: 'Apartment', bedrooms: 3, bathrooms: 1,
    } }, 'Villa for rent\n2 bedrooms\n3 bedrooms\n2 bathrooms'))
      .toMatchObject({ category: 'apartment', property_type: 'Apartment', bedrooms: 3, bathrooms: 1 });
    const facts = sourceListingFacts({}, 'Villa for rent\n2 bedrooms\n3 bedrooms\n1 bathroom');
    expect(facts).not.toHaveProperty('bedrooms');
    expect(facts).toMatchObject({ category: 'house', bathrooms: 1 });
  });
});
