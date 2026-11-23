import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { env } from '../src/config/env';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { buildApiServer } from '../src/modules/api/server';

describe('Facebook hosted media API', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let root: string;
  let payload: { groupId: string; postId: string; capturedAt: string; photos: Array<{ sourceUrl: string; anchorId: string; fullBase64: string; thumbBase64: string }> };
  const oldToken = (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN;
  const oldDatabasePath = (env as { DATABASE_PATH?: string }).DATABASE_PATH;
  const token = 'm'.repeat(40);
  const headers = { authorization: `Bearer ${token}` };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'homeasy-media-api-'));
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = token;
    (env as { DATABASE_PATH?: string }).DATABASE_PATH = path.join(root, 'fixture.db');
    db = new DatabaseSync(path.join(root, 'fixture.db'));
    runMigrations(db);
    const registryId = Number(db.prepare("INSERT INTO source_registry(source_key,source_type,name) VALUES ('fb:test','FACEBOOK_GROUP','Test')").run().lastInsertRowid);
    db.prepare(`INSERT INTO source_items(source_registry_id,source_type,external_id,group_id,canonical_url,classification)
      VALUES (?,'FACEBOOK_GROUP','1001','123','https://www.facebook.com/groups/siemreaprealestate/posts/1001/','HOUSING_SUPPLY')`).run(registryId);
    app = await buildApiServer({ container: createContainer({ db }) });
    await app.ready();
    const full = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#334455' } }).webp().toBuffer();
    const thumb = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#334455' } }).webp().toBuffer();
    payload = { groupId: '123', postId: '1001', capturedAt: '2026-11-23T10:00:00Z', photos: [{
      sourceUrl: 'https://scontent.fbcdn.net/photo.jpg', anchorId: 'photo-1',
      fullBase64: full.toString('base64'), thumbBase64: thumb.toString('base64'),
    }] };
  });

  afterAll(async () => {
    await app?.close();
    db?.close();
    rmSync(root, { recursive: true, force: true });
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = oldToken;
    (env as { DATABASE_PATH?: string }).DATABASE_PATH = oldDatabasePath;
  });

  it('requires bearer auth and a matching source post', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers,
      payload: { ...payload, postId: '9999' } })).statusCode).toBe(404);
  });

  it('publishes from a group slug permalink idempotently and serves its WebP bytes', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers, payload });
    expect(first.statusCode).toBe(200);
    const result = first.json() as { galleryId: number; photos: Array<{ fullUrl: string; thumbUrl: string }> };
    expect(result.photos).toHaveLength(1);
    const repeated = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers, payload });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().galleryId).toBe(result.galleryId);
    const image = await app.inject({ method: 'GET', url: result.photos[0].fullUrl });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/webp');
    expect(image.rawPayload).toEqual(Buffer.from(payload.photos[0].fullBase64, 'base64'));
    expect((await app.inject({ method: 'GET', url: '/api/v1/media/' + 'f'.repeat(64) + '/full' })).statusCode).toBe(404);
  });

  it('rejects non-WebP bytes without activating a gallery', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers,
      payload: { ...payload, capturedAt: '2026-11-23T11:00:00Z', photos: [{ ...payload.photos[0], fullBase64: Buffer.from('not-an-image').toString('base64') }] } });
    expect(bad.statusCode).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hosted_media_galleries').get() as { n: number }).n).toBe(1);
  });

  it('refuses a source row whose canonical permalink disagrees with the upload identity', async () => {
    db.prepare("UPDATE source_items SET canonical_url='https://www.facebook.com/groups/999/posts/1001/' WHERE external_id='1001'").run();
    const response = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers,
      payload: { ...payload, capturedAt: '2026-11-23T12:00:00Z' } });
    expect(response.statusCode).toBe(404);
    db.prepare("UPDATE source_items SET canonical_url='https://www.facebook.com/groups/siemreaprealestate/posts/1001/' WHERE external_id='1001'").run();
  });

  it('rejects a non-Facebook photo URL even when the post identity matches', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers,
      payload: { ...payload, capturedAt: '2026-11-23T12:00:00Z', photos: [{ ...payload.photos[0], sourceUrl: 'https://example.com/unrelated.jpg' }] } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects stale capture before storing its new bytes', async () => {
    const newFull = await sharp({ create: { width: 9, height: 9, channels: 3, background: '#556677' } }).webp().toBuffer();
    const hash = createHash('sha256').update(newFull).digest('hex');
    const response = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers,
      payload: { ...payload, capturedAt: '2026-11-22T10:00:00Z', photos: [{ ...payload.photos[0], fullBase64: newFull.toString('base64') }] } });
    expect(response.statusCode).toBe(409);
    expect(existsSync(path.join(root, 'media', hash.slice(0, 2), `${hash}.webp`))).toBe(false);
  });

  it('does not write media bytes while another SQLite writer owns the database', async () => {
    const newFull = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#778899' } }).webp().toBuffer();
    const hash = createHash('sha256').update(newFull).digest('hex');
    const writer = new DatabaseSync(path.join(root, 'fixture.db'));
    writer.exec('BEGIN IMMEDIATE');
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/media', headers,
        payload: { ...payload, capturedAt: '2026-11-23T14:00:00Z', photos: [{ ...payload.photos[0], fullBase64: newFull.toString('base64') }] } });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(existsSync(path.join(root, 'media', hash.slice(0, 2), `${hash}.webp`))).toBe(false);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('returns a controlled 404 when a referenced media file is missing', async () => {
    const hash = (db.prepare('SELECT full_hash AS hash FROM hosted_media_gallery_photos LIMIT 1').get() as { hash: string }).hash;
    rmSync(path.join(root, 'media', hash.slice(0, 2), `${hash}.webp`));
    const response = await app.inject({ method: 'GET', url: `/api/v1/media/${hash}/full` });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a symlinked media root when serving existing bytes', async () => {
    const hash = (db.prepare('SELECT thumb_hash AS hash FROM hosted_media_gallery_photos LIMIT 1').get() as { hash: string }).hash;
    renameSync(path.join(root, 'media'), path.join(root, 'media-real'));
    symlinkSync(path.join(root, 'media-real'), path.join(root, 'media'));
    const response = await app.inject({ method: 'GET', url: `/api/v1/media/${hash}/thumb` });
    expect(response.statusCode).toBe(404);
  });
});
