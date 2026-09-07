import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import type { CityKey } from '../../../config/settings';
import type { MapBoundingBox } from '../../../database/repositories/properties.repo';
import { optionalTelegramAuth } from '../auth';
import { toPropertyDTO, toMapMarkerDTO, toSangkatClusterDTO } from '../dto';

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

      const city = (query.city as CityKey) || undefined;
      const category = query.category || undefined;
      const type = (query.type as 'rent' | 'sale') || undefined;

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

      // Pagination
      const page = Math.max(1, query.page ? parseInt(query.page, 10) : 1);
      const limit = Math.min(50, Math.max(1, query.limit ? parseInt(query.limit, 10) : 20));
      const offset = (page - 1) * limit;

      const result = container.propertiesRepo.searchProperties({
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
        limit,
        offset,
      });

      // Check favorites if Telegram user is identified
      const favoriteIds = new Set<number>();
      if (request.telegramUser) {
        const user = container.usersRepo.findByTelegramId(request.telegramUser.id);
        if (user) {
          const userFavs = container.favoritesRepo.getUserFavorites(user.id);
          for (const fav of userFavs) {
            favoriteIds.add(fav.id);
          }
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
  fastify.get('/api/v1/properties/map', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const city = (query.city as CityKey) || 'siem_reap';
    const category = query.category || undefined;
    const type = (query.type as 'rent' | 'sale') || undefined;
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
      const propId = parseInt(id, 10);

      if (isNaN(propId)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid property ID',
        });
      }

      const property = container.propertiesRepo.getPropertyById(propId);
      if (!property || property.is_active !== 1) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Property not found or is no longer active',
        });
      }

      let isFavorite = false;
      if (request.telegramUser) {
        const user = container.usersRepo.findByTelegramId(request.telegramUser.id);
        if (user) {
          isFavorite = container.favoritesRepo.isFavorite(user.id, property.id);
        }
      }

      return reply.send(toPropertyDTO(property, isFavorite));
    },
  );
};

