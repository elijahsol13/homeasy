import { extractFacebookPropertyCode, facebookRepostCodeKey } from '../src/modules/parser/facebook-repost-key';
import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { sourceRoomCounts } from '../src/modules/parser/source-room-counts';
import { parseSourceListingPrice } from '../src/modules/parser/source-price';

describe('Facebook source identities and independent advertised facts', () => {
  test('extracts the actual identifier after Original ID Number rather than the word Number', () => {
    expect(extractFacebookPropertyCode('Original ID Number: SR – 00158KN')).toBe('sr00158kn');
    expect(extractFacebookPropertyCode('Original ID Number: SR - 00041KNB')).toBe('sr00041knb');
    expect(extractFacebookPropertyCode('Original ID Number: unknown')).toBeNull();
  });

  test('keeps different apartments separate even when their marketing template is identical', () => {
    const listingA = 'Original ID Number: SR – 00158KN; 1 bedroom, 1 bathroom, $350/month';
    const listingB = 'Original ID Number: SR – 00041KNB; 2 bedrooms, 3 bathrooms, $380/month';
    expect(facebookRepostCodeKey(listingA)).not.toBe(facebookRepostCodeKey(listingB));
    expect(facebookRepostCodeKey(listingA)).toContain('sr00158kn');
    expect(facebookRepostCodeKey(listingB)).toContain('beds:2|baths:3|usd:380');
  });

  test('keeps the six historical Estate View apartment codes in separate source clusters', () => {
    const originals = [
      { text: 'Original ID Number: SR – 00811KNA; 1 bedroom, 1 bathroom, $450/month', bedrooms: 1, bathrooms: 1, price: 450 },
      { text: 'Original ID Number: SR – 00285KNB; 2 bedrooms, 2 bathrooms, $550/month', bedrooms: 2, bathrooms: 2, price: 550 },
      { text: 'Original ID Number: SR – 00661KN; 1 bedroom, 1 bathroom, $350/month', bedrooms: 1, bathrooms: 1, price: 350 },
      { text: 'Original ID Number: SR – 00041KNB; 2 bedrooms, 3 bathrooms, $380/month', bedrooms: 2, bathrooms: 3, price: 380 },
      { text: 'Original ID Number: SR – 00158KN; 2 bedrooms, 2 bathrooms, $450/month', bedrooms: 2, bathrooms: 2, price: 450 },
      { text: 'Original ID Number: SR – 00749KNC; 2 bedrooms, 2 bathrooms, $600/month', bedrooms: 2, bathrooms: 2, price: 600 },
    ];

    expect(new Set(originals.map(original => facebookRepostCodeKey(original.text))).size).toBe(originals.length);
    for (const original of originals) {
      expect(sourceRoomCounts(original.text)).toMatchObject({
        bedrooms: original.bedrooms, bathrooms: original.bathrooms,
        conflictingBedrooms: false, conflictingBathrooms: false,
      });
      expect(parseSourceListingPrice(original.text)).toEqual({ price: original.price, currency: 'USD' });
    }
  });

  test('separates incompatible facts even when the agency repeats one code', () => {
    const id = 'Original ID Number: SR – 00158KN\n';
    expect(facebookRepostCodeKey(id + '1 bedroom, 1 bathroom, $350/month'))
      .not.toBe(facebookRepostCodeKey(id + '2 bedrooms, 2 bathrooms, $450/month'));
    expect(facebookRepostCodeKey(id + '2 bedrooms, 2 bathrooms, $450/month'))
      .toBe(facebookRepostCodeKey('Original ID Number: SR-00158KN\n2BR, 2 baths, $450/month'));
  });

  test('source explicit room numbers correct an inconsistent AI extraction and its title', () => {
    const original = 'Original ID Number: SR – 00041KNB\nBedroom 02\nBathroom 03';
    const result = sanitizeListingFacts({
      is_supported_listing: true, title_en: '1 Bedroom Villa', description_en: 'For rent',
      bedrooms: 1, bathrooms: 1, property_type: 'Private Villa', category: 'house',
    }, original);
    expect(result).toMatchObject({ bedrooms: 2, bathrooms: 3, title_en: '2 Bedroom Villa' });
  });
});
