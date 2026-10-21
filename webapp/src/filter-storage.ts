import type { FilterState } from './types';

export const INITIAL_FILTERS: FilterState = {
  city: 'siem_reap',
  locations: [],
  type: 'rent',
  sort: 'newest',
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPrice = (value: unknown): value is number =>
  isCount(value) && Number.isSafeInteger(value * 100);

/** Keep recognized, correctly typed saved settings; repair every other field individually. */
export function normalizeStoredFilters(value: unknown): FilterState {
  const filters: FilterState = { ...INITIAL_FILTERS, locations: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return filters;

  const stored = value as Record<string, unknown>;
  if (stored.city === 'siem_reap' || stored.city === 'phnom_penh') filters.city = stored.city;
  if (Array.isArray(stored.locations)) {
    filters.locations = stored.locations.filter(
      (location): location is string => typeof location === 'string' &&
        location.trim().length > 0 && location.length <= 250,
    ).slice(0, 100);
  }
  if (stored.type === 'rent' || stored.type === 'sale') filters.type = stored.type;
  if (stored.sort === 'newest' || stored.sort === 'price_asc' || stored.sort === 'price_desc') {
    filters.sort = stored.sort;
  }
  if (stored.reviewStatus === 'pending' || stored.reviewStatus === 'approved' ||
      stored.reviewStatus === 'rejected' || stored.reviewStatus === 'all') {
    filters.reviewStatus = stored.reviewStatus;
  }

  if (typeof stored.mapClusterKey === 'string' && /^[a-z0-9_:]{1,100}$/.test(stored.mapClusterKey)) {
    filters.mapClusterKey = stored.mapClusterKey;
  }
  for (const key of ['category', 'query'] as const) {
    if (typeof stored[key] === 'string') filters[key] = stored[key];
  }
  for (const key of ['minPrice', 'maxPrice'] as const) {
    if (isPrice(stored[key])) filters[key] = stored[key];
  }
  for (const key of ['bedrooms', 'bathrooms'] as const) {
    if (Array.isArray(stored[key])) {
      const valid = stored[key].filter(isCount);
      if (valid.length > 0 || stored[key].length === 0) filters[key] = valid;
    }
  }
  if (typeof stored.hasPool === 'boolean') filters.hasPool = stored.hasPool;
  if (isCount(stored.minLeaseMax)) filters.minLeaseMax = stored.minLeaseMax;

  return filters;
}
