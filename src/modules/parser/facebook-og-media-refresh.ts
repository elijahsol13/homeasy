import type { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import { mergeKnownFacebookPhotoUrls, stableMediaIdentity } from './media-identity';

export interface FacebookOgPhotoRequest {
  postUrl: string;
  externalId: string;
  groupId: string;
  knownPhotos: string[];
}

export interface FacebookOgPhotoProof {
  postUrl: string;
  externalId: string;
  groupId: string;
  imageUrl: string;
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PROOF_BYTES = 64;

export function facebookPostIdentity(value: string): { postId: string; groupId: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase())) {
      return null;
    }
    const match = url.pathname.match(/^\/groups\/([a-z\d._-]+)\/(?:posts|permalink)\/(\d+)\/?$/i);
    return match ? { groupId: match[1]!, postId: match[2]! } : null;
  } catch {
    return null;
  }
}

function matchesSavedGroup(urlGroup: string, savedGroupId: string): boolean {
  return urlGroup === savedGroupId || /^\d+$/.test(savedGroupId) && !/^\d+$/.test(urlGroup);
}

function knownFacebookCdnImage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase().endsWith('.fbcdn.net')
      && parsed.pathname.startsWith('/') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > maxBytes) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
    const output = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.byteLength; }
    return output;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readImagePrefix(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const prefix = new Uint8Array(MAX_IMAGE_PROOF_BYTES);
  let count = 0;
  try {
    while (count < prefix.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const length = Math.min(value.byteLength, prefix.length - count);
      prefix.set(value.subarray(0, length), count);
      count += length;
    }
    return prefix.subarray(0, count);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function hasImageSignature(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  if (type === 'image/webp') return bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
  return false;
}

/** Anonymous public-page probe. Every URL is allowlisted and redirects are rejected. */
export async function inspectFacebookOgPhoto(
  request: FacebookOgPhotoRequest, fetcher: typeof fetch = fetch,
): Promise<FacebookOgPhotoProof | null> {
  const requested = facebookPostIdentity(request.postUrl);
  if (!requested || requested.postId !== request.externalId || !matchesSavedGroup(requested.groupId, request.groupId)) return null;
  const knownIdentities = new Set(request.knownPhotos.filter(knownFacebookCdnImage).map(stableMediaIdentity));
  if (!knownIdentities.size) return null;
  try {
    const pageOptions: RequestInit = {
      redirect: 'manual', signal: AbortSignal.timeout(8_000),
      headers: { accept: 'text/html' },
    };
    let page = await fetcher(request.postUrl, pageOptions);
    if ([301, 302, 307, 308].includes(page.status)) {
      const location = page.headers.get('location');
      if (!location) return null;
      const destination = new URL(location, request.postUrl);
      const redirected = facebookPostIdentity(destination.href);
      if (!redirected || redirected.postId !== requested.postId
        || (redirected.groupId !== requested.groupId && redirected.groupId !== request.groupId)) return null;
      await page.body?.cancel();
      page = await fetcher(destination.href, pageOptions);
    }
    if (page.status !== 200 || !page.headers.get('content-type')?.toLowerCase().startsWith('text/html')) return null;
    const rawHtml = await readLimited(page, MAX_HTML_BYTES);
    if (!rawHtml) return null;
    const $ = cheerio.load(new TextDecoder().decode(rawHtml));
    const ogUrls = $('meta[property="og:url"]').toArray().map((element) => $(element).attr('content')?.trim()).filter(Boolean);
    const imageUrls = $('meta[property="og:image"]').toArray().map((element) => $(element).attr('content')?.trim()).filter(Boolean);
    if (new Set(ogUrls).size !== 1 || new Set(imageUrls).size !== 1) return null;
    const ogUrl = ogUrls[0]!;
    const imageUrl = imageUrls[0]!;
    if (!knownFacebookCdnImage(imageUrl)) return null;
    const ogIdentity = facebookPostIdentity(ogUrl);
    if (!ogIdentity || ogIdentity.postId !== requested.postId
      || (ogIdentity.groupId !== requested.groupId && ogIdentity.groupId !== request.groupId)) return null;
    if (!knownIdentities.has(stableMediaIdentity(imageUrl))) return null;
    const image = await fetcher(imageUrl, {
      redirect: 'manual', signal: AbortSignal.timeout(8_000),
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg', range: 'bytes=0-31' },
    });
    if (image.status !== 206 && image.status !== 200) return null;
    const type = image.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return null;
    const bytes = await readImagePrefix(image);
    if (!bytes || !hasImageSignature(bytes, type)) return null;
    return { postUrl: request.postUrl, externalId: request.externalId, groupId: request.groupId, imageUrl };
  } catch {
    return null;
  }
}

/**
 * A narrowly scoped mutation for a separately authorized application.
 * Media-only evidence must never extend offer freshness or create source versions.
 */
export function applyFacebookOgPhotoRenewal(db: DatabaseSync, sourceItemId: number, proof: FacebookOgPhotoProof): boolean {
  const source = db.prepare(`SELECT external_id,group_id,canonical_url,source_url,source_type,classification,raw_payload_json
    FROM source_items WHERE id=?`).get(sourceItemId) as {
      external_id: string; group_id: string | null; canonical_url: string | null; source_url: string | null;
      source_type: string; classification: string; raw_payload_json: string;
    } | undefined;
  if (!source || source.source_type !== 'FACEBOOK_GROUP' || source.classification !== 'HOUSING_SUPPLY') return false;
  const saved = facebookPostIdentity(source.canonical_url ?? source.source_url ?? '');
  const supplied = facebookPostIdentity(proof.postUrl);
  if (!saved || !supplied || saved.postId !== supplied.postId || saved.groupId !== supplied.groupId
    || saved.postId !== source.external_id || source.external_id !== proof.externalId
    || !matchesSavedGroup(saved.groupId, proof.groupId) || (source.group_id && source.group_id !== proof.groupId)
    || !knownFacebookCdnImage(proof.imageUrl)) return false;

  let existing: unknown;
  try { existing = JSON.parse(source.raw_payload_json); } catch { return false; }
  const merged = mergeKnownFacebookPhotoUrls(existing, { photos: [proof.imageUrl] }, true);
  if (!merged?.refreshed) return false;
  const newIdentity = stableMediaIdentity(proof.imageUrl);

  db.exec('SAVEPOINT facebook_og_photo_renewal');
  try {
    const media = db.prepare(`SELECT mo.id AS joinId,ma.id AS assetId,ma.source_url AS url
      FROM media_asset_source_occurrences mo JOIN media_assets ma ON ma.id=mo.media_asset_id
      WHERE mo.source_item_id=?`).all(sourceItemId) as Array<{ joinId: number; assetId: number; url: string }>;
    for (const old of media.filter((row) => stableMediaIdentity(row.url) === newIdentity && row.url !== proof.imageUrl)) {
      db.prepare(`INSERT INTO media_assets
        (source_item_id,source_occurrence_id,listing_id,property_id,source_url,normalized_url,mime_type,width,height,
         content_hash,perceptual_hash,hash_algorithm,hash_version,download_status,first_seen_at,last_seen_at)
        SELECT source_item_id,source_occurrence_id,listing_id,property_id,?,?,mime_type,width,height,
          content_hash,perceptual_hash,hash_algorithm,hash_version,download_status,first_seen_at,last_seen_at
        FROM media_assets WHERE id=?
        ON CONFLICT(normalized_url) WHERE normalized_url IS NOT NULL DO NOTHING`)
        .run(proof.imageUrl, proof.imageUrl, old.assetId);
      const target = db.prepare('SELECT id FROM media_assets WHERE normalized_url=?').get(proof.imageUrl) as { id: number };
      db.prepare(`INSERT INTO media_asset_source_occurrences
        (media_asset_id,source_item_id,source_occurrence_id,listing_id,property_id)
        SELECT ?,source_item_id,source_occurrence_id,listing_id,property_id
        FROM media_asset_source_occurrences WHERE id=?
        ON CONFLICT(media_asset_id,source_item_id) DO NOTHING`).run(target.id, old.joinId);
      db.prepare('DELETE FROM media_asset_source_occurrences WHERE id=?').run(old.joinId);
      db.prepare(`DELETE FROM media_assets WHERE id=? AND NOT EXISTS (
        SELECT 1 FROM media_asset_source_occurrences WHERE media_asset_id=?)`).run(old.assetId, old.assetId);
    }
    db.prepare('UPDATE source_items SET raw_payload_json=? WHERE id=?')
      .run(JSON.stringify(merged.payload), sourceItemId);
    db.exec('RELEASE facebook_og_photo_renewal');
    return true;
  } catch (error) {
    db.exec('ROLLBACK TO facebook_og_photo_renewal');
    db.exec('RELEASE facebook_og_photo_renewal');
    throw error;
  }
}
