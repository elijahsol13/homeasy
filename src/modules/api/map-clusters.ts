import {
  CAMBODIA_LOCATIONS,
  findCanonicalLocation,
  getCanonicalLocationKey,
  getSangkatCentroid,
} from '../../config/locations';
import type { CityKey } from '../../config/settings';

export interface UnlocatedMapItem {
  city: string;
  location: string;
  locationKey: string | null;
  priceUsd: number;
}

export interface MapAreaCluster {
  location: string;
  locationKey: string | null;
  locationAliases: string[];
  count: number;
  minPriceUsd: number;
  maxPriceUsd: number;
  lat: number;
  lng: number;
  coordinatePrecision: 'district' | 'city';
}

/**
 * Group unlocated listings only when their location resolves to a known area
 * in the requested city. Everything else is kept in one explicitly city-level
 * bucket so unknown addresses are never shown at a fabricated district pin.
 */
export function aggregateUnlocatedMapItems(items: UnlocatedMapItem[], city: CityKey): MapAreaCluster[] {
  const groups = new Map<string, {
    location: string;
    locationKey: string | null;
    aliases: Set<string>;
    count: number;
    minPriceUsd: number;
    maxPriceUsd: number;
    coordinatePrecision: 'district' | 'city';
  }>();

  const keyEntries = new Map(
    CAMBODIA_LOCATIONS
      .filter((entry) => entry.city === city)
      .map((entry) => [getCanonicalLocationKey(entry.canonicalName), entry]),
  );

  for (const item of items) {
    const textEntry = item.location.trim() ? findCanonicalLocation(item.location, city) : undefined;
    const keyEntry = item.locationKey ? keyEntries.get(item.locationKey) : undefined;
    const locationConflictsWithKey = Boolean(
      textEntry && keyEntry && textEntry.canonicalName !== keyEntry.canonicalName,
    );
    const resolvedEntry = !locationConflictsWithKey
      ? textEntry ?? (!item.location.trim() ? keyEntry : undefined)
      : undefined;

    const verifiedArea = resolvedEntry?.city === city ? resolvedEntry : undefined;
    const groupKey = verifiedArea
      ? getCanonicalLocationKey(verifiedArea.canonicalName) ?? `${city}:area_unverified`
      : `${city}:area_unverified`;
    const location = verifiedArea?.canonicalName ?? `${city === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap'} — area unverified`;
    const locationKey = verifiedArea ? groupKey : null;
    const existing = groups.get(groupKey);

    if (existing) {
      existing.count += 1;
      existing.minPriceUsd = Math.min(existing.minPriceUsd, item.priceUsd);
      existing.maxPriceUsd = Math.max(existing.maxPriceUsd, item.priceUsd);
      if (item.location.trim()) existing.aliases.add(item.location.trim());
    } else {
      groups.set(groupKey, {
        location,
        locationKey,
        aliases: new Set(item.location.trim() ? [item.location.trim()] : []),
        count: 1,
        minPriceUsd: item.priceUsd,
        maxPriceUsd: item.priceUsd,
        coordinatePrecision: verifiedArea ? 'district' : 'city',
      });
    }
  }

  return [...groups.values()].map((group) => {
    const coordinates = group.coordinatePrecision === 'city'
      ? getSangkatCentroid(undefined, city)
      : getSangkatCentroid(group.location, city);
    return {
      location: group.location,
      locationKey: group.locationKey,
      locationAliases: [...group.aliases],
      count: group.count,
      minPriceUsd: group.minPriceUsd,
      maxPriceUsd: group.maxPriceUsd,
      ...coordinates,
      coordinatePrecision: group.coordinatePrecision,
    };
  });
}
