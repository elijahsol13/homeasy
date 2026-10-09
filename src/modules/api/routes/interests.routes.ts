import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { requireTelegramAuth } from '../auth';

type SearchContext = Record<string, string | number | boolean | string[] | number[]>;

function asString(value: unknown, maxLength = 120): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= maxLength ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const values = value.map((entry) => asString(entry, 80)).filter((entry): entry is string => Boolean(entry));
  return values.length === value.length ? values : undefined;
}

/** Persist only filter criteria useful for a later human follow-up. */
export function normalizeSearchContext(value: unknown): SearchContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const context: SearchContext = {};
  const city = asString(source.city, 32);
  const category = asString(source.category, 32);
  const type = source.type === 'rent' || source.type === 'sale' ? source.type : undefined;
  const query = asString(source.query, 160);
  const sort = source.sort === 'newest' || source.sort === 'price_asc' || source.sort === 'price_desc' ? source.sort : undefined;
  const locations = asStringList(source.locations);
  const bedrooms = Array.isArray(source.bedrooms) && source.bedrooms.length <= 10
    && source.bedrooms.every((entry) => asPositiveInt(entry) !== undefined)
    ? source.bedrooms as number[] : undefined;
  const bathrooms = Array.isArray(source.bathrooms) && source.bathrooms.length <= 10
    && source.bathrooms.every((entry) => asPositiveInt(entry) !== undefined)
    ? source.bathrooms as number[] : undefined;
  const minPrice = asPositiveInt(source.minPrice);
  const maxPrice = asPositiveInt(source.maxPrice);
  const minLeaseMax = asPositiveInt(source.minLeaseMax);

  if (city) context.city = city;
  if (category) context.category = category;
  if (type) context.type = type;
  if (query) context.query = query;
  if (sort) context.sort = sort;
  if (locations) context.locations = locations;
  if (bedrooms) context.bedrooms = bedrooms;
  if (bathrooms) context.bathrooms = bathrooms;
  if (minPrice) context.minPrice = minPrice;
  if (maxPrice) context.maxPrice = maxPrice;
  if (minLeaseMax) context.minLeaseMax = minLeaseMax;
  if (typeof source.hasPool === 'boolean') context.hasPool = source.hasPool;
  return context;
}

export const interestsRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  fastify.post('/api/v1/listings/:publicRef/view', { preHandler: requireTelegramAuth }, async (request, reply) => {
    const { publicRef } = request.params as { publicRef: string };
    const identity = container.listingIdentityRepo.resolvePublicRef(publicRef);
    const listing = identity ? container.canonicalListingRepo.getPropertyById(identity.listingId) : undefined;
    if (!identity || !listing) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
    }
    const user = container.usersRepo.upsertUser(request.telegramUser!.id, request.telegramUser!.username ?? null);
    container.analyticsRepo.trackEvent({
      userId: user.id,
      telegramId: user.telegram_id,
      eventType: 'listing_view',
      metadata: { listing_public_ref: identity.publicRef, surface: 'miniapp' },
    });
    return reply.send({ ok: true, publicRef: identity.publicRef });
  });

  fastify.post('/api/v1/listings/:publicRef/interest', { preHandler: requireTelegramAuth }, async (request, reply) => {
    const { publicRef } = request.params as { publicRef: string };
    const identity = container.listingIdentityRepo.resolvePublicRef(publicRef);
    const listing = identity ? container.canonicalListingRepo.getPropertyById(identity.listingId) : undefined;
    if (!identity || !listing) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
    }

    const body = (request.body ?? {}) as { searchContext?: unknown; contactChannel?: unknown };
    const contactChannel = body.contactChannel === 'telegram' ? 'telegram' : undefined;
    const user = container.usersRepo.upsertUser(request.telegramUser!.id, request.telegramUser!.username ?? null);
    const flow = container.interestsRepo.createOrGetFlow({
      userId: user.id,
      listingId: identity.listingId,
      searchContext: normalizeSearchContext(body.searchContext),
    });

    if (flow.interestCreated) {
      container.analyticsRepo.trackEvent({
        userId: user.id,
        telegramId: user.telegram_id,
        eventType: 'interest_created',
        metadata: { listing_public_ref: identity.publicRef, request_id: flow.requestId, offer_id: flow.offerId },
      });
    }
    if (flow.contactGrantCreated) {
      container.analyticsRepo.trackEvent({
        userId: user.id,
        telegramId: user.telegram_id,
        eventType: 'contact_granted',
        metadata: { listing_public_ref: identity.publicRef, request_id: flow.requestId, offer_id: flow.offerId, contact_grant_id: flow.contactGrantId },
      });
    }
    if (contactChannel) {
      container.analyticsRepo.trackEvent({
        userId: user.id,
        telegramId: user.telegram_id,
        eventType: 'telegram_contact_dispatched',
        metadata: { listing_public_ref: identity.publicRef, contact_grant_id: flow.contactGrantId },
      });
    }

    return reply.send({ ok: true, ...flow, publicRef: identity.publicRef });
  });
};
