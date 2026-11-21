import { createHash } from 'node:crypto';

/**
 * Facebook rotates CDN shard hosts and signed query parameters between reads.
 * The path contains the stable media object id; exclude host and query for
 * Facebook CDN URLs so transport signatures do not create false media edits.
 */
export function stableMediaIdentity(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'fbcdn.net' || host.endsWith('.fbcdn.net')) return `fbcdn:${url.pathname}`;
    return `${host}${url.pathname}`;
  } catch {
    return null;
  }
}

export function stableMediaHash(rawUrls: string[]): string | null {
  const identities = [...new Set(rawUrls.map(stableMediaIdentity).filter((value): value is string => Boolean(value)))].sort();
  return identities.length ? createHash('sha256').update(identities.join('\n')).digest('hex') : null;
}

export function knownFacebookMediaUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const listing = record.listing;
  const fromListing = listing && typeof listing === 'object' && !Array.isArray(listing)
    ? (listing as Record<string, unknown>).photos : undefined;
  const assets = Array.isArray(record.photoAssets) ? record.photoAssets.flatMap((asset: unknown) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return [];
    return [(asset as Record<string, unknown>).url];
  }) : [];
  return [...new Set([record.photos, fromListing].flatMap((value) => Array.isArray(value) ? value : [])
    .concat(assets).filter((url): url is string => typeof url === 'string' && stableMediaIdentity(url) !== null))];
}

/**
 * A partial Facebook observation can refresh a known signed CDN URL without
 * proving that unobserved gallery photos were removed. Keep the prior payload
 * (including extraction), replacing only URLs for the same CDN pathname.
 * New media identities are handled by the normal media-version pipeline.
 */
export function mergeKnownFacebookPhotoUrls(previous: unknown, observed: unknown, acceptRenewals: boolean):
  { payload: Record<string, unknown>; refreshed: boolean } | null {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)
      || !observed || typeof observed !== 'object' || Array.isArray(observed)) return null;
  const oldPayload = previous as Record<string, unknown>;
  const newPayload = observed as Record<string, unknown>;

  const oldUrls = knownFacebookMediaUrls(oldPayload);
  const newUrls = knownFacebookMediaUrls(newPayload);
  if (!oldUrls.length || !newUrls.length) return null;
  const existing = new Set(oldUrls.map(stableMediaIdentity));
  if (newUrls.some((url) => !existing.has(stableMediaIdentity(url)))) return null;

  const replacements = new Map<string, string>();
  if (acceptRenewals) for (const url of newUrls) {
    const identity = stableMediaIdentity(url);
    if (identity?.startsWith('fbcdn:')) replacements.set(identity, url);
  }
  let refreshed = false;
  const replaceUrl = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const identity = stableMediaIdentity(value);
      const replacement = identity && replacements.get(identity);
      if (replacement && replacement !== value) {
        refreshed = true;
        return replacement;
      }
    }
    return value;
  };
  const payload = { ...oldPayload };
  if (Array.isArray(payload.photos)) payload.photos = payload.photos.map(replaceUrl);
  if (Array.isArray(payload.photoAssets)) payload.photoAssets = payload.photoAssets.map((asset: unknown) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset;
    const photo = asset as Record<string, unknown>;
    return { ...photo, url: replaceUrl(photo.url) };
  });
  const listing = payload.listing;
  if (listing && typeof listing === 'object' && !Array.isArray(listing)) {
    const current = listing as Record<string, unknown>;
    if (Array.isArray(current.photos)) payload.listing = { ...current, photos: current.photos.map(replaceUrl) };
  }
  return { payload, refreshed };
}
