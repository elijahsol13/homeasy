import { extractDeterministicMetadata } from '../src/modules/parser/deterministic-metadata';

describe('extractDeterministicMetadata', () => {
  it('normalizes and deduplicates contact identifiers deterministically', () => {
    const identifiers = extractDeterministicMetadata([
      'Phone: 012 345 678; +855 12 345 678',
      'Telegram: @OwnerName, https://t.me/ownername',
      'WhatsApp: 012 345 678',
      'Email: Owner@Example.com',
    ].join('\n'));
    expect(identifiers).toEqual(expect.arrayContaining([
      { type: 'PHONE', rawValue: '012 345 678', normalizedValue: '+85512345678' },
      { type: 'TELEGRAM', rawValue: '@ownername', normalizedValue: '@ownername' },
      { type: 'WHATSAPP', rawValue: '012 345 678', normalizedValue: '+85512345678' },
      { type: 'EMAIL', rawValue: 'Owner@Example.com', normalizedValue: 'owner@example.com' },
    ]));
    expect(identifiers.filter((item) => item.type === 'PHONE')).toHaveLength(1);
    expect(identifiers.filter((item) => item.type === 'TELEGRAM')).toHaveLength(1);
  });

  it('extracts labeled codes and maps place IDs, but ignores unlabeled code-like text', () => {
    const identifiers = extractDeterministicMetadata([
      'Reference note ABC123 should not become a property code.',
      'Property code: HS-204',
      'Agency ID: AGENT7',
      'https://www.google.com/maps/search/?api=1&query_place_id=ChIJ12345678901234567890',
    ].join('\n'));
    expect(identifiers).toEqual(expect.arrayContaining([
      { type: 'PROPERTY_CODE', rawValue: 'HS-204', normalizedValue: 'HS-204' },
      { type: 'AGENCY_CODE', rawValue: 'AGENT7', normalizedValue: 'AGENT7' },
      expect.objectContaining({ type: 'MAPS_PLACE_ID', normalizedValue: 'ChIJ12345678901234567890' }),
    ]));
    expect(identifiers.some((item) => item.normalizedValue === 'ABC123')).toBe(false);
  });
});
