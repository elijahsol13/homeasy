import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../../container';
import { env } from '../../../config/env';
import { RawListingSchema } from '../../parser/schemas';
import { ingestKhmer24Listings } from '../../parser/khmer24-ingestion';

const validKhmer24DetailUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['khmer24.com', 'www.khmer24.com'].includes(url.hostname) &&
      /(?:adid-|adid\/)(\d+)/i.test(url.pathname);
  } catch { return false; }
};

const batchSchema = z.object({
  target: z.object({
    name: z.literal('Khmer24 Siem Reap'),
    url: z.literal('https://www.khmer24.com/en'),
    city: z.literal('siem_reap'),
  }).strict(),
  listings: z.array(RawListingSchema.superRefine((listing, ctx) => {
    const url = listing.source_url ?? listing.url;
    if (!url || !validKhmer24DetailUrl(url) || (listing.url && !validKhmer24DetailUrl(listing.url))) {
      ctx.addIssue({ code: 'custom', message: 'Invalid Khmer24 detail URL' });
    }
    if (listing.raw_text && listing.raw_text.length > 64000) {
      ctx.addIssue({ code: 'custom', message: 'Listing text too long' });
    }
    if (listing.photos.length > 60) ctx.addIssue({ code: 'custom', message: 'Too many photos' });
  })).min(1).max(10),
}).strict();

function constantTimeBearer(header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = crypto.createHash('sha256').update(header.slice(7)).digest();
  const expected = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

export const khmer24IngestRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (app, { container }) => {
  app.post('/api/v1/internal/khmer24/ingest', {
    bodyLimit: 1024 * 1024,
    config: { cors: false, rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!env.K24_INGEST_TOKEN) return reply.code(503).send({ error: 'Khmer24 import not configured' });
    if (!constantTimeBearer(request.headers.authorization, env.K24_INGEST_TOKEN)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Khmer24 batch' });

    const result = await ingestKhmer24Listings(container, parsed.data.listings);
    const summary = {
      newSourceItems: result.newSourceItems,
      updatedSourceItems: result.updatedSourceItems,
      unchangedSourceItems: result.unchangedSourceItems,
      errors: result.errors,
    };
    // Sender retains failed batches for idempotent replay.
    if (result.errors.length) return reply.code(503).send(summary);
    return reply.send(summary);
  });
};
