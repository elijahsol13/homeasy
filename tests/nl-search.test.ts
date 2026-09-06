import { createDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { FiltersRepository, MAX_USER_FILTERS } from '../src/database/repositories/filters.repo';
import { PropertiesRepository } from '../src/database/repositories/properties.repo';
import { UsersRepository } from '../src/database/repositories/users.repo';
import { NLSearchService } from '../src/services/nl-search.service';
import fs from 'fs';
import path from 'path';

describe('Natural Language Search & Guardrails Engine', () => {
  let db: any;
  let filtersRepo: FiltersRepository;
  let propertiesRepo: PropertiesRepository;
  let usersRepo: UsersRepository;
  const testDbPath = ':memory:';

  beforeAll(() => {
    db = createDatabase(testDbPath);
    runMigrations(db);
    filtersRepo = new FiltersRepository(db);
    propertiesRepo = new PropertiesRepository(db);
    usersRepo = new UsersRepository(db);
  });

  describe('User Filter Cap Enforcement (MAX_USER_FILTERS = 5)', () => {
    it('allows creating up to 5 active filters per user and strictly rejects the 6th', () => {
      const user = usersRepo.upsertUser(999888, 'nl_tester');
      const testUserId = user.id;

      // Clean existing
      filtersRepo.deactivateAllUserFilters(testUserId);
      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(0);

      // Create 5 active filters
      for (let i = 1; i <= MAX_USER_FILTERS; i++) {
        const filter = filtersRepo.createFilter({
          user_id: testUserId,
          type: 'rent',
          category: 'apartment',
          city: 'siem_reap',
          min_price: 20000,
          max_price: 50000 + i * 5000,
          bedrooms: [1],
          requires_pool: false,
          min_lease_preferred: 6,
          locations: ['Wat Bo'],
        });
        expect(filter.id).toBeGreaterThan(0);
      }

      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(MAX_USER_FILTERS);

      // 6th filter must throw error
      expect(() => {
        filtersRepo.createFilter({
          user_id: testUserId,
          type: 'rent',
          category: 'apartment',
          city: 'siem_reap',
          min_price: 30000,
          max_price: 60000,
          bedrooms: [2],
          requires_pool: true,
          min_lease_preferred: 12,
          locations: ['Sala Kamreuk'],
        });
      }).toThrow(/Filter limit reached/);

      // Deactivate one filter, now count should be 4 and we can create another
      const activeFilters = filtersRepo.getUserActiveFilters(testUserId);
      expect(activeFilters.length).toBe(5);
      filtersRepo.deactivateFilter(activeFilters[0]!.id, testUserId);
      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(4);

      const newFilter = filtersRepo.createFilter({
        user_id: testUserId,
        type: 'rent',
        category: 'house',
        city: 'siem_reap',
        min_price: 40000,
        max_price: 80000,
        bedrooms: [3],
        requires_pool: true,
        min_lease_preferred: null,
        locations: [],
      });
      expect(newFilter.id).toBeGreaterThan(0);
      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(5);
    });
  });

  describe('Map Bounding Box with Overscan Buffer', () => {
    it('filters map markers within coordinates bounding box plus 20% overscan', () => {
      // Insert property in Siem Reap center (~13.36, 103.86)
      const propInBounds = propertiesRepo.insertProperty({
        hash: 'test_hash_sr_center',
        title: 'Centrally Located Studio',
        description: 'Near Pub Street',
        price: 30000,
        currency: 'USD',
        type: 'rent',
        category: 'apartment',
        bedrooms: 1,
        bathrooms: 1,
        deposit: 30000,
        min_lease: 6,
        has_pool: false,
        city: 'siem_reap',
        location: 'Svay Dangkum',
        maps_url: null,
        source_url: null,
        photos: [],
        direct_contact: {},
        latitude: 13.355,
        longitude: 103.855,
        original_url: 'https://example.com/p1',
      });

      // Insert property in Phnom Penh (~11.55, 104.92)
      propertiesRepo.insertProperty({
        hash: 'test_hash_pp_center',
        title: 'Phnom Penh Condo',
        description: 'BKK1 luxury condo',
        price: 80000,
        currency: 'USD',
        type: 'rent',
        category: 'apartment',
        bedrooms: 2,
        bathrooms: 2,
        deposit: 80000,
        min_lease: 12,
        has_pool: true,
        city: 'phnom_penh',
        location: 'BKK1',
        maps_url: null,
        source_url: null,
        photos: [],
        direct_contact: {},
        latitude: 11.552,
        longitude: 104.928,
        original_url: 'https://example.com/p2',
      });

      // Query map markers with Siem Reap bounds
      const markers = propertiesRepo.getPropertiesForMap('siem_reap', {
        bounds: {
          minLat: 13.34,
          maxLat: 13.37,
          minLng: 103.84,
          maxLng: 103.87,
          paddingRatio: 0.2,
        },
      });

      expect(markers.length).toBeGreaterThanOrEqual(1);
      const ids = markers.map((m) => m.id);
      expect(ids).toContain(propInBounds.id);
    });
  });

  describe('NLSearchService Fallback and Query Handling', () => {
    it('returns structured rejection for empty input or unconfigured API key gracefully', async () => {
      const service = new NLSearchService(propertiesRepo);
      const emptyRes = await service.parseQuery({});
      expect(emptyRes.is_real_estate_query).toBe(false);
      expect(emptyRes.rejection_reason).toBeDefined();
    });
  });
});
