import { createHash } from 'node:crypto';
import { evaluateOfflineListing, summarizeOfflineListings } from '../src/modules/parser/listing-offline-evaluation';

const rawText = 'Apartment for rent. Bedrooms: 2, Bathrooms: 3. Rental Price: $450/month.';
const sourceSha256 = createHash('sha256').update(rawText).digest('hex');
const gold = { id: 110, source: 'Facebook' as const, sourceSha256,
  bedrooms: 2, bathrooms: 3, monthlyRentUsd: 450 };

describe('offline primary-source extraction evaluation', () => {
  test('attributes stored discrepancies to observable stages without claiming the model invented facts', () => {
    const result = evaluateOfflineListing(gold, { sourceType: 'FACEBOOK_GROUP', rawText,
      facts: { title_en: 'House', description_en: 'Old copy', bedrooms: 1, bathrooms: 1, price: 350, currency: 'USD' },
      bedrooms: 1, bathrooms: 1, priceCents: 45000, description: 'Old copy' });
    expect(result.bedrooms).toEqual({ expected: 2, detected: 2, storedFacts: 1,
      storedCard: 1, replaySanitized: 2, replayAdapter: 2 });
    expect(result.bathrooms.replayAdapter).toBe(3);
    expect(result.monthlyRent).toEqual({ expected: 450, storedFacts: 350,
      storedCard: 450, replaySanitized: 450, replayAdapter: 450 });
    expect(result.descriptionExactRaw).toBe(false);
    const totals = summarizeOfflineListings([result]);
    expect(totals.Facebook.bedrooms.card).toMatchObject({ corroborated: 1, contradicted: 1, missed: 0 });
    expect(totals.Facebook.bedrooms.replaySanitized.correct).toBe(1);
    expect(totals.Facebook.monthlyRent.storedFacts.contradicted).toBe(1);
    expect(totals.Facebook.monthlyRent.storedCard.correct).toBe(1);
  });

  test('keeps unverified facts outside the denominator for confirmed source values', () => {
    const other = 'Three storeys. No stated bedroom or bathroom count.';
    const result = evaluateOfflineListing({ id: 155, source: 'Khmer24', bedrooms: null,
      bathrooms: null, sourceSha256: createHash('sha256').update(other).digest('hex') },
    { sourceType: 'KHMER24', rawText: other, facts: { bedrooms: 3, bathrooms: null },
      bedrooms: 3, bathrooms: null, priceCents: null, description: other });
    const totals = summarizeOfflineListings([result]);
    expect(totals.Khmer24.bedrooms.card).toMatchObject({ corroborated: 0, unverified: 1, unknownPreserved: 0 });
    expect(totals.Khmer24.bathrooms.card).toMatchObject({ corroborated: 0, unverified: 0, unknownPreserved: 1 });
    expect(totals.Khmer24.descriptionExactRaw).toBe(1);
  });

  test('fails closed when a historical source, channel or snapshot hash changed', () => {
    expect(() => evaluateOfflineListing({ ...gold, sourceSha256: 'bad' },
      { sourceType: 'FACEBOOK_GROUP', rawText, facts: {}, bedrooms: null,
        bathrooms: null, priceCents: null, description: '' })).toThrow(/source snapshot mismatch/);
    expect(() => evaluateOfflineListing(gold,
      { sourceType: 'KHMER24', rawText, facts: {}, bedrooms: null,
        bathrooms: null, priceCents: null, description: '' })).toThrow(/source type mismatch/);
  });
});
