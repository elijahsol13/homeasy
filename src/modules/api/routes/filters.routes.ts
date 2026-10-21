import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { CATEGORY_OPTIONS, type CityKey } from '../../../config/settings';
import { optionalTelegramAuth } from '../auth';
import { listingReadPathForUser } from '../listing-read-path';

export const filtersRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  /**
   * GET /api/v1/filters/metadata
   * Metadata needed to render dynamic filter sheets in Mini App.
   */
  fastify.get('/api/v1/filters/metadata', { preHandler: optionalTelegramAuth }, async (request, reply) => {
    const city: CityKey = 'siem_reap';
    const canonicalMode = listingReadPathForUser(request.telegramUser?.id) === 'canonical';
    const meta = canonicalMode
      ? container.canonicalListingRepo.getMetadata(city)
      : container.propertiesRepo.getMetadata(city);
    const availableCities = [{ key: 'siem_reap', name: 'Siem Reap', currency: 'USD' }];

    const categoryList = CATEGORY_OPTIONS.filter((cat) => cat.value !== null).map((cat) => {
      const match = meta.categories.find((c) => c.category === cat.value);
      return {
        id: cat.value as string,
        label: cat.label,
        count: match?.count ?? 0,
      };
    });

    return reply.send({
      currentCity: city,
      cities: availableCities,
      locations: meta.locations.map((l) => ({
        name: l.location,
        count: l.count,
      })),
      categories: categoryList,
      priceRange: {
        minUsd: Math.round(meta.priceRange.minPrice / 100),
        maxUsd: Math.round(meta.priceRange.maxPrice / 100),
      },
      bedroomOptions: [
        { value: 0, label: 'Studio' },
        { value: 1, label: '1 BR' },
        { value: 2, label: '2 BR' },
        { value: 3, label: '3 BR' },
        { value: 4, label: '4+ BR' },
      ],
    });
  });
};
