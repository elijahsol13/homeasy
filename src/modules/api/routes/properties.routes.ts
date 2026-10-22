import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import type { CityKey } from '../../../config/settings';
import type { MapBoundingBox } from '../../../database/repositories/properties.repo';
import type { PropertyFilterOptions } from '../../../database/repositories/properties.repo';
import { aggregateUnlocatedMapItems } from '../map-clusters';
import { isAdminTelegramUser, optionalTelegramAuth, requireTelegramAuth } from '../auth';
import { toPropertyDTO, toMapMarkerDTO, toSangkatClusterDTO } from '../dto';
import { env } from '../../../config/env';
import { isCanonicalReadCanary, listingReadPathForUser } from '../listing-read-path';

class InvalidNumericQuery extends Error {
  readonly statusCode = 400;
  readonly name = 'Bad Request';
  constructor(parameter: string) {
    super(`Invalid numeric parameter: ${parameter}`);
  }
}

/** Validate query numbers before they can become SQLite bound parameters. */
function optionalInteger(value: unknown, parameter: string, min = 0, multiplier = 1): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) throw new InvalidNumericQuery(parameter);
  const parsed = Number(value.trim());
  const scaled = parsed * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed < min || !Number.isSafeInteger(scaled)) {
    throw new InvalidNumericQuery(parameter);
  }
  return scaled;
}

function optionalIntegerList(value: unknown, parameter: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidNumericQuery(parameter);
  return value.split(',').map((part) => optionalInteger(part, parameter)!);
}

function optionalFiniteDecimal(value: unknown, parameter: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    throw new InvalidNumericQuery(parameter);
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) throw new InvalidNumericQuery(parameter);
  return parsed;
}

/** Keep list and map endpoints on the same listing cohort. */
function parseListingFilterOptions(
  query: Record<string, string | undefined>,
  isAdmin: boolean,
): PropertyFilterOptions {
  const city: CityKey = 'siem_reap';
  const category = query.category || undefined;
  const type = 'rent' as const;
  const minPrice = optionalInteger(query.min_price, 'min_price', 0, 100);
  const maxPrice = optionalInteger(query.max_price, 'max_price', 0, 100);
  const bedrooms = optionalIntegerList(query.bedrooms, 'bedrooms');
  const bathrooms = optionalIntegerList(query.bathrooms, 'bathrooms');

  let locations: string[] | undefined;
  if (query.locations_json) {
    // JSON preserves commas in source addresses; CSV stays supported.
    try {
      const parsed: unknown = JSON.parse(query.locations_json);
      if (Array.isArray(parsed) && parsed.length <= 100 && parsed.every((item) => typeof item === 'string' && item.length <= 250)) {
        locations = parsed.map((item: string) => item.trim()).filter(Boolean);
      }
    } catch { /* Ignore an invalid optional filter payload. */ }
  } else if (query.locations) {
    locations = query.locations.split(',').map((value) => value.trim()).filter(Boolean);
  }

  let hasPool: boolean | undefined;
  if (query.has_pool !== undefined) hasPool = query.has_pool === 'true' || query.has_pool === '1';

  let petFriendly: boolean | undefined;
  if (query.pet_friendly !== undefined) petFriendly = query.pet_friendly === 'true' || query.pet_friendly === '1';

  const primaryLandmark = query.primary_landmark ? query.primary_landmark.trim() : undefined;
  const minLeaseMax = optionalInteger(query.min_lease_max, 'min_lease_max');
  const textQuery = query.query ? query.query.trim() : undefined;
  const sort = query.sort === 'price_asc' || query.sort === 'price_desc' ? query.sort : 'newest';

  let reviewStatus: PropertyFilterOptions['reviewStatus'];
  if (isAdmin && query.review_status) {
    if (query.review_status === 'pending' || query.review_status === 'approved' || query.review_status === 'rejected') {
      reviewStatus = query.review_status;
    } else if (query.review_status === 'all') {
      reviewStatus = 'all';
    }
  }

  return {
    city,
    locations,
    category,
    type,
    minPrice,
    maxPrice,
    bedrooms,
    bathrooms,
    hasPool,
    petFriendly,
    primaryLandmark,
    minLeaseMax,
    query: textQuery,
    sort,
    reviewStatus,
    includeInactive: isAdmin && reviewStatus !== undefined,
  };
}

export const propertiesRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  /**
   * GET /api/v1/properties
   * Filterable, paginated property listings.
   */
  fastify.get(
    '/api/v1/properties',
    { preHandler: optionalTelegramAuth },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const isAdmin = (
        isAdminTelegramUser(request.telegramUser?.id) ||
        (request.telegramUser
          ? container.usersRepo.findByTelegramId(request.telegramUser.id)?.role === 'admin'
          : false));
      const filterOptions = parseListingFilterOptions(query, isAdmin);
      const city: CityKey = filterOptions.city ?? 'siem_reap';
      const canary = isCanonicalReadCanary(request.telegramUser?.id);

      // Pagination
      const page = optionalInteger(query.page, 'page', 1) ?? 1;
      const limit = Math.min(50, optionalInteger(query.limit, 'limit', 1) ?? 20);
      const offset = (page - 1) * limit;
      if (!Number.isSafeInteger(offset)) throw new InvalidNumericQuery('page');

      const searchOptions: PropertyFilterOptions = {
        ...filterOptions,
        limit,
        offset,
      };
      const readPath = listingReadPathForUser(request.telegramUser?.id);
      if (readPath === 'canonical' && query.map_cluster_key !== undefined) {
        // Use the same unlocated/GPS split and aggregation as the map endpoint.
        // Location aliases alone include exact GPS pins that aren't in the cluster.
        const clusterKey = query.map_cluster_key;
        if (!/^[a-z0-9_:]{1,100}$/.test(clusterKey)) {
          return reply.status(400).send({ error: 'Invalid map cluster key' });
        }
        const unlocated: Array<{ listingId: number; city: string; location: string; locationKey: string | null; priceUsd: number }> = [];
        container.canonicalListingRepo.forEachMapProperty(searchOptions, (property) => {
          const marker = toMapMarkerDTO(property);
          if (!marker.coordinates) unlocated.push({
            listingId: property.id,
            city: marker.city,
            location: marker.location,
            locationKey: marker.locationKey,
            priceUsd: marker.priceUsd,
          });
        });
        const cluster = aggregateUnlocatedMapItems(unlocated, city)
          .find((item) => item.locationKey === clusterKey);
        searchOptions.canonicalListingIds = cluster?.listingIds ?? [];
        searchOptions.locations = undefined;
      }
      const needsLegacy = readPath === 'legacy' || env.LISTING_READ_SHADOW || canary;
      const needsCanonical = readPath === 'canonical' || env.LISTING_READ_SHADOW || canary;
      const legacyStarted = performance.now();
      const legacyResult = needsLegacy ? container.propertiesRepo.searchProperties(searchOptions) : undefined;
      const legacyLatencyMs = legacyResult ? performance.now() - legacyStarted : undefined;
      const canonicalStarted = performance.now();
      let canonicalResult;
      try {
        canonicalResult = needsCanonical ? container.canonicalListingRepo.searchProperties(searchOptions) : undefined;
      } catch (error) {
        if (canary) request.log.error({ event: 'canonical_canary_read_error', surface: 'list', error: String(error), criteria: query });
        throw error;
      }
      const canonicalLatencyMs = canonicalResult ? performance.now() - canonicalStarted : undefined;
      if ((env.LISTING_READ_SHADOW || canary) && canonicalResult && legacyResult) {
        const identity = (item: typeof legacyResult.items[number]) =>
          [item.city, item.location.toLowerCase(), item.category ?? '', item.bedrooms ?? '', item.price, item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()].join('|');
        const legacyKeys = new Set(legacyResult.items.map(identity));
        const canonicalKeys = new Set(canonicalResult.items.map(identity));
        request.log.info({
          event: canary ? 'canonical_canary_shadow' : 'listing_read_parity',
          surface: 'list',
          servedPath: readPath,
          ...(canary ? { shadowPath: 'legacy' } : {}),
          criteria: query,
          legacyCount: legacyResult.total,
          canonicalCount: canonicalResult.total,
          pageOverlap: [...legacyKeys].filter((key) => canonicalKeys.has(key)).length,
          legacyOnlyTopPage: [...legacyKeys].filter((key) => !canonicalKeys.has(key)).length,
          canonicalOnlyTopPage: [...canonicalKeys].filter((key) => !legacyKeys.has(key)).length,
          canonicalTop10Refs: canonicalResult.items.slice(0, 10).map((item) => item.public_listing_ref).filter(Boolean),
          legacyLatencyMs: +legacyLatencyMs!.toFixed(2),
          canonicalLatencyMs: canonicalLatencyMs === undefined ? undefined : +canonicalLatencyMs.toFixed(2),
        });
      }
      const result = readPath === 'canonical' ? canonicalResult! : legacyResult!;

      // Check favorites if Telegram user is identified
      const favoriteIds = new Set<number>();
      if (request.telegramUser) {
        const user = container.usersRepo.findByTelegramId(request.telegramUser.id);
        if (user) {
          const userFavs = container.favoritesRepo.getUserFavorites(user.id);
          if(readPath==='canonical')for(const favId of container.favoritesRepo.getCanonicalFavoriteListingIds(user.id))favoriteIds.add(favId);
          else for (const fav of userFavs) favoriteIds.add(fav.id);
        }
      }

      const items = result.items.map((prop) => toPropertyDTO(prop, favoriteIds.has(prop.id)));

      return reply.send({
        total: result.total,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
        items,
      });
    },
  );

  /**
   * GET /api/v1/properties/map
   * Lightweight markers for interactive map view.
   */
  fastify.get('/api/v1/properties/map', { preHandler: optionalTelegramAuth }, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const isAdmin = (
      isAdminTelegramUser(request.telegramUser?.id) ||
      (request.telegramUser
        ? container.usersRepo.findByTelegramId(request.telegramUser.id)?.role === 'admin'
        : false));
    const filterOptions = parseListingFilterOptions(query, isAdmin);
    const city: CityKey = filterOptions.city ?? 'siem_reap';
    const category = filterOptions.category;
    const type = filterOptions.type ?? 'rent';
    const limit = Math.min(500, optionalInteger(query.limit, 'limit', 1) ?? 300);

    let bounds: MapBoundingBox | undefined = undefined;
    const minLat = optionalFiniteDecimal(query.minLat, 'minLat');
    const maxLat = optionalFiniteDecimal(query.maxLat, 'maxLat');
    const minLng = optionalFiniteDecimal(query.minLng, 'minLng');
    const maxLng = optionalFiniteDecimal(query.maxLng, 'maxLng');
    const paddingRatio = optionalFiniteDecimal(query.paddingRatio, 'paddingRatio') ?? 0.2;
    if (paddingRatio < 0) throw new InvalidNumericQuery('paddingRatio');
    if (
      minLat !== undefined &&
      maxLat !== undefined &&
      minLng !== undefined &&
      maxLng !== undefined
    ) {
      const latPadding = Math.abs(maxLat - minLat) * paddingRatio;
      const lngPadding = Math.abs(maxLng - minLng) * paddingRatio;
      if (![Math.min(minLat, maxLat) - latPadding, Math.max(minLat, maxLat) + latPadding,
        Math.min(minLng, maxLng) - lngPadding, Math.max(minLng, maxLng) + lngPadding].every(Number.isFinite)) {
        throw new InvalidNumericQuery('paddingRatio or map bounds');
      }
      bounds = { minLat, maxLat, minLng, maxLng, paddingRatio };
    }

    const readPath = listingReadPathForUser(request.telegramUser?.id);
    const canary = isCanonicalReadCanary(request.telegramUser?.id);
    if (readPath === 'canonical') {
      const started = performance.now();
      const exactMarkers: ReturnType<typeof toMapMarkerDTO>[] = [];
      const unlocatedItems: Array<{
        listingId: number;
        city: string;
        location: string;
        locationKey: string | null;
        priceUsd: number;
      }> = [];
      const isInsideBounds = (coordinates: { lat: number; lng: number }) => {
        if (!bounds) return true;
        const latPadding = Math.abs(bounds.maxLat - bounds.minLat) * (bounds.paddingRatio ?? 0.2);
        const lngPadding = Math.abs(bounds.maxLng - bounds.minLng) * (bounds.paddingRatio ?? 0.2);
        return coordinates.lat >= Math.min(bounds.minLat, bounds.maxLat) - latPadding
          && coordinates.lat <= Math.max(bounds.minLat, bounds.maxLat) + latPadding
          && coordinates.lng >= Math.min(bounds.minLng, bounds.maxLng) - lngPadding
          && coordinates.lng <= Math.max(bounds.minLng, bounds.maxLng) + lngPadding;
      };

      let canonicalCount: number;
      try {
        canonicalCount = container.canonicalListingRepo.forEachMapProperty(filterOptions, (property) => {
          const marker = toMapMarkerDTO(property);
          if (marker.coordinates) {
            if (exactMarkers.length < limit && isInsideBounds(marker.coordinates)) exactMarkers.push(marker);
            return;
          }

          // All non-GPS listings contribute to district totals, even when the
          // exact-marker cap has been reached or the viewport is narrow.
          unlocatedItems.push({
            listingId: property.id,
            city: marker.city,
            location: marker.location || '',
            locationKey: marker.locationKey,
            priceUsd: marker.priceUsd,
          });
        });
      } catch (error) {
        if (canary) request.log.error({ event: 'canonical_canary_read_error', surface: 'map', error: String(error) });
        throw error;
      }

      // Keep the small set of district markers available even when their
      // centroid is outside the current viewport. A listing-to-map focus can
      // then find its district marker and move the map there; exact pins remain
      // viewport-filtered above.
      const clusterMarkers = aggregateUnlocatedMapItems(unlocatedItems, city)
        .map((cluster, index) => toSangkatClusterDTO(cluster, city, index));
      const canonicalMarkers = [...exactMarkers, ...clusterMarkers];
      if (canary) {
        const legacyStarted = performance.now();
        try {
          const legacyListingIds: number[] = [];
          container.propertiesRepo.forEachMapProperty(filterOptions, (property) => legacyListingIds.push(property.id));
          const legacyProperties = container.propertiesRepo.getPropertiesForMap(city, { category, type, limit, bounds, listingIds: legacyListingIds });
          const legacyExactMarkers = legacyProperties.map(toMapMarkerDTO);
          const legacyClusters = container.propertiesRepo.getSangkatClustersForMap(city, { category, type, bounds, listingIds: legacyListingIds })
            .map((cluster, index) => toSangkatClusterDTO(cluster, city, index));
          const legacyMarkers = [...legacyExactMarkers, ...legacyClusters];
          const markerIdentity = (marker: typeof canonicalMarkers[number]) => marker.isExact
            ? `listing:${marker.publicRef ?? marker.id}`
            : `area:${marker.locationKey ?? `${marker.city}:${marker.location.toLocaleLowerCase()}`}`;
          const legacyKeys = new Set(legacyMarkers.map(markerIdentity));
          const canonicalKeys = new Set(canonicalMarkers.map(markerIdentity));
          request.log.info({ event: 'canonical_canary_shadow', surface: 'map', servedPath: readPath, shadowPath: 'legacy',
            canonicalCount, canonicalMapMarkers: canonicalMarkers.length,
            legacyCount: legacyMarkers.length, legacyExactMarkers: legacyExactMarkers.length,
            legacyAreaMarkers: legacyClusters.length,
            markerOverlap: [...canonicalKeys].filter((key) => legacyKeys.has(key)).length,
            canonicalTop10Refs: exactMarkers.slice(0,10).map((item)=>item.publicRef).filter(Boolean),
            canonicalLatencyMs: +(performance.now()-started).toFixed(2), legacyLatencyMs: +(performance.now()-legacyStarted).toFixed(2) });
        } catch (error) {
          request.log.warn({ event: 'canonical_canary_shadow_error', surface: 'map', error: String(error) });
        }
      }
      return reply.send({ city, count: canonicalMarkers.length, markers: canonicalMarkers });
    }

    const listingIds: number[] = [];
    container.propertiesRepo.forEachMapProperty(filterOptions, (property) => listingIds.push(property.id));
    const exactProperties = container.propertiesRepo.getPropertiesForMap(city, {
      category,
      type,
      limit,
      bounds,
      listingIds,
    });

    const exactMarkers = exactProperties.map(toMapMarkerDTO);

    const clusters = container.propertiesRepo.getSangkatClustersForMap(city, {
      category,
      type,
      bounds,
      listingIds,
    });

    const clusterMarkers = clusters.map((c, idx) => toSangkatClusterDTO(c, city, idx));
    const allMarkers = [...exactMarkers, ...clusterMarkers];

    return reply.send({
      city,
      count: allMarkers.length,
      markers: allMarkers,
    });
  });

  /**
   * GET /api/v1/properties/:id
   * Single property detailed view.
   */
  fastify.get(
    '/api/v1/properties/:id',
    { preHandler: optionalTelegramAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const isAdminUser =
        isAdminTelegramUser(request.telegramUser?.id) ||
        (request.telegramUser
          ? container.usersRepo.findByTelegramId(request.telegramUser.id)?.role === 'admin'
          : false);
      const readPath = listingReadPathForUser(request.telegramUser?.id);
      const canary = isCanonicalReadCanary(request.telegramUser?.id);
      const includeModerated = isAdminUser;
      if (/^lst_[a-f0-9]{32}$/.test(id)) {
        if (readPath !== 'canonical') return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
        const identity = container.listingIdentityRepo.resolvePublicRef(id);
        const canonicalProperty = identity ? container.canonicalListingRepo.getPropertyById(identity.listingId,includeModerated) : undefined;
        // An explicit old public-ref alias may point to the surviving listing
        // after a verified duplicate merge. The canonical DTO keeps its current ref.
        if (!canonicalProperty) {
        if (canary) request.log.info({ event: 'canonical_canary_detail_opened', servedPath: readPath, publicRef: id, resolved: false, aliasResolved: Boolean(identity) });
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
        }
        const user=request.telegramUser?container.usersRepo.findByTelegramId(request.telegramUser.id):undefined;
        const isFavorite=user?container.favoritesRepo.isCanonicalFavorite(user.id,identity!.listingId):false;
        if (canary) request.log.info({ event: 'canonical_canary_detail_opened', publicRef: id, resolved: true });
        return reply.send(toPropertyDTO(canonicalProperty, isFavorite, { includeAllPhotos: true }));
      }
      const propId = parseInt(id, 10);

      if (isNaN(propId)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid property ID',
        });
      }

      const canonicalMode = readPath === 'canonical';
      const legacyAlias = canonicalMode
        ? container.listingIdentityRepo.resolve('legacy_property_id', propId)
        : undefined;
      const property = canonicalMode
        ? legacyAlias ? container.canonicalListingRepo.getPropertyById(legacyAlias.listingId,includeModerated) : undefined
        : container.propertiesRepo.getPropertyById(propId);

      if (!property || (property.is_active !== 1 && !isAdminUser)) {
        if (canary) request.log.info({ event: 'canonical_canary_detail_opened', servedPath: readPath, legacyId: propId, resolved: false, aliasResolved: Boolean(legacyAlias) });
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Property not found or is no longer active',
        });
      }

      let isFavorite = false;
      if (request.telegramUser && canonicalMode && legacyAlias) {
        const user=container.usersRepo.findByTelegramId(request.telegramUser.id);
        if(user)isFavorite=container.favoritesRepo.isCanonicalFavorite(user.id,legacyAlias.listingId);
      } else if (request.telegramUser && !canonicalMode) {
        const user = container.usersRepo.findByTelegramId(request.telegramUser.id);
        if (user) {
          isFavorite = container.favoritesRepo.isFavorite(user.id, property.id);
        }
      }

      if (canary) request.log.info({ event: 'canonical_canary_detail_opened', servedPath: readPath, legacyId: propId, publicRef: property.public_listing_ref, resolved: true, aliasResolved: Boolean(legacyAlias) });

      return reply.send(toPropertyDTO(property, isFavorite, { includeAllPhotos: true }));
    },
  );

  /**
   * POST /api/v1/properties/:id/review
   * Admin-only moderation action: { action: 'approve' | 'reject' }.
   */
  fastify.post(
    '/api/v1/properties/:id/review',
    { preHandler: requireTelegramAuth },
    async (request, reply) => {
      const isAdminUser =
        isAdminTelegramUser(request.telegramUser?.id) ||
        (request.telegramUser
          ? container.usersRepo.findByTelegramId(request.telegramUser.id)?.role === 'admin'
          : false);

      if (!isAdminUser) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Admin access required',
        });
      }

      const { id } = request.params as { id: string };
      const propId = parseInt(id, 10);
      const action = (request.body as { action?: string } | undefined)?.action;

      // Canonical IDs and legacy integer IDs belong to distinct namespaces.
      // Accept only public refs here so a canonical integer cannot accidentally
      // resolve an unrelated legacy alias.
      if (listingReadPathForUser(request.telegramUser?.id) === 'canonical') {
        if (action !== 'approve' && action !== 'reject') {
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'action=approve|reject required' });
        }
        if (!/^lst_[a-f0-9]{32}$/.test(id)) {
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Canonical review requires a publicRef' });
        }
        const identity = container.listingIdentityRepo.resolvePublicRef(id);
        if (!identity || !container.canonicalListingRepo.getPropertyById(identity.listingId, true)) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Canonical listing not found' });
        }
        const status = action === 'approve' ? 'approved' : 'rejected';
        // Mirror legacy pending-only transitions. Do not replace an explicit
        // moderation decision or fabricate a missing moderation row. An
        // unavailable listing may be rejected, but never newly approved.
        const updated = container.db.prepare(`UPDATE canonical_listing_moderation
          SET review_status=?,decision_origin='EXPLICIT_CANONICAL',review_reason=NULL,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE listing_id=? AND review_status='pending'
          ${action === 'approve' ? `AND EXISTS (SELECT 1 FROM canonical_listings l
            WHERE l.id=canonical_listing_moderation.listing_id AND l.status='active'
              AND COALESCE(l.availability_status,'unknown') NOT IN ('rented','removed'))` : ''}`)
          .run(status, identity.listingId);
        if (!updated.changes) {
          return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'Listing already reviewed, unavailable or missing' });
        }
        const property = status === 'approved' ? container.canonicalListingRepo.getPropertyById(identity.listingId) : undefined;
        // The v55 SQLite trigger records the approval atomically. The selected
        // Telegram worker will materialize and deliver canonical notifications.
        return reply.send({ ok: true, action, publicRef: identity.publicRef, reviewStatus: status, property: property ? toPropertyDTO(property, undefined, { includeAllPhotos: true }) : null });
      }

      if (isNaN(propId) || (action !== 'approve' && action !== 'reject')) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Valid property ID and action=approve|reject required',
        });
      }

      const updated = action === 'approve'
        ? container.propertiesRepo.approvePendingProperty(propId)
        : container.propertiesRepo.rejectPendingProperty(propId);

      if (!updated) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Listing already reviewed or missing',
        });
      }

      if (action === 'approve') {
        const property = container.propertiesRepo.getPropertyById(propId);
        if (property?.is_active === 1) {
          container.matcherService.matchAndNotify(property).catch((err) => {
            request.log.error({ err }, 'Approved listing match error');
          });
        }
      }

      const property = container.propertiesRepo.getPropertyById(propId);
      return reply.send({ ok: true, action, property: property ? toPropertyDTO(property, undefined, { includeAllPhotos: true }) : null });
    },
  );
};
