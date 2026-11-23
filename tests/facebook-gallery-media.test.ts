import sharp from 'sharp';
import type { Page } from 'playwright';
import { parseVerifiedPostGallery, convertGalleryPhoto, captureFacebookPostMedia, selectMediaCaptureRequests } from '../src/modules/parser/facebook-gallery-media';

const postUrl = 'https://www.facebook.com/groups/123/posts/1001/';
const article = (images: string, href = '/groups/123/posts/1001/') =>
  `<div role="article"><a href="${href}">Post</a>${images}</div>`;
const photo = (id: string) => `<a href="/photo/?fbid=${id}"><img src="https://scontent.xx.fbcdn.net/${id}.jpg"></a>`;

describe('source-bound Facebook gallery', () => {
  it('rejects empty, partial, wrong post and duplicate photo anchors', () => {
    expect(parseVerifiedPostGallery(article(''), postUrl, 2)).toBeNull();
    expect(parseVerifiedPostGallery(article(photo('1')), postUrl, 2)).toBeNull();
    expect(parseVerifiedPostGallery(article(photo('1') + photo('2'), '/groups/123/posts/9999/'), postUrl, 2)).toBeNull();
    expect(parseVerifiedPostGallery(article(photo('1') + photo('1')), postUrl, 2)).toBeNull();
  });

  it('preserves exactly the verified article photo order', () => {
    expect(parseVerifiedPostGallery(article(photo('2') + photo('1')), postUrl, 2)).toEqual([
      { anchorId: '2', sourceUrl: 'https://scontent.xx.fbcdn.net/2.jpg' },
      { anchorId: '1', sourceUrl: 'https://scontent.xx.fbcdn.net/1.jpg' },
    ]);
  });

  it('converts to bounded WebP derivatives without source metadata', async () => {
    const jpeg = await sharp({ create: { width: 1800, height: 900, channels: 3, background: '#112233' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'private-marker' } } }).jpeg().toBuffer();
    const result = await convertGalleryPhoto(jpeg);
    const full = await sharp(result.full).metadata();
    const thumb = await sharp(result.thumb).metadata();
    expect(full.format).toBe('webp');
    expect(full.width).toBe(1600);
    expect(thumb.width).toBe(400);
    expect(full.exif).toBeUndefined();
    expect(thumb.exif).toBeUndefined();
  });

  it('waits for the same complete post gallery twice and prepares a bounded upload', async () => {
    const image = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#224466' } }).jpeg().toBuffer();
    const ready = article(photo('1') + photo('2'));
    const snapshots = [article(''), ready, ready];
    const page = {
      goto: async () => {}, url: () => postUrl,
      content: async () => snapshots.shift() ?? ready,
      waitForTimeout: async () => {},
    } as unknown as Page;
    const fetcher = async () => new Response(image, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    const batch = await captureFacebookPostMedia(page, postUrl, 2, fetcher as typeof fetch);
    expect(batch?.photos.map((item) => item.anchorId)).toEqual(['1', '2']);
    expect(batch?.photos.every((item) => item.fullBase64.length > 0 && item.thumbBase64.length > 0)).toBe(true);
  });

  it('only selects explicitly requested posts present in the ingested group batch', () => {
    const listings = [{ source_url: postUrl, facebook_post_id: '1001', photos: [] }];
    const requests = [
      { postUrl, expectedCount: 2 },
      { postUrl: 'https://www.facebook.com/groups/123/posts/9999/', expectedCount: 2 },
      { postUrl: 'https://www.facebook.com/groups/999/posts/1001/', expectedCount: 2 },
      { postUrl, expectedCount: 0 },
    ];
    expect(selectMediaCaptureRequests(listings, requests)).toEqual([{ postUrl, expectedCount: 2 }]);
  });
});
