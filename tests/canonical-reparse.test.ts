jest.mock('../src/modules/parser/canonical-listing-extractor', () => ({
  extractCanonicalListingsBatch: jest.fn(),
}));

import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { normalizeRawToClean } from '../src/modules/parser/ingestor';
import { RawListingSchema } from '../src/modules/parser/schemas';
import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { extractCanonicalListingsBatch } from '../src/modules/parser/canonical-listing-extractor';
import { reparseCanonicalListings } from '../src/modules/parser/canonical-reparse';

const mockedExtract = extractCanonicalListingsBatch as jest.Mock;

test('canonical reparse previews without writes and never converts rejected posts to sale', async () => {
  const container = createContainer({ dbPath: ':memory:' });
  try {
    runMigrations(container.db);
    const clean = normalizeRawToClean(RawListingSchema.parse({
      title: 'Room for rent', description: 'Room for rent $250/month', price: 250,
      currency: 'USD', type: 'rent', category: 'room', city: 'siem_reap',
      source_url: 'https://example.com/reparse-1', photos: [], is_real_estate: true,
    }))!;
    const property = container.propertiesRepo.insertProperty({ ...clean, hash: 'reparse-test' });
    const facts = sanitizeListingFacts({
      is_supported_listing: false, rejection_reason: 'Nightly accommodation',
      title_en: 'Room', description_en: '', price: null, currency: null, city: 'Siem Reap',
    }, 'Room $20/night')!;
    mockedExtract.mockResolvedValue(new Map([[property.id, facts]]));

    expect(await reparseCanonicalListings(container.db, { limit: 1 })).toEqual({
      extracted: 1, updated: 0, needsReview: 1,
    });
    expect(container.propertiesRepo.getPropertyById(property.id)?.listing_facts_json).toBeNull();

    expect(await reparseCanonicalListings(container.db, { limit: 1, apply: true })).toEqual({
      extracted: 1, updated: 1, needsReview: 1,
    });
    const saved = container.propertiesRepo.getPropertyById(property.id)!;
    expect(saved.listing_facts_json).toBe(JSON.stringify(facts));
    expect(saved.type).toBe('rent');
    expect(saved.is_active).toBe(1);
  } finally {
    container.db.close();
  }
});
