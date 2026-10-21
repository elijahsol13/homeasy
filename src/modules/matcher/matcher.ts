import type { FiltersRepository, SearchFilter } from '../../database/repositories/filters.repo';
import type { PropertiesRepository, Property } from '../../database/repositories/properties.repo';
import type { UsersRepository } from '../../database/repositories/users.repo';
import type { CanonicalListingRepository } from '../../database/repositories/canonical-listing.repo';
import type { NotifierService } from '../../services/notifier';
import { listingReadPathForUser } from '../api/listing-read-path';
import { getCanonicalLocationKey } from '../../config/locations';

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
    const propertyKey = getCanonicalLocationKey(property.location, property.city);
    const locationMatch = filter.locations.some(
      (loc) => {
        const requestedKey = getCanonicalLocationKey(loc, filter.city);
        if (requestedKey && propertyKey) return requestedKey === propertyKey;
        return propLocNorm.includes(loc.toLowerCase()) || loc.toLowerCase().includes(propLocNorm);
      },
    );
    if (!locationMatch) return false;
  }

  // 7. Price range (filter prices in USD dollars; property.price in USD cents)
  if (filter.min_price !== null && property.price < filter.min_price * 100) return false;
  if (filter.max_price !== null && property.price > filter.max_price * 100) return false;

  // 8. Bedrooms (null or empty = any; otherwise property.bedrooms must match one of selected)
  if (filter.bedrooms && filter.bedrooms.length > 0 && property.bedrooms !== null) {
    const matches = filter.bedrooms.some((b) => {
      if (b === 4) return property.bedrooms! >= 4;
      return property.bedrooms === b;
    });
    if (!matches) return false;
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
    private readonly canonicalListingRepo: CanonicalListingRepository,
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
   * Finds recent active properties from the database that match a specific filter with pagination.
   * Scans the active database pool (ordered by updated_at / created_at DESC).
   * Returns paginated slice and total matching count.
   */
  findMatchingPropertiesForFilter(
    filter: SearchFilter,
    limit = 3,
    offset = 0,
    telegramUserId?: number,
  ): { properties: Property[]; total: number } {
    const allProperties = telegramUserId !== undefined && listingReadPathForUser(telegramUserId) === 'canonical'
      ? this.canonicalListingRepo.searchProperties({ city: filter.city, type: filter.type, limit: 500 }).items
      : this.propertiesRepo.getRecentProperties(500);
    const matching = allProperties.filter((p) => p.is_active === 1 && this.propertyMatchesFilter(p, filter));
    return {
      properties: matching.slice(offset, offset + limit),
      total: matching.length,
    };
  }

  /**
   * Orchestrates matching and queues notifications.
   * Called by the ingestor after a new property is persisted.
   */
  async matchAndNotify(property: Property): Promise<void> {
    // Canonical notifications must originate from the durable publication
    // outbox. Legacy ingests can trigger this method repeatedly on recrawls.
    if (property.public_listing_ref) return;
    let sent = 0;
    for (const { telegramId } of this.matchProperty(property)) {
      if (listingReadPathForUser(telegramId) !== 'legacy') continue;
      this.notifierService.dispatchNotification(telegramId, property);
      sent++;
    }
    if (sent) console.log(`🎯 Listing ${property.id} matched ${sent} user(s)`);
  }
}
