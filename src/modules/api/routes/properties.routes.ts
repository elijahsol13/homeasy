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

      const city: CityKey = 'siem_reap';
      const category = query.category || undefined;
      const type = 'rent' as const;

      // Price in USD -> convert to USD cents
      const minPrice = query.min_price ? Math.max(0, parseInt(query.min_price, 10) * 100) : undefined;
      const maxPrice = query.max_price ? Math.max(0, parseInt(query.max_price, 10) * 100) : undefined;

      // Bedrooms
      let bedrooms: number[] | undefined;
      if (query.bedrooms) {
        bedrooms = query.bedrooms
          .split(',')
          .map((n) => parseInt(n.trim(), 10))
          .filter((n) => !isNaN(n));
      }

      // Bathrooms
      let bathrooms: number[] | undefined;
      if (query.bathrooms) {
        bathrooms = query.bathrooms
          .split(',')
          .map((n) => parseInt(n.trim(), 10))
          .filter((n) => !isNaN(n));
      }

      // Locations / Sangkats
      let locations: string[] | undefined;
      if (query.locations) {
        locations = query.locations
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }

      // Has pool
      let hasPool: boolean | undefined;
      if (query.has_pool !== undefined) {
        hasPool = query.has_pool === 'true' || query.has_pool === '1';
      }

      // Pet friendly
      let petFriendly: boolean | undefined;
      if (query.pet_friendly !== undefined) {
        petFriendly = query.pet_friendly === 'true' || query.pet_friendly === '1';
      }

      // Primary landmark
      const primaryLandmark = query.primary_landmark ? query.primary_landmark.trim() : undefined;

      // Min lease
      const minLeaseMax = query.min_lease_max ? parseInt(query.min_lease_max, 10) : undefined;

      // Search text query
      const textQuery = query.query ? query.query.trim() : undefined;

      // Sort
      const sort = query.sort === 'price_asc' || query.sort === 'price_desc' ? query.sort : 'newest';

      // Admin-only review-status filter (pending/approved/rejected/all)
      const canary = isCanonicalReadCanary(request.telegramUser?.id);
      const isAdmin = !canary && (
        isAdminTelegramUser(request.telegramUser?.id) ||
        (request.telegramUser
          ? container.usersRepo.findByTelegramId(request.telegramUser.id)?.role === 'admin'
          : false));
      let reviewStatus: 'pending' | 'approved' | 'rejected' | 'all' | undefined;
      if (isAdmin && query.review_status) {
        if (query.review_status === 'pending' || query.review_status === 'approved' || query.review_status === 'rejected') {
          reviewStatus = query.review_status;
        } else if (query.review_status === 'all') {
          reviewStatus = 'all';
        }
      }

      // Pagination
      const page = Math.max(1, query.page ? parseInt(query.page, 10) : 1);
      const limit = Math.min(50, Math.max(1, query.limit ? parseInt(query.limit, 10) : 20));
      const offset = (page - 1) * limit;

      const searchOptions: PropertyFilterOptions = {
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
        limit,
        offset,
      };
      const readPath = listingReadPathForUser(request.telegramUser?.id);
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
    const city: CityKey = 'siem_reap';
    const category = query.category || undefined;
    const type = 'rent' as const;
    const limit = query.limit ? Math.min(500, parseInt(query.limit, 10)) : 300;

    let bounds: MapBoundingBox | undefined = undefined;
    if (
      query.minLat !== undefined &&
      query.maxLat !== undefined &&
      query.minLng !== undefined &&
      query.maxLng !== undefined
    ) {
      const minLat = parseFloat(query.minLat);
      const maxLat = parseFloat(query.maxLat);
      const minLng = parseFloat(query.minLng);
      const maxLng = parseFloat(query.maxLng);
      const paddingRatio = query.paddingRatio !== undefined ? parseFloat(query.paddingRatio) : 0.2;

      if (!isNaN(minLat) && !isNaN(maxLat) && !isNaN(minLng) && !isNaN(maxLng)) {
        bounds = {
          minLat,
          maxLat,
          minLng,
          maxLng,
          paddingRatio: !isNaN(paddingRatio) ? paddingRatio : 0.2,
        };
      }
    }

    const readPath = listingReadPathForUser(request.telegramUser?.id);
    const canary = isCanonicalReadCanary(request.telegramUser?.id);
    if (readPath === 'canonical') {
      const started = performance.now();
      let canonical;
      try {
        canonical = container.canonicalListingRepo.searchProperties({ city, type, category, limit: Math.min(limit, 500) });
      } catch (error) {
        if (canary) request.log.error({ event: 'canonical_canary_read_error', surface: 'map', error: String(error) });
        throw error;
      }
      const exactMarkers: ReturnType<typeof toMapMarkerDTO>[] = [];
      const unlocatedItems: Array<{
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

      for (const property of canonical.items) {
        const marker = toMapMarkerDTO(property);
        if (marker.coordinates) {
          if (isInsideBounds(marker.coordinates)) exactMarkers.push(marker);
          continue;
        }

        // Canonical ingestion often knows the Sangkat but not an exact street
        // address. Show those listings as honest neighborhood clusters rather
        // than returning markers without coordinates (which Leaflet cannot draw).
        unlocatedItems.push({
          city: marker.city,
          location: marker.location || '',
          locationKey: marker.locationKey,
          priceUsd: marker.priceUsd,
        });
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
          const legacyProperties = container.propertiesRepo.getPropertiesForMap(city, { category, type, limit, bounds });
          const legacyExactMarkers = legacyProperties.map(toMapMarkerDTO);
          const legacyClusters = container.propertiesRepo.getSangkatClustersForMap(city, { category, type, bounds })
            .map((cluster, index) => toSangkatClusterDTO(cluster, city, index));
          const legacyMarkers = [...legacyExactMarkers, ...legacyClusters];
          const markerIdentity = (marker: typeof canonicalMarkers[number]) => marker.isExact
            ? `listing:${marker.publicRef ?? marker.id}`
            : `area:${marker.locationKey ?? `${marker.city}:${marker.location.toLocaleLowerCase()}`}`;
          const legacyKeys = new Set(legacyMarkers.map(markerIdentity));
          const canonicalKeys = new Set(canonicalMarkers.map(markerIdentity));
          request.log.info({ event: 'canonical_canary_shadow', surface: 'map', servedPath: readPath, shadowPath: 'legacy',
            canonicalCount: canonical.items.length, canonicalMapMarkers: canonicalMarkers.length,
            legacyCount: legacyMarkers.length, legacyExactMarkers: legacyExactMarkers.length,
            legacyAreaMarkers: legacyClusters.length,
            markerOverlap: [...canonicalKeys].filter((key) => legacyKeys.has(key)).length,
            canonicalTop10Refs: canonical.items.slice(0,10).map((item)=>item.public_listing_ref).filter(Boolean),
            canonicalLatencyMs: +(performance.now()-started).toFixed(2), legacyLatencyMs: +(performance.now()-legacyStarted).toFixed(2) });
        } catch (error) {
          request.log.warn({ event: 'canonical_canary_shadow_error', surface: 'map', error: String(error) });
        }
      }
      return reply.send({ city, count: canonicalMarkers.length, markers: canonicalMarkers });
    }

    const exactProperties = container.propertiesRepo.getPropertiesForMap(city, {
      category,
      type,
      limit,
      bounds,
    });

    const exactMarkers = exactProperties.map(toMapMarkerDTO);

    const clusters = container.propertiesRepo.getSangkatClustersForMap(city, {
      category,
      type,
      bounds,
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
      const includeModerated = isAdminUser && !canary;
      if (/^lst_[a-f0-9]{32}$/.test(id)) {
        if (readPath !== 'canonical') return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
        const identity = container.listingIdentityRepo.resolvePublicRef(id);
        const canonicalProperty = identity ? container.canonicalListingRepo.getPropertyById(identity.listingId,includeModerated) : undefined;
        if (!canonicalProperty || canonicalProperty.public_listing_ref !== id) {
        if (canary) request.log.info({ event: 'canonical_canary_detail_opened', servedPath: readPath, publicRef: id, resolved: false, aliasResolved: Boolean(identity) });
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
        }
        const user=request.telegramUser?container.usersRepo.findByTelegramId(request.telegramUser.id):undefined;
        const isFavorite=user?container.favoritesRepo.isCanonicalFavorite(user.id,identity!.listingId):false;
        if (canary) request.log.info({ event: 'canonical_canary_detail_opened', publicRef: id, resolved: true });
        return reply.send(toPropertyDTO(canonicalProperty,isFavorite));
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

      return reply.send(toPropertyDTO(property, isFavorite));
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

      if(env.LISTING_READ_PATH==='canonical'){
        if(action!=='approve'&&action!=='reject')return reply.status(400).send({statusCode:400,error:'Bad Request',message:'action=approve|reject required'});
        const identity=/^lst_[a-f0-9]{32}$/.test(id)
          ?container.listingIdentityRepo.resolvePublicRef(id)
          :Number.isSafeInteger(propId)?container.listingIdentityRepo.resolve('legacy_property_id',propId):undefined;
        if(!identity)return reply.status(404).send({statusCode:404,error:'Not Found',message:'Canonical listing not found'});
        const status=action==='approve'?'approved':'rejected';
        container.db.prepare(`INSERT INTO canonical_listing_moderation(listing_id,review_status,decision_origin)
          VALUES(?,?, 'EXPLICIT_CANONICAL') ON CONFLICT(listing_id) DO UPDATE SET review_status=excluded.review_status,
          decision_origin='EXPLICIT_CANONICAL',review_reason=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(identity.listingId,status);
        const property=status==='approved'?container.canonicalListingRepo.getPropertyById(identity.listingId):undefined;
        return reply.send({ok:true,action,publicRef:identity.publicRef,reviewStatus:status,property:property?toPropertyDTO(property):null});
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
      return reply.send({ ok: true, action, property: property ? toPropertyDTO(property) : null });
    },
  );
};
