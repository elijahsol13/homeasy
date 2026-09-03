import { createContainer, type AppContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import type { Property } from '../src/database/repositories/properties.repo';

describe('Matching Engine', () => {
  let container: AppContainer;
  let testUserId: number;
  const testTelegramId = 999888777;

  beforeAll(() => {
    container = createContainer({ dbPath: ':memory:' });
    runMigrations(container.db);
    const user = container.usersRepo.upsertUser(testTelegramId, 'matcher_tester');
    testUserId = user.id;
  });

  test('matches property against category, pool, and lease filters', () => {
    // User wants an apartment in Siem Reap with pool and short term lease
    const filter = container.filtersRepo.createFilter({
      user_id: testUserId,
      type: 'rent',
      city: 'siem_reap',
      category: 'apartment',
      requires_pool: true,
      min_lease_preferred: 5, // short-term <= 5 mos
      locations: ['Svay Dangkum'],
      min_price: 200,
      max_price: 800,
      bedrooms: 1,
    });

    const matchingProperty: Property = {
      id: 101,
      hash: 'test101',
      title: 'Modern 1BR Apartment in Svay Dangkum with Pool',
      description: 'Clean apartment with pool access.',
      price: 35000, // $350 in cents
      currency: 'USD',
      type: 'rent',
      category: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      deposit: 35000,
      min_lease: 3, // 3 months <= 5 months
      has_pool: true,
      location: 'Svay Dangkum',
      city: 'siem_reap',
      maps_url: null,
      source_url: null,
      photos: [],
      image_phash: null,
      image_phashes: [],
      direct_contact: { phone: '+85512345678' },
      original_url: '',
      reports_count: 0,
      is_active: 1,
      parsed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const matches = container.matcherService.matchProperty(matchingProperty);
    const userMatched = matches.some((m) => m.telegramId === testTelegramId);
    expect(userMatched).toBe(true);

    // Now test a property without pool (should NOT match)
    const noPoolProperty: Property = {
      ...matchingProperty,
      id: 102,
      has_pool: false,
    };
    const noPoolMatches = container.matcherService.matchProperty(noPoolProperty);
    const noPoolUserMatched = noPoolMatches.some((m) => m.telegramId === testTelegramId && m.filterId === filter.id);
    expect(noPoolUserMatched).toBe(false);

    // Test a property with 12 months minimum lease (should NOT match short-term filter)
    const longLeaseProperty: Property = {
      ...matchingProperty,
      id: 103,
      min_lease: 12,
    };
    const longLeaseMatches = container.matcherService.matchProperty(longLeaseProperty);
    const longLeaseUserMatched = longLeaseMatches.some((m) => m.telegramId === testTelegramId && m.filterId === filter.id);
    expect(longLeaseUserMatched).toBe(false);

    // Test a deactivated / reported property (should NOT match)
    const deactivatedProperty: Property = {
      ...matchingProperty,
      id: 104,
      is_active: 0,
    };
    const deactMatches = container.matcherService.matchProperty(deactivatedProperty);
    expect(deactMatches.length).toBe(0);
  });

  test('matches property against multi-bedroom filter (e.g. 1 and 2 BR)', () => {
    const multiBedFilter = container.filtersRepo.createFilter({
      user_id: testUserId,
      type: 'rent',
      city: 'siem_reap',
      category: null,
      requires_pool: false,
      min_lease_preferred: null,
      locations: [],
      min_price: null,
      max_price: null,
      bedrooms: [1, 2], // 1 BR OR 2 BR
    });

    const prop1BR: Property = {
      id: 201,
      hash: 'test201',
      title: 'Cozy 1BR',
      description: '',
      price: 30000,
      currency: 'USD',
      type: 'rent',
      category: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      deposit: null,
      min_lease: null,
      has_pool: false,
      location: 'Slor Kram',
      city: 'siem_reap',
      maps_url: null,
      source_url: null,
      photos: [],
      image_phash: null,
      image_phashes: [],
      direct_contact: {},
      original_url: '',
      reports_count: 0,
      is_active: 1,
      parsed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const prop2BR: Property = { ...prop1BR, id: 202, bedrooms: 2 };
    const prop3BR: Property = { ...prop1BR, id: 203, bedrooms: 3 };
    const propStudio: Property = { ...prop1BR, id: 204, bedrooms: 0 };

    expect(container.matcherService.propertyMatchesFilter(prop1BR, multiBedFilter)).toBe(true);
    expect(container.matcherService.propertyMatchesFilter(prop2BR, multiBedFilter)).toBe(true);
    expect(container.matcherService.propertyMatchesFilter(prop3BR, multiBedFilter)).toBe(false);
    expect(container.matcherService.propertyMatchesFilter(propStudio, multiBedFilter)).toBe(false);
  });
});
