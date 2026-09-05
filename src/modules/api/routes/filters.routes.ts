import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { CITIES, CATEGORY_OPTIONS, type CityKey } from '../../../config/settings';

export const filtersRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  /**
   * GET /api/v1/filters/metadata
   * Metadata needed to render dynamic filter sheets in Mini App.
   */
  fastify.get('/api/v1/filters/metadata', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const city = (query.city as CityKey) || 'siem_reap';

    const meta = container.propertiesRepo.getMetadata(city);

    const availableCities = (Object.keys(CITIES) as CityKey[]).map((key) => ({
      key,
      name: CITIES[key],
      currency: 'USD',
    }));

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
