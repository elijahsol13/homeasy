import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { toLegacyListingExtraction } from '../src/modules/parser/canonical-listing-adapter';
import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { normalizeRawToClean } from '../src/modules/parser/ingestor';
import { RawListingSchema } from '../src/modules/parser/schemas';

const source = 'Long term studio near Pub Street, $250/month. EDC state rate.';
const facts = sanitizeListingFacts({
  is_supported_listing: true,
  title_en: 'Studio Near Pub Street',
  description_en: 'Long term rental.',
  price: 250,
  currency: 'USD',
  property_type: 'Studio',
  city: null,
  sangkat: null,
  explicit_location: null,
  marketing_landmarks: ['near Pub Street'],
  min_lease_months: null,
  lease_term_text: 'long term',
  electricity_type: 'state_rate',
  electricity_rate: null,
}, source)!;

describe('canonical facts → legacy projection', () => {
  test('drops an AI-invented bedroom count and its generated description claim when the original says none', () => {
    const ungrounded = sanitizeListingFacts({
      is_supported_listing: true,
      title_en: '5 Bedroom Shophouse',
      description_en: 'A five-bedroom shophouse is available. Suitable for office use.',
      price: 500,
      currency: 'USD',
      property_type: 'Flat House',
      city: 'Siem Reap',
      bedrooms: 5,
      bathrooms: 2,
    }, 'Shophouse for rent in Siem Reap, Svay Dangkum. $500/month. Office use allowed.')!;

    expect(ungrounded).toMatchObject({
      bedrooms: null,
      bathrooms: null,
      title_en: 'Shophouse',
      description_en: 'A shophouse is available. Suitable for office use.',
    });
  });

  test('reconciles a generated room count against a written count in the source', () => {
    const facts = sanitizeListingFacts({
      is_supported_listing: true,
      title_en: 'Five Bedroom Villa',
      description_en: 'The villa has 5 bedrooms. It has a garden.',
      price: 500,
      currency: 'USD',
      property_type: 'Private Villa',
      city: 'Siem Reap',
      bedrooms: 5,
    }, 'Two bedrooms villa for rent in Siem Reap. $500/month.')!;

    expect(facts).toMatchObject({ bedrooms: 2, title_en: '2 Bedroom Villa',
      description_en: 'The villa has 2 bedrooms. It has a garden.' });
  });

  test('preserves uncertainty and does not invent a lease, tariff or address', () => {
    const body = 'House for rent. Please contact us for details.';
    const raw = { title_en: 'Three Bedroom House', description_en: 'The house has three bedrooms.', bedrooms: 3 };
    expect(sanitizeListingFacts(raw, body, { platform_bedrooms: '3' }))
      .toMatchObject({ bedrooms: 3, title_en: '3 Bedroom House' });
    expect(sanitizeListingFacts({ ...raw, bedrooms: 2 }, body, { platform_bedrooms: '3' }))
      .toMatchObject({ bedrooms: null, title_en: 'House' });
    expect(sanitizeListingFacts(raw, body)).toMatchObject({ bedrooms: null });
    const legacy = toLegacyListingExtraction(facts);
    expect(legacy.min_lease).toBeNull();
    expect(legacy.electricity).toBe('EDC (State Rate)');
    expect(legacy.location).toBeNull();
    expect(legacy.canonical_facts.lease_term_text).toBe('long term');
    expect(legacy.canonical_facts.electricity_rate).toBeNull();
    expect(legacy.canonical_facts.city).toBeNull();

    const clean = normalizeRawToClean(RawListingSchema.parse({
      title: legacy.title_en, description: legacy.description_en, price: legacy.price,
      currency: legacy.currency, type: 'rent', category: legacy.category,
      property_type: legacy.property_type, city: 'siem_reap',
      raw_text: source, source_url: 'https://example.com/1', photos: [],
      electricity: legacy.electricity ?? undefined,
      listing_facts_json: JSON.stringify(facts), is_real_estate: true,
    }))!;
    expect(clean.min_lease).toBeNull();
    expect(clean.location).toBe('');
    expect(clean.electricity).toBe('EDC (State Rate)');
    expect(clean.listing_facts_json).toBe(JSON.stringify(facts));
  });

  test('does not pass a price with unknown currency into legacy columns', () => {
    const unknownCurrency = { ...facts, currency: null };
    expect(toLegacyListingExtraction(unknownCurrency).price).toBeNull();
    expect(toLegacyListingExtraction(unknownCurrency).canonical_facts.price).toBe(250);
  });

  test('keeps explicitly extracted state tariffs in legacy card fields', () => {
    const withRates = { ...facts, electricity_rate: '0.20 USD/kWh', water_type: 'state_rate' as const,
      water_rate: '1000 KHR/m3' };
    const legacy = toLegacyListingExtraction(withRates);
    expect(legacy.electricity).toBe('EDC (State Rate) (0.20 USD/kWh)');
    expect(legacy.water).toBe('State Rate (1000 KHR/m3)');
  });

  test('clean monetary and room columns honor canonical facts over stale raw fields', () => {
    const clean = normalizeRawToClean(RawListingSchema.parse({
      title: 'House', description: 'House for rent.', price: 900, currency: 'USD',
      bedrooms: 5, bathrooms: 4, city: 'siem_reap', type: 'rent',
      listing_facts_json: JSON.stringify({ ...facts, price: 250, currency: 'USD', bedrooms: 2, bathrooms: null }),
    }))!;
    expect(clean).toMatchObject({ price: 25000, bedrooms: 2, bathrooms: null });
  });

  test('clean monetary column never resurrects a canonical null price or missing currency', () => {
    for (const unknown of [{ price: null, currency: null }, { price: 250, currency: null }]) {
      const clean = normalizeRawToClean(RawListingSchema.parse({
        title: 'House', description: 'House for rent.', price: 900, currency: 'USD',
        city: 'siem_reap', type: 'rent', listing_facts_json: JSON.stringify({ ...facts, ...unknown }),
      }))!;
      expect(clean.price).toBe(0);
    }
  });

  test('stores full facts in the property row', () => {
    const container = createContainer({ dbPath: ':memory:' });
    try {
      runMigrations(container.db);
      const clean = normalizeRawToClean(RawListingSchema.parse({
        title: 'Studio', description: source, price: 250, currency: 'USD',
        type: 'rent', category: 'apartment', city: 'siem_reap',
        source_url: 'https://example.com/canonical-1', photos: [],
        is_real_estate: true, listing_facts_json: JSON.stringify(facts),
      }))!;
      const inserted = container.propertiesRepo.insertProperty({ ...clean, hash: 'canonical-test' });
      expect(container.propertiesRepo.getPropertyById(inserted.id)?.listing_facts_json)
        .toBe(JSON.stringify(facts));
    } finally {
      container.db.close();
    }
  });
});
