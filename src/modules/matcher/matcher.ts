import type { FiltersRepository, SearchFilter } from '../../database/repositories/filters.repo';
import type { PropertiesRepository, Property } from '../../database/repositories/properties.repo';
import type { UsersRepository } from '../../database/repositories/users.repo';
import type { NotifierService } from '../../services/notifier';

// ─── Matching logic ───────────────────────────────────────────────────────────

/**
 * Returns true if a property satisfies all constraints in a search filter.
 */
export function propertyMatchesFilter(property: Property, filter: SearchFilter): boolean {
  // 1. Listing Type (rent / sale)
  if (filter.type !== property.type) return false;

  // 2. City
  if (filter.city !== property.city) return false;

  // 3. Category (Apartment / House / Room)
  if (filter.category && property.category && filter.category !== property.category) {
    return false;
  }

  // 4. Swimming Pool requirement
  if (filter.requires_pool && !property.has_pool) {
    return false;
  }

  // 5. Lease Term
  // filter.min_lease_preferred === 5 -> Short term (accepts listings with min_lease <= 5 or unstated)
  // filter.min_lease_preferred === 6 -> Long term (accepts listings with min_lease >= 6 or unstated)
  if (filter.min_lease_preferred !== null && property.min_lease !== null) {
    if (filter.min_lease_preferred === 5 && property.min_lease > 5) {
      return false;
    }
    if (filter.min_lease_preferred === 6 && property.min_lease < 6) {
      return false;
    }
  }

  // 6. Location (Districts / Sangkats)
  if (filter.locations.length > 0) {
    const propLocNorm = property.location.toLowerCase();
    const locationMatch = filter.locations.some(
      (loc) =>
        propLocNorm.includes(loc.toLowerCase()) || loc.toLowerCase().includes(propLocNorm),
    );
    if (!locationMatch) return false;
  }

  // 7. Price range (filter prices in USD dollars; property.price in USD cents)
  if (filter.min_price !== null && property.price < filter.min_price * 100) return false;
  if (filter.max_price !== null && property.price > filter.max_price * 100) return false;

  // 8. Bedrooms
  if (filter.bedrooms !== null && property.bedrooms !== null) {
    if (filter.bedrooms === 4) {
      if (property.bedrooms < 4) return false;
    } else {
      if (property.bedrooms !== filter.bedrooms) return false;
    }
  }

  return true;
}

export interface MatchedUser {
  telegramId: number;
  filterId: number;
}

// ─── Matcher Service ──────────────────────────────────────────────────────────

export class MatcherService {
  constructor(
    private readonly filtersRepo: FiltersRepository,
    private readonly usersRepo: UsersRepository,
    private readonly propertiesRepo: PropertiesRepository,
    private readonly notifierService: NotifierService,
  ) {}

  propertyMatchesFilter(property: Property, filter: SearchFilter): boolean {
    return propertyMatchesFilter(property, filter);
  }

  /**
   * Checks a property against every active filter.
   * Returns at most one entry per user (first matching filter wins).
   */
  matchProperty(property: Property): MatchedUser[] {
    if (property.is_active === 0) return [];

    const filters = this.filtersRepo.getAllActiveFilters();
    const matched: MatchedUser[] = [];
    const seenUserIds = new Set<number>();

    for (const filter of filters) {
      if (seenUserIds.has(filter.user_id)) continue;
      if (!this.propertyMatchesFilter(property, filter)) continue;

      const user = this.usersRepo.findById(filter.user_id);
      if (!user || user.is_active !== 1 || user.alerts_paused !== 0) continue;

      matched.push({ telegramId: user.telegram_id, filterId: filter.id });
      seenUserIds.add(filter.user_id);
    }

    return matched;
  }

  /**
   * Finds recent active properties from the database that match a specific filter.
   * Used for Instant Matches (Cold Start) when a user creates an alert.
   */
  findMatchingPropertiesForFilter(filter: SearchFilter, limit = 5): Property[] {
    const allProperties = this.propertiesRepo.getRecentProperties(100);
    const matching = allProperties.filter((p) => p.is_active === 1 && this.propertyMatchesFilter(p, filter));
    return matching.slice(0, limit);
  }

  /**
   * Orchestrates matching and queues notifications.
   * Called by the ingestor after a new property is persisted.
   */
  async matchAndNotify(property: Property): Promise<void> {
    const matched = this.matchProperty(property);

    if (matched.length === 0) return;

    console.log(`🎯 Property #${property.id} "${property.title}" matched ${matched.length} user(s)`);

    for (const { telegramId } of matched) {
      this.notifierService.dispatchNotification(telegramId, property);
    }
  }
}
