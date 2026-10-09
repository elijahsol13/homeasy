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
    const canonicalItems = canonicalMode
      ? container.canonicalListingRepo.searchProperties({ city, type: 'rent', limit: 500 }).items
      : undefined;
    const meta = canonicalMode
      ? {
          categories: [...new Set(canonicalItems!.map((item) => item.category).filter(Boolean))]
            .map((category) => ({ category: category!, count: canonicalItems!.filter((item) => item.category === category).length })),
          locations: [...new Set(canonicalItems!.map((item) => item.location).filter(Boolean))]
            .map((location) => ({ location, count: canonicalItems!.filter((item) => item.location === location).length })),
          priceRange: {
            minPrice: canonicalItems!.reduce((min, item) => item.price > 0 && (!min || item.price < min) ? item.price : min, 0),
            maxPrice: canonicalItems!.reduce((max, item) => Math.max(max, item.price), 0),
          },
        }
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
