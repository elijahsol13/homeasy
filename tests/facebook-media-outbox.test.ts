import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queueFacebookMedia, flushFacebookMediaOutbox } from '../src/modules/parser/facebook-media-outbox';

describe('Facebook media outbox', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'homeasy-media-outbox-'));
  const payload = { groupId: '123', postId: '1001', capturedAt: '2026-11-23T10:00:00.000Z',
    photos: [{ sourceUrl: 'https://scontent.fbcdn.net/photo.jpg', anchorId: '1', fullBase64: 'AAAA', thumbBase64: 'AAAA' }] };
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('keeps a durable batch until a valid server acknowledgment', async () => {
    queueFacebookMedia(root, payload);
    const url = 'https://example.com/api/v1/internal/facebook/media';
    const token = 'x'.repeat(40);
    await expect(flushFacebookMediaOutbox(root, url, token, async () => new Response('unavailable', { status: 503 })))
      .rejects.toThrow('503');
    expect(readdirSync(root).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    await flushFacebookMediaOutbox(root, url, token, async () => Response.json({ galleryId: 1,
      photos: [{ fullUrl: '/api/v1/media/abc/full', thumbUrl: '/api/v1/media/def/thumb' }] }));
    expect(readdirSync(root).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('serializes simultaneous flushes so one queued gallery is acknowledged once', async () => {
    queueFacebookMedia(root, payload);
    let calls = 0;
    const transport = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ galleryId: 1, photos: [{ fullUrl: '/api/v1/media/abc/full', thumbUrl: '/api/v1/media/def/thumb' }] });
    };
    const results = await Promise.all([
      flushFacebookMediaOutbox(root, 'https://example.com/api/v1/internal/facebook/media', 'x'.repeat(40), transport as typeof fetch),
      flushFacebookMediaOutbox(root, 'https://example.com/api/v1/internal/facebook/media', 'x'.repeat(40), transport as typeof fetch),
    ]);
    expect(results).toEqual([1, 0]);
    expect(calls).toBe(1);
  });
});
