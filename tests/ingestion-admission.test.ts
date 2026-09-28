import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import type { AppContainer } from '../src/container';

describe('Ingestion admission gate', () => {
  let container: AppContainer;
  let id = 0;

  beforeAll(() => {
    container = createContainer({ dbPath: ':memory:' });
    runMigrations(container.db);
  });

  afterAll(() => {
    container.db.close();
  });

  function baseListing(overrides: Record<string, unknown> = {}) {
    id++;
    return {
      title: `Test House in Sla Kram #${id}`,
      description: 'Clean 2BR house',
      price: 400,
      currency: 'USD',
      type: 'rent' as const,
      category: 'house' as const,
      location: 'Sla Kram',
      city: 'siem_reap' as const,
      photos: ['https://example.com/photo.jpg'],
      url: `https://example.com/listing-${id}`,
      source_url: `https://example.com/listing-${id}`,
      ...overrides,
    };
  }

  test('stores uncertain is_real_estate as pending inactive', async () => {
    const result = await container.ingestionService.ingestRawListing(baseListing());
    expect(result.status).toBe('inserted');

    const prop = container.propertiesRepo.getPropertyById(result.propertyId!);
    expect(prop).toBeDefined();
    expect(prop?.review_status).toBe('pending');
    expect(prop?.is_active).toBe(0);
    expect(prop?.parse_warnings).toContain('is_real_estate_uncertain');
  });

  test('rejects LLM-confirmed non-real-estate', async () => {
    const result = await container.ingestionService.ingestRawListing(
      baseListing({ title: 'Used iPhone 14', is_real_estate: false, category: undefined }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/non-real-estate/i);
  });

  test('approves explicit is_real_estate true', async () => {
    const result = await container.ingestionService.ingestRawListing(baseListing({ is_real_estate: true }));
    expect(result.status).toBe('inserted');

    const prop = container.propertiesRepo.getPropertyById(result.propertyId!);
    expect(prop?.review_status).toBe('approved');
    expect(prop?.is_active).toBe(1);
  });

  test('converts deposit_months to amount using monthly rent', async () => {
    const result = await container.ingestionService.ingestRawListing(
      baseListing({ is_real_estate: true, deposit_months: 2 }),
    );
    expect(result.status).toBe('inserted');

    const prop = container.propertiesRepo.getPropertyById(result.propertyId!);
    // $400 * 2 months = $800 = 80000 cents
    expect(prop?.deposit).toBe(80000);
  });

  test('does not treat deposit_months as dollars when rent is missing', async () => {
    const result = await container.ingestionService.ingestRawListing(
      baseListing({ is_real_estate: true, price: undefined, deposit_months: 1 }),
    );
    expect(result.status).toBe('inserted');

    const prop = container.propertiesRepo.getPropertyById(result.propertyId!);
    expect(prop?.deposit).toBeNull();
    expect(prop?.parse_warnings).toContain('deposit_months_without_rent');
  });
});
