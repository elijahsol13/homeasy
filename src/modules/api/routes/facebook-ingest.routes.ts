import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../../container';
import { env } from '../../../config/env';
import { RawListingSchema } from '../../parser/schemas';
import { ingestFacebookGroupListings } from '../../parser/facebook-ingestion';

const isFacebookUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'facebook.com' ||
      url.hostname.endsWith('.facebook.com'));
  } catch { return false; }
};

const batchSchema = z.object({
  target: z.object({
    name: z.string().min(1).max(200),
    url: z.string().url().max(1000).refine((url) => isFacebookUrl(url) && /\/groups\/[^/]+/.test(new URL(url).pathname)),
    city: z.enum(['siem_reap', 'phnom_penh']),
  }).strict(),
  listings: z.array(RawListingSchema.superRefine((listing, ctx) => {
    const url = listing.source_url ?? listing.url;
    if (!url || !isFacebookUrl(url)) ctx.addIssue({ code: 'custom', message: 'Invalid Facebook post URL' });
    if (listing.raw_text && listing.raw_text.length > 64000) ctx.addIssue({ code: 'custom', message: 'Post text too long' });
    if (listing.photos.length > 60) ctx.addIssue({ code: 'custom', message: 'Too many photos' });
  })).min(1).max(10),
}).strict();

function constantTimeBearer(incoming: unknown, secret: string): boolean {
  if (typeof incoming !== 'string' || !incoming.startsWith('Bearer ')) return false;
  const supplied = crypto.createHash('sha256').update(incoming.slice(7)).digest();
  const expected = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

export const facebookIngestRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (app, { container }) => {
  app.post('/api/v1/internal/facebook/ingest', {
    bodyLimit: 1024 * 1024,
    config: { cors: false, rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const secret = env.FB_INGEST_TOKEN;
    if (!secret) return reply.code(503).send({ error: 'Facebook import not configured' });
    if (!constantTimeBearer(request.headers.authorization, secret)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Facebook batch' });

    const result = await ingestFacebookGroupListings(container, parsed.data.target, parsed.data.listings);
    const summary = {
      newSourceItems: result.newSourceItems,
      updatedSourceItems: result.updatedSourceItems,
      unchangedSourceItems: result.unchangedSourceItems,
      errors: result.errors,
    };
    // The producer retains and replays partial failures. Canonical identities make replays idempotent.
    if (result.errors.length) return reply.code(503).send(summary);
    return reply.send(summary);
  });
};
