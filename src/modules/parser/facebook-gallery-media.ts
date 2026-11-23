import * as cheerio from 'cheerio';
import sharp from 'sharp';
import type { Page } from 'playwright';
import type { FacebookMediaBatch } from './facebook-media-outbox';
import type { RawListing } from './schemas';
import { facebookPostIdentity } from './facebook-og-media-refresh';

export interface VerifiedFacebookPhoto {
  anchorId: string;
  sourceUrl: string;
}

export interface MediaCaptureRequest {
  postUrl: string;
  expectedCount: number;
}

/** Explicit opt-in only: a request must match a post admitted to this exact ingestion batch. */
export function selectMediaCaptureRequests(listings: RawListing[], requests: MediaCaptureRequest[]): MediaCaptureRequest[] {
  const available = new Set(listings.flatMap((listing) => {
    const identity = facebookPostIdentity(listing.source_url ?? listing.url ?? '');
    return identity && (!listing.facebook_post_id || listing.facebook_post_id === identity.postId)
      ? [`${identity.groupId}:${identity.postId}`] : [];
  }));
  const selected = new Map<string, MediaCaptureRequest>();
  for (const request of requests) {
    const identity = facebookPostIdentity(request.postUrl);
    if (!identity || !Number.isSafeInteger(request.expectedCount) || request.expectedCount < 1 || request.expectedCount > 50) continue;
    const key = `${identity.groupId}:${identity.postId}`;
    if (available.has(key) && !selected.has(key)) selected.set(key, request);
  }
  return [...selected.values()];
}

function trustedCdnUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'fbcdn.net' && !host.endsWith('.fbcdn.net')) return null;
    return url.href;
  } catch { return null; }
}

/** A caller must supply a source-backed expected count; an unready or partial article is not publishable. */
export function parseVerifiedPostGallery(html: string, postUrl: string, expectedCount: number): VerifiedFacebookPhoto[] | null {
  const expected = facebookPostIdentity(postUrl);
  if (!expected || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 50) return null;
  const $ = cheerio.load(html);
  const matchingArticles = $('[role="article"]').toArray().filter((article) =>
    $(article).find('a[href]').toArray().some((anchor) => {
      const href = $(anchor).attr('href');
      if (!href) return false;
      const found = facebookPostIdentity(new URL(href, postUrl).href);
      return found?.groupId === expected.groupId && found.postId === expected.postId;
    }));
  if (matchingArticles.length !== 1) return null;
  const photos: VerifiedFacebookPhoto[] = [];
  const anchors = new Set<string>();
  for (const link of $(matchingArticles[0]).find('a[href*="/photo/"]').toArray()) {
    const href = $(link).attr('href');
    if (!href) continue;
    const anchorId = new URL(href, postUrl).searchParams.get('fbid');
    const src = $(link).find('img[src]').first().attr('src');
    const sourceUrl = src ? trustedCdnUrl(src) : null;
    if (!anchorId || !/^\d+$/.test(anchorId) || !sourceUrl || anchors.has(anchorId)) return null;
    anchors.add(anchorId);
    photos.push({ anchorId, sourceUrl });
  }
  return photos.length === expectedCount ? photos : null;
}

/** Sharp drops EXIF by default; both derivatives have fixed upper dimensions. */
export async function convertGalleryPhoto(input: Buffer): Promise<{ full: Buffer; thumb: Buffer }> {
  if (input.length < 1 || input.length > 8_000_000) throw new Error('Source image outside byte limit');
  const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!['jpeg', 'png', 'webp', 'avif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
    throw new Error('Unsupported source image');
  }
  const full = await sharp(input).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 }).toBuffer();
  const thumb = await sharp(input).rotate().resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 65 }).toBuffer();
  return { full, thumb };
}

async function downloadPhoto(url: string, fetcher: typeof fetch): Promise<Buffer> {
  if (!trustedCdnUrl(url)) throw new Error('Untrusted Facebook image URL');
  const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { accept: 'image/jpeg,image/png,image/webp,image/avif' } });
  if (response.status !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/avif']
    .includes(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '')) {
    await response.body?.cancel();
    throw new Error('Invalid Facebook image response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Facebook image response');
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8_000_000) throw new Error('Facebook image exceeds byte limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) throw new Error('Empty Facebook image');
  return Buffer.concat(chunks);
}

/** Call only on the pinned Mac session with an independently verified expected photo count. */
export async function captureFacebookPostMedia(
  page: Page, postUrl: string, expectedCount: number, fetcher: typeof fetch = fetch,
): Promise<FacebookMediaBatch | null> {
  const identity = facebookPostIdentity(postUrl);
  if (!identity || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 50) return null;
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const landed = facebookPostIdentity(page.url());
  if (!landed || landed.groupId !== identity.groupId || landed.postId !== identity.postId) return null;
  let prior: VerifiedFacebookPhoto[] | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = parseVerifiedPostGallery(await page.content(), postUrl, expectedCount);
    if (current && prior && JSON.stringify(current) === JSON.stringify(prior)) {
      const photos: FacebookMediaBatch['photos'] = [];
      for (const photo of current) {
        const original = await downloadPhoto(photo.sourceUrl, fetcher);
        const converted = await convertGalleryPhoto(original);
        photos.push({ sourceUrl: photo.sourceUrl, anchorId: photo.anchorId,
          fullBase64: converted.full.toString('base64'), thumbBase64: converted.thumb.toString('base64') });
      }
      return { groupId: identity.groupId, postId: identity.postId, capturedAt: new Date().toISOString(), photos };
    }
    prior = current;
    await page.waitForTimeout(1500);
  }
  return null;
}
