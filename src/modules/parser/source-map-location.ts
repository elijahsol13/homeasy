import type { CityKey } from '../../config/settings';
import {
  extractPropertyPinCoordinatesFromMapsUrl,
  isCoordinateInSanityBounds,
  resolveGoogleMapsShortlink,
} from '../../config/locations';

const GOOGLE_MAPS_URL = /https?:\/\/[^\s<>"']+/gi;
const PROPERTY_MAP_LABEL = /(?:^|[📍\s])(?:(?:exact\s+)?property\s+)?(?:exact\s+)?(?:location|address|map(?:s)?|google\s+maps?|see\s+(?:the\s+)?location(?:\s+(?:on|in)\s+(?:google\s+)?maps?)?|view\s+(?:the\s+)?map)(?:\s+(?:on|in)\s+(?:google\s+)?maps?)?\s*[:：=\-–]?\s*$/iu;
const KHMER_PROPERTY_MAP_LABEL = /(?:ទីតាំង(?:ផ្ទះ)?|អាសយដ្ឋាន|ផែនទី)\s*[:៖=\-–]?\s*$/u;
const PROMOTIONAL_LANDMARK = /(?:\b\d+\s*(?:min(?:ute)?s?|km|meters?)\b|\b(?:near|close\s+to|walking\s+distance|minutes?\s+from)\b)[^\n]{0,100}\b(?:pub\s*street|old\s*market|angkor\s*wat|night\s*market|airport)\b/i;

function isGoogleMapsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'maps.app.goo.gl' || host === 'goo.gl' && url.pathname.startsWith('/maps/')) return true;
    const googleHost = host === 'google.com' || host === 'www.google.com' || host === 'maps.google.com'
      || /^www\.google\.(?:[a-z]{2,3}|co\.[a-z]{2})$/.test(host)
      || /^maps\.google\.(?:[a-z]{2,3}|co\.[a-z]{2})$/.test(host);
    return googleHost && (url.pathname.startsWith('/maps')
      || host === 'maps.google.com' && ['q', 'query'].some(key => url.searchParams.has(key)));
  } catch { return false; }
}

/** A resolved URL may be used only if it remains an HTTPS Google Maps URL. */
export function isGoogleMapsDestinationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && isGoogleMapsUrl(value)
      && url.hostname !== 'maps.app.goo.gl'
      && !(url.hostname === 'goo.gl' && url.pathname.startsWith('/maps/'));
  } catch { return false; }
}

/** Extract a map URL only when the original ad labels it as the property's location.
 * Proximity and travel-time claims never qualify as address evidence. */
export function extractPropertyMapUrlFromText(sourceText: string): string | null {
  const lines = sourceText.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (const match of line.matchAll(GOOGLE_MAPS_URL)) {
      const rawUrl = match[0]!.replace(/[),.;\]}]+$/, '');
      if (!isGoogleMapsUrl(rawUrl)) continue;
      const prefix = line.slice(0, match.index).trim();
      const previous = lineIndex > 0 ? lines[lineIndex - 1]!.trim() : '';
      // Facebook posts often decorate labels with status emojis (e.g.
      // "🟢Location:"). Strip only leading symbols; keep words and digits so
      // marketing claims such as "5 min to Pub Street" remain unlabelled.
      const inlineLabel = prefix.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      const previousLabel = previous.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      const labelledInline = PROPERTY_MAP_LABEL.test(inlineLabel) || KHMER_PROPERTY_MAP_LABEL.test(inlineLabel);
      const labelledPrevious = !prefix && (PROPERTY_MAP_LABEL.test(previousLabel) || KHMER_PROPERTY_MAP_LABEL.test(previousLabel));
      const context = `${previous}\n${line.slice(0, match.index)}`;
      if ((labelledInline || labelledPrevious) && !PROMOTIONAL_LANDMARK.test(context)) return rawUrl;
    }
  }
  return null;
}

export type ResolvedPropertyMap = {
  sourceUrl: string;
  mapsUrl: string;
  latitude?: number;
  longitude?: number;
};

/** Resolve one explicitly property-labelled Google Maps URL. Coordinates are
 * accepted only from a selected place pin or an explicit numeric search, and
 * must fit the source city's bounds. */
export async function resolvePropertyMapFromText(
  sourceText: string,
  city: CityKey,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedPropertyMap | null> {
  const sourceUrl = extractPropertyMapUrlFromText(sourceText);
  if (!sourceUrl) return null;
  const resolved = await resolveGoogleMapsShortlink(sourceUrl, 4000, fetchImpl);
  const coordinates = extractPropertyPinCoordinatesFromMapsUrl(resolved.resolvedUrl) ?? resolved.coordinates;
  if (!coordinates || !isCoordinateInSanityBounds(coordinates.latitude, coordinates.longitude, city)) {
    return { sourceUrl, mapsUrl: resolved.resolvedUrl };
  }
  return {
    sourceUrl,
    mapsUrl: resolved.resolvedUrl,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };
}
