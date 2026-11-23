import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import type { AppContainer } from '../../../container';
import { env } from '../../../config/env';
import { HostedMediaRepository, type GalleryPhotoInput } from '../../media/hosted-media.repo';
import { storeEncodedPhotoSync } from '../../media/hosted-media-store';
import { facebookPostIdentity } from '../../parser/facebook-og-media-refresh';
import { constantTimeBearer } from './internal-ingest-helpers';

const encodedPhoto = z.string().min(1).max(3_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const uploadSchema = z.object({
  groupId: z.string().min(1).max(100),
  postId: z.string().min(1).max(100),
  capturedAt: z.string().datetime({ offset: true }),
  photos: z.array(z.object({
    sourceUrl: z.string().url().max(3000).refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname === 'fbcdn.net' || url.hostname.endsWith('.fbcdn.net'));
    }),
    anchorId: z.string().min(1).max(500).nullable(),
    fullBase64: encodedPhoto,
    thumbBase64: encodedPhoto,
  }).strict()).min(1).max(50),
}).strict();

async function decodeWebp(value: string, maxBytes: number, maxDimension: number): Promise<Buffer> {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error('Invalid image encoding');
  const metadata = await sharp(bytes, { limitInputPixels: maxDimension * maxDimension }).metadata();
  if (metadata.format !== 'webp' || !metadata.width || !metadata.height
    || metadata.width > maxDimension || metadata.height > maxDimension || (metadata.pages ?? 1) !== 1) {
    throw new Error('Invalid WebP dimensions');
  }
  return bytes;
}

export const facebookMediaRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (app, { container }) => {
  const repo = new HostedMediaRepository(container.db);
  const mediaRoot = path.join(path.dirname(env.DATABASE_PATH), 'media');

  app.post('/api/v1/internal/facebook/media', {
    bodyLimit: 16 * 1024 * 1024,
    config: { cors: false, rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const secret = env.FB_INGEST_TOKEN;
    if (!secret) return reply.code(503).send({ error: 'Facebook import not configured' });
    if (!constantTimeBearer(request.headers.authorization, secret)) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid media upload' });
    const input = parsed.data;
    const captureTime = new Date(input.capturedAt).toISOString();
    const sources = container.db.prepare(`SELECT id,canonical_url FROM source_items
      WHERE source_type='FACEBOOK_GROUP' AND group_id=? AND external_id=? LIMIT 2`)
      .all(input.groupId, input.postId) as Array<{ id: number; canonical_url: string }>;
    const identity = sources.length === 1 ? facebookPostIdentity(sources[0].canonical_url) : null;
    if (!identity || identity.postId !== input.postId
      || (/^\d+$/.test(identity.groupId) && identity.groupId !== input.groupId)) {
      return reply.code(404).send({ error: 'Source post not found' });
    }
    const source = sources[0];

    let decoded: Array<{ full: Buffer; thumb: Buffer }>;
    try {
      decoded = await Promise.all(input.photos.map(async (photo) => ({
        full: await decodeWebp(photo.fullBase64, 2_000_000, 2048),
        thumb: await decodeWebp(photo.thumbBase64, 256_000, 512),
      })));
    } catch {
      return reply.code(400).send({ error: 'Invalid WebP media' });
    }

    const anchors = input.photos.map((photo) => photo.anchorId).filter((anchor): anchor is string => Boolean(anchor));
    if (new Set(anchors).size !== anchors.length) return reply.code(409).send({ error: 'Duplicate photo anchor' });
    await fs.mkdir(mediaRoot, { recursive: true, mode: 0o700 });
    let galleryId: number;
    let stored: GalleryPhotoInput[];
    let transactionOpen = false;
    try {
      // No await between the writer lock, file writes and DB links: the backup
      // worker cannot delete a shared hash between storing it and publishing it.
      container.db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const active = container.db.prepare(`SELECT id,captured_at FROM hosted_media_galleries
        WHERE source_item_id=? AND is_active=1 AND purged_at IS NULL`).get(source.id) as { id: number; captured_at: string } | undefined;
      if (active && Date.parse(captureTime) <= Date.parse(active.captured_at)) {
        if (Date.parse(captureTime) < Date.parse(active.captured_at)) throw new Error('Stale gallery upload');
        const existing = repo.getActiveGallery(source.id);
        if (existing.length !== input.photos.length || existing.some((row, index) =>
          row.sourceUrl !== input.photos[index].sourceUrl || row.anchorId !== input.photos[index].anchorId
          || row.fullHash !== createHash('sha256').update(decoded[index].full).digest('hex')
          || row.thumbHash !== createHash('sha256').update(decoded[index].thumb).digest('hex'))) {
          throw new Error('Conflicting gallery capture');
        }
      }
      stored = input.photos.map((photo, index) => ({
        sourceUrl: photo.sourceUrl,
        anchorId: photo.anchorId,
        full: storeEncodedPhotoSync(mediaRoot, decoded[index].full),
        thumb: storeEncodedPhotoSync(mediaRoot, decoded[index].thumb),
      }));
      galleryId = repo.publishGallery(source.id, captureTime, stored);
      container.db.exec('COMMIT');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) container.db.exec('ROLLBACK');
      if (/^(Stale gallery upload|Conflicting gallery capture|Duplicate photo anchor)$/.test((error as Error).message)) {
        return reply.code(409).send({ error: (error as Error).message });
      }
      throw error;
    }
    return reply.send({ galleryId, photos: stored.map((photo) => ({
      fullUrl: `/api/v1/media/${photo.full.hash}/full`,
      thumbUrl: `/api/v1/media/${photo.thumb.hash}/thumb`,
    })) });
  });

  app.get<{ Params: { hash: string; variant: string } }>('/api/v1/media/:hash/:variant', async (request, reply) => {
    const { hash, variant } = request.params;
    if (!/^[0-9a-f]{64}$/.test(hash) || !['full', 'thumb'].includes(variant)) return reply.code(404).send();
    const row = container.db.prepare(`SELECT f.relative_path AS relativePath FROM hosted_media_files f
      WHERE f.hash=? AND EXISTS (SELECT 1 FROM hosted_media_gallery_photos p
        JOIN hosted_media_galleries g ON g.id=p.gallery_id
        WHERE g.purged_at IS NULL AND ${variant === 'full' ? 'p.full_hash' : 'p.thumb_hash'}=f.hash)
    `).get(hash) as { relativePath: string } | undefined;
    if (!row || row.relativePath !== `${hash.slice(0, 2)}/${hash}.webp`) return reply.code(404).send();
    try {
      const filePath = path.join(mediaRoot, row.relativePath);
      const rootStat = await fs.lstat(mediaRoot);
      const directoryStat = await fs.lstat(path.dirname(filePath));
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return reply.code(404).send();
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return reply.code(404).send();
      const bytes = await fs.readFile(filePath);
      return reply.type('image/webp').header('Cache-Control', 'public, max-age=86400').send(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send();
      throw error;
    }
  });
};
