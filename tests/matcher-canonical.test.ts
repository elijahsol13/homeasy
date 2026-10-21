import { createContainer } from '../src/container';
import { env } from '../src/config/env';
import type { Property } from '../src/database/repositories/properties.repo';
import { runMigrations } from '../src/database/migrate';

describe('Canonical alert cohort routing', () => {
  it('uses canonical search for canaries while routing legacy notifications only to legacy users', async () => {
    const previousPath = env.LISTING_READ_PATH;
    const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
    const container = createContainer({ dbPath: ':memory:' });
    runMigrations(container.db);
    const canaryTelegramId = 920001;
    const legacyTelegramId = 920002;
    const canaryUser = container.usersRepo.upsertUser(canaryTelegramId, 'canary');
    const legacyUser = container.usersRepo.upsertUser(legacyTelegramId, 'legacy');
    const filterInput = {
      type: 'rent' as const, city: 'siem_reap' as const,
      category: null, requires_pool: false, min_lease_preferred: null,
      locations: [], min_price: null, max_price: null, bedrooms: null,
    };
    const canaryFilter = container.filtersRepo.createFilter({ ...filterInput, user_id: canaryUser.id });
    const legacyFilter = container.filtersRepo.createFilter({ ...filterInput, user_id: legacyUser.id });
    const legacy = {
      id: 1, title: 'Legacy unit', type: 'rent', city: 'siem_reap',
      location: 'Center', category: 'apartment', price: 20000,
      bedrooms: 1, min_lease: null, has_pool: false, is_active: 1,
    } as Property;
    const canonical = { ...legacy, id: 1, title: 'Canonical unit', public_listing_ref: `lst_${'f'.repeat(32)}` };
    const getRecent = jest.spyOn(container.propertiesRepo, 'getRecentProperties').mockReturnValue([legacy]);
    const getCanonical = jest.spyOn(container.canonicalListingRepo, 'searchProperties').mockReturnValue({ items: [canonical], total: 1 });
    const dispatch = jest.spyOn(container.notifierService, 'dispatchNotification').mockImplementation(() => {});
    try {
      env.LISTING_READ_PATH = 'legacy';
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [canaryTelegramId];

      expect(container.matcherService.findMatchingPropertiesForFilter(canaryFilter, 3, 0, canaryTelegramId)
        .properties[0]?.public_listing_ref).toBe(canonical.public_listing_ref);
      expect(container.matcherService.findMatchingPropertiesForFilter(legacyFilter, 3, 0, legacyTelegramId)
        .properties[0]?.public_listing_ref).toBeUndefined();
      expect(getCanonical).toHaveBeenCalledWith({ city: 'siem_reap', type: 'rent', limit: 500 });
      expect(getRecent).toHaveBeenCalled();

      await container.matcherService.matchAndNotify(legacy);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(legacyTelegramId, legacy);

      dispatch.mockClear();
      await container.matcherService.matchAndNotify(canonical);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      env.LISTING_READ_PATH = previousPath;
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
      container.db.close();
    }
  });
});
