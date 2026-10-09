import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { requireTelegramAuth } from '../auth';
import { toPropertyDTO } from '../dto';
import { isCanonicalReadCanary, listingReadPathForUser } from '../listing-read-path';

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

      const readPath = listingReadPathForUser(tgUser.id);
      const favorites = readPath==='canonical'
        ? container.favoritesRepo.getCanonicalFavorites(user.id,container.canonicalListingRepo)
        : container.favoritesRepo.getUserFavorites(user.id);
      if (isCanonicalReadCanary(tgUser.id)) request.log.info({ event: 'canonical_canary_favorites_list', servedPath: readPath, count: favorites.length });
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
   * Rate-limited to 30 req/min to prevent automated bot clicking.
   */
  fastify.post(
    '/api/v1/favorites/toggle',
    {
      preHandler: requireTelegramAuth,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          errorResponseBuilder: (_request, context) => ({
            statusCode: 429,
            error: 'Too Many Requests',
            message: `Too many favorite actions (limit: 30/min). Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
          }),
        },
      },
    },
    async (request, reply) => {
      const tgUser = request.telegramUser!;
      const user = container.usersRepo.upsertUser(tgUser.id, tgUser.username ?? null);

      const body = request.body as { propertyId?: number; publicRef?: string };
      if(listingReadPathForUser(tgUser.id)==='canonical'){
        if(typeof body?.publicRef!=='string'){
          if(isCanonicalReadCanary(tgUser.id))request.log.warn({event:'canonical_canary_favorite_resolution',servedPath:'canonical',resolved:false,reason:'missing_public_ref'});
          return reply.status(400).send({statusCode:400,error:'Bad Request',message:'Field "publicRef" is required'});
        }
        const identity=container.listingIdentityRepo.resolvePublicRef(body.publicRef);
        const listing=identity?container.canonicalListingRepo.getPropertyById(identity.listingId):undefined;
        if(!identity||!listing){
          if(isCanonicalReadCanary(tgUser.id))request.log.info({event:'canonical_canary_favorite_resolution',servedPath:'canonical',publicRef:body.publicRef,resolved:false});
          return reply.status(404).send({statusCode:404,error:'Not Found',message:'Listing not found'});
        }
        const isFavorite=container.favoritesRepo.toggleCanonicalFavorite(user.id,identity.listingId);
        const totalFavorites=(container.db.prepare('SELECT COUNT(*) n FROM canonical_user_favorites WHERE user_id=?').get(user.id) as {n:number}).n;
        if(isCanonicalReadCanary(tgUser.id))request.log.info({event:'canonical_canary_favorite_resolution',servedPath:'canonical',publicRef:body.publicRef,resolved:true,isFavorite});
        return reply.send({publicRef:body.publicRef,isFavorite,totalFavorites});
      }
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
