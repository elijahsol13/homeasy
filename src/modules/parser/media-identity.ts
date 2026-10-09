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
