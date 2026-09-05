import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { requireTelegramAuth } from '../auth';
import { toPropertyDTO } from '../dto';

export const favoritesRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  /**
   * GET /api/v1/favorites
   * List properties saved by the authenticated Telegram user.
   */
  fastify.get(
    '/api/v1/favorites',
    { preHandler: requireTelegramAuth },
    async (request, reply) => {
      const tgUser = request.telegramUser!;
      const user = container.usersRepo.upsertUser(tgUser.id, tgUser.username ?? null);

      const favorites = container.favoritesRepo.getUserFavorites(user.id);
      const items = favorites.map((prop) => toPropertyDTO(prop, true));

      return reply.send({
        total: items.length,
        items,
      });
    },
  );

  /**
   * POST /api/v1/favorites/toggle
   * Toggle save/unsave a property in favorites.
   */
  fastify.post(
    '/api/v1/favorites/toggle',
    { preHandler: requireTelegramAuth },
    async (request, reply) => {
      const tgUser = request.telegramUser!;
      const user = container.usersRepo.upsertUser(tgUser.id, tgUser.username ?? null);

      const body = request.body as { propertyId?: number };
      const propertyId = body?.propertyId;

      if (!propertyId || typeof propertyId !== 'number') {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Field "propertyId" is required and must be a number',
        });
      }

      const property = container.propertiesRepo.getPropertyById(propertyId);
      if (!property) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Property not found',
        });
      }

      const isFav = container.favoritesRepo.isFavorite(user.id, propertyId);
      let newFavState: boolean;

      if (isFav) {
        container.favoritesRepo.removeFavorite(user.id, propertyId);
        newFavState = false;
      } else {
        container.favoritesRepo.addFavorite(user.id, propertyId);
        newFavState = true;
      }

      return reply.send({
        propertyId,
        isFavorite: newFavState,
        totalFavorites: container.favoritesRepo.getFavoriteCount(user.id),
      });
    },
  );
};
