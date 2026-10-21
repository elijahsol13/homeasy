import * as cheerio from 'cheerio';
import type { RawListing } from './schemas';
import type { PropertyCategory } from '../../config/settings';
import { calculateDistanceKm, extractCoordinatesFromMapsUrl, isCoordinateInSanityBounds } from '../../config/locations';
import { isKnownKhmer24AdministrativePin } from './source-geography';

export interface Khmer24HttpTarget {
  category: PropertyCategory;
  city: 'siem_reap' | 'phnom_penh';
  type?: 'rent' | 'sale';
}

export class Khmer24HttpFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Khmer24HttpFallbackError';
  }
}

export interface Khmer24FetchDiagnostic {
  category: 'DNS' | 'CONNECT_TIMEOUT' | 'REQUEST_TIMEOUT' | 'CONNECTION_REFUSED' | 'CONNECTION_RESET' | 'TLS' | 'HTTP' | 'ABORTED' | 'RUNTIME';
  error: { name?: string; message?: string };
  cause?: {
    name?: string;
    message?: string;
    code?: string;
    errno?: string | number;
    syscall?: string;
    hostname?: string;
  };
  http?: { status: number; finalUrl: string };
}

export class Khmer24HttpResponseError extends Khmer24HttpFallbackError {
  readonly diagnostic: Khmer24FetchDiagnostic;

  constructor(status: number, finalUrl: string) {
    super(`Khmer24 returned HTTP ${status}`);
    this.name = 'Khmer24HttpResponseError';
    this.diagnostic = {
      category: 'HTTP',
      error: { name: this.name, message: this.message },
      http: { status, finalUrl },
    };
  }
}

export class Khmer24HttpTransportError extends Khmer24HttpFallbackError {
  readonly diagnostic: Khmer24FetchDiagnostic;

  constructor(diagnostic: Khmer24FetchDiagnostic) {
    super(formatKhmer24FetchDiagnostic(diagnostic));
    this.name = 'Khmer24HttpTransportError';
    this.diagnostic = diagnostic;
  }
}

export interface Khmer24HtmlResponse {
  html: string;
  status: number;
  finalUrl: string;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const KHMER24_HTTP_TIMEOUT_MS = 20_000;
const K24_DEAD_MARKERS = [
  /this ad is no longer available/i,
  /ad has been removed/i,
  /ad has expired/i,
  /listing has expired/i,
  /no longer available/i,
  /page not found/i,
  /oops!.*not found/i,
];
const K24_CHALLENGE_MARKER = /just a moment|attention required|cf-chl-|cloudflare/i;

type ErrorFields = Record<string, unknown>;

function errorFields(value: unknown): ErrorFields {
  return value !== null && typeof value === 'object' ? value as ErrorFields : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalErrno(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Redacts fetch failures to the small, safe set needed for operational
 * diagnosis. It deliberately excludes request headers, response bodies, and
 * arbitrary error properties that could contain credentials.
 */
export function describeKhmer24FetchFailure(error: unknown): Khmer24FetchDiagnostic {
  if (error instanceof Khmer24HttpResponseError || error instanceof Khmer24HttpTransportError) return error.diagnostic;

  const outer = errorFields(error);
  const cause = errorFields(outer.cause);
  const code = optionalString(cause.code) ?? optionalString(outer.code);
  const name = optionalString(outer.name) ?? 'Error';
  const message = optionalString(outer.message) ?? String(error);
  const causeName = optionalString(cause.name);
  const causeMessage = optionalString(cause.message);
  let category: Khmer24FetchDiagnostic['category'] = 'RUNTIME';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') category = 'DNS';
  else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') category = 'CONNECT_TIMEOUT';
  else if (code === 'ECONNREFUSED') category = 'CONNECTION_REFUSED';
  else if (code === 'ECONNRESET') category = 'CONNECTION_RESET';
  else if (name === 'AbortError') category = 'ABORTED';
  else if (/tls|ssl|certificate|cert_/i.test(`${code ?? ''} ${name} ${message} ${causeName ?? ''} ${causeMessage ?? ''}`)) category = 'TLS';
  const diagnostic: Khmer24FetchDiagnostic = {
    category,
    error: { name, message },
  };
  if (Object.keys(cause).length > 0) {
    diagnostic.cause = {
      name: causeName,
      message: causeMessage,
      code,
      errno: optionalErrno(cause.errno) ?? optionalErrno(outer.errno),
      syscall: optionalString(cause.syscall) ?? optionalString(outer.syscall),
      hostname: optionalString(cause.hostname) ?? optionalString(outer.hostname),
    };
  }
  return diagnostic;
}

export function formatKhmer24FetchDiagnostic(diagnostic: Khmer24FetchDiagnostic): string {
  if (diagnostic.http) return `HTTP ${diagnostic.http.status} from ${diagnostic.http.finalUrl}`;
  const cause = diagnostic.cause;
  const code = cause?.code ? ` [${cause.code}]` : '';
  const detail = cause?.message ?? diagnostic.error.message ?? 'unknown error';
  return `${diagnostic.category}: ${detail}${code}`;
}

export function isKhmer24ChallengePage(html: string, title = ''): boolean {
  return K24_CHALLENGE_MARKER.test(`${title}\n${html.slice(0, 20_000)}`);
}

export async function fetchKhmer24HtmlResponse(url: string): Promise<Khmer24HtmlResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KHMER24_HTTP_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Khmer24HttpTransportError({
          category: 'REQUEST_TIMEOUT',
          error: { name: 'TimeoutError', message: `Khmer24 request timed out after ${KHMER24_HTTP_TIMEOUT_MS}ms` },
        });
      }
      throw new Khmer24HttpTransportError(describeKhmer24FetchFailure(error));
    }
    if (response.status === 403 || response.status === 429) {
      throw new Khmer24HttpResponseError(response.status, response.url);
    }
    if (!response.ok) throw new Khmer24HttpResponseError(response.status, response.url);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error('Khmer24 HTML response exceeds size limit');
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('Khmer24 HTML response exceeds size limit');
    if (isKhmer24ChallengePage(html)) {
      throw new Khmer24HttpFallbackError('Khmer24 challenge page detected');
    }
    return { html, status: response.status, finalUrl: response.url };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchKhmer24Html(url: string): Promise<string> {
  return (await fetchKhmer24HtmlResponse(url)).html;
}

/** Classifies already-fetched text only; it never issues a request. */
export function classifyKhmer24PageLiveness(html: string): 'alive' | 'dead' | 'unknown' {
  if (!html) return 'unknown';
  const head = html.slice(0, 200_000);
  if (/"@type"\s*:\s*"Product"/.test(head)) return 'alive';
  if (K24_DEAD_MARKERS.some((expression) => expression.test(head))) return 'dead';
  if (html.includes('-adid-') || html.includes('__NUXT_DATA__')) return 'unknown';
  return 'unknown';
}

export function parseKhmer24FeedHtml(html: string, maxLinks = 15): string[] {
  const $ = cheerio.load(html);
  const rawText = $('#__NUXT_DATA__').text();
  if (!rawText) throw new Khmer24HttpFallbackError('Khmer24 feed has no __NUXT_DATA__ payload');

  let raw: unknown[];
  try {
    raw = JSON.parse(rawText) as unknown[];
  } catch {
    throw new Khmer24HttpFallbackError('Khmer24 feed has malformed __NUXT_DATA__ payload');
  }

  const resolve = (value: unknown): unknown => typeof value === 'number' ? raw[value] : value;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const object = item as Record<string, unknown>;
    if (!('total' in object) || !('data' in object) || !('limit' in object)) continue;
    const data = resolve(object.data);
    if (!data || typeof data !== 'object') continue;
    const postIndices = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
    const urls: string[] = [];
    for (const index of postIndices) {
      if (urls.length >= maxLinks) break;
      const wrapper = resolve(index);
      if (!wrapper || typeof wrapper !== 'object') continue;
      const post = resolve((wrapper as Record<string, unknown>).data);
      if (!post || typeof post !== 'object') continue;
      const link = resolve((post as Record<string, unknown>).link);
      if (typeof link !== 'string' || !link.includes('-adid-')) continue;
      urls.push(link.startsWith('http') ? link : `https://www.khmer24.com${link}`);
    }
    if (urls.length > 0) return [...new Set(urls)];
  }

  throw new Khmer24HttpFallbackError('Khmer24 feed payload contains no listing links');
}

function parsePrice(value: unknown): number | undefined {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Keep a source-provided publication timestamp as written; do not infer a timezone. */
export function khmer24PublishedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(date)) return undefined;
  return Number.isFinite(Date.parse(date)) ? date : undefined;
}

/** Nuxt's detail payload holds the ORIGINAL publication date separately from
 * renew_date, which may be an automatic bump and must not reset freshness. */
function khmer24DetailPost(payload: string, url: string): {
  post: Record<string, unknown>; resolve: (value: unknown) => unknown;
} | null {
  const adId = /-adid-(\d+)(?:\/?(?:[?#]|$))/.exec(url)?.[1];
  if (!adId || !payload) return null;
  try {
    const nodes: unknown = JSON.parse(payload);
    if (!Array.isArray(nodes)) return null;
    const resolve = (value: unknown): unknown => typeof value === 'number' &&
      Number.isSafeInteger(value) && value >= 0 && value < nodes.length ? nodes[value] : value;
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const post = node as Record<string, unknown>;
      if (String(resolve(post.id)) !== adId ||
          !('posted_date' in post || 'renew_date' in post || 'photos' in post || 'specs' in post)) continue;
      return { post, resolve };
    }
  } catch { /* Invalid or missing Nuxt detail payload. */ }
  return null;
}

export function khmer24OriginalPostedAt(payload: string, url: string): string | undefined {
  const detail = khmer24DetailPost(payload, url);
  return detail ? khmer24PublishedAt(detail.resolve(detail.post.posted_date)) : undefined;
}

/** Khmer24's 'last-7-days' feed includes renewed ads with old original dates.
 * Source timestamps without an offset are local Cambodian time (UTC+07).
 * Missing / unparseable dates are left for the ordinary moderation path. */
export function isStaleKhmer24Original(postedAt: string | undefined, now = Date.now()): boolean {
  if (!postedAt || !khmer24PublishedAt(postedAt)) return false;
  const normalized = postedAt.trim().replace(' ', 'T');
  const sourceTime = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized.length === 10 ? normalized + 'T00:00:00' : normalized}+07:00`;
  const publishedMs = Date.parse(sourceTime);
  return Number.isFinite(publishedMs) && now - publishedMs > 30 * 24 * 60 * 60 * 1000;
}

type SourceGeo = Partial<Pick<RawListing, 'latitude' | 'longitude' | 'maps_url'>>;

function googleMapsLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const link = value.trim().replace(/[),.;]+$/, '');
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'maps.app.goo.gl' || hostname === 'goo.gl' && url.pathname.startsWith('/maps/') ||
        /^(?:(?:www|maps)\.)?google\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2,3})$/.test(hostname) &&
        (url.pathname.startsWith('/maps') || hostname.startsWith('maps.') && url.pathname === '/' &&
          ['q', 'query', 'll'].some((key) => url.searchParams.has(key)))) return url.toString();
  } catch { /* Ignore text that is not a direct Google Maps URL. */ }
  return undefined;
}

/** Only literal, property-labelled map links; never infer a pin from "5 minutes to Pub Street". */
function propertyMapFromText(description: string): string | undefined {
  for (const line of description.split(/\r?\n/)) {
    const match = /https?:\/\/[^\s<>"']+/i.exec(line);
    if (!match) continue;
    const link = googleMapsLink(match[0]);
    if (!link) continue;
    const before = line.slice(0, match.index).trim();
    if (/\b(?:\d+\s*(?:min(?:ute)?s?|km|meters?)\b|near|close to|walking distance|landmark|pub street)\b/i.test(before)) continue;
    if (/(?:exact |property |house |villa |apartment )?(?:location|address|pin|google maps?|map link)\s*[:\-–]?\s*$/i.test(before) ||
        /(?:ទីតាំង(?:ផ្ទះ)?|អាសយដ្ឋាន|ផែនទី)\s*[:៖\-–]?\s*$/.test(before)) return link;
  }
  return undefined;
}

/** A Maps camera centre (@lat,lng) is not evidence of the property's position.
 * Only a selected Maps place or explicit coordinate search can supply a pin. */
function propertyPinFromMapsLink(url: string): { latitude: number; longitude: number } | null {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* Ignore malformed URL encoding. */ }
  if (!/!3d-?\d+\.\d{4,}!4d-?\d+\.\d{4,}|[?&](?:q|query)=-?\d+\.\d{4,},-?\d+\.\d{4,}/i.test(decoded)) {
    return null;
  }
  return extractCoordinatesFromMapsUrl(url);
}

/** Only ad-specific GPS and explicitly labelled property maps are exact.
 * Khmer24's post.location.map belongs to an administrative location; the
 * same coordinates can occur in unrelated listings and must remain coarse. */
export function khmer24SourceLocation(
  payload: string, url: string, city: Khmer24HttpTarget['city'], description = '',
): SourceGeo {
  const detail = khmer24DetailPost(payload, url);
  const resolve = detail?.resolve ?? ((value: unknown) => value);
  const post = detail?.post ?? {};
  const asRecord = (value: unknown): Record<string, unknown> => {
    const resolved = resolve(value);
    return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
      ? resolved as Record<string, unknown> : {};
  };
  const map = asRecord(post.map);
  // post.location.map is part of the administrative-area object, not an
  // ad-specific marker. Multiple unrelated Siem Reap listings share its x/y
  // (including homes in different districts); never promote it to house GPS.
  const nested = [map, asRecord(post.geo), asRecord(post.coordinates), asRecord(post.map_location)];
  const candidates = detail ? [post, ...nested] : [];
  let pin: { latitude: number; longitude: number } | undefined;
  for (const candidate of candidates) {
    const rawLat = resolve(candidate.latitude ?? candidate.lat ?? candidate.map_latitude ?? candidate.map_lat);
    const rawLng = resolve(candidate.longitude ?? candidate.lng ?? candidate.lon ?? candidate.map_longitude ?? candidate.map_lng);
    const lat = typeof rawLat === 'number' || typeof rawLat === 'string' ? Number(rawLat) : NaN;
    const lng = typeof rawLng === 'number' || typeof rawLng === 'string' ? Number(rawLng) : NaN;
    // Four decimal places or better: do not mislabel coarse districts as an exact property pin.
    if (!/^-?\d+\.\d{4,}$/.test(String(rawLat)) || !/^-?\d+\.\d{4,}$/.test(String(rawLng))) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng) && isCoordinateInSanityBounds(lat, lng, city)
        && !isKnownKhmer24AdministrativePin(lat, lng)) {
      pin = { latitude: lat, longitude: lng };
      break;
    }
  }
  const urlValues = [post.maps_url, post.map_url, post.google_maps_url, post.google_map_url,
    map.url, map.link, map.maps_url, map.google_maps_url];
  const textMap = propertyMapFromText(description);
  const sourceMaps = urlValues.map(resolve).map(googleMapsLink).filter((value): value is string => Boolean(value));
  // A camera-only/coarse/contradictory source URL must not mask a valid
  // property-labelled map link found in the description.
  const mapCandidates = [...new Set([...sourceMaps, ...(textMap ? [textMap] : [])])];
  let validMapsUrl: string | undefined;
  let selectedPin = pin;
  let coordinateFreeMapUrl: string | undefined;
  for (const mapsUrl of mapCandidates) {
    const anyMapCoordinates = extractCoordinatesFromMapsUrl(mapsUrl);
    const urlPin = propertyPinFromMapsLink(mapsUrl);
    const safeUrlPin = urlPin && isCoordinateInSanityBounds(urlPin.latitude, urlPin.longitude, city)
      && !isKnownKhmer24AdministrativePin(urlPin.latitude, urlPin.longitude) ? urlPin : null;
    // A URL with camera-only (@/ll), imprecise or out-of-city coordinates
    // cannot be passed through: canonical ingestion would mark them exact.
    if (anyMapCoordinates && !safeUrlPin) continue;
    if (pin && safeUrlPin &&
        calculateDistanceKm(pin.latitude, pin.longitude, safeUrlPin.latitude, safeUrlPin.longitude) >= 0.25) continue;
    if (safeUrlPin) {
      validMapsUrl = mapsUrl;
      selectedPin = pin ?? safeUrlPin;
      break;
    }
    // Keep a Google Maps shortlink or place URL without coordinates for
    // navigation, but continue looking for an explicit GPS link.
    coordinateFreeMapUrl ??= mapsUrl;
  }
  validMapsUrl ??= coordinateFreeMapUrl;
  return {
    ...(selectedPin ? { latitude: selectedPin.latitude, longitude: selectedPin.longitude } : {}),
    ...(validMapsUrl ? { maps_url: validMapsUrl } : {}),
  };
}

export function parseKhmer24DetailHtml(
  html: string,
  url: string,
  target: Khmer24HttpTarget,
): RawListing {
  const $ = cheerio.load(html);
  const nuxtPayload = $('#__NUXT_DATA__').text();
  const originalPostedAt = khmer24OriginalPostedAt(nuxtPayload, url);
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const raw = JSON.parse($(element).text()) as unknown;
      const items = Array.isArray(raw) ? raw : [raw];
      for (const value of items) {
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        if (item['@type'] !== 'Product' || !item.name) continue;
        const offer = item.offers && typeof item.offers === 'object'
          ? item.offers as Record<string, unknown>
          : {};
        const seller = offer.seller && typeof offer.seller === 'object'
          ? offer.seller as Record<string, unknown>
          : {};
        const address = seller.address && typeof seller.address === 'object'
          ? seller.address as Record<string, unknown>
          : {};
        const phones = Array.isArray(seller.telephone)
          ? seller.telephone.map(String)
          : seller.telephone ? [String(seller.telephone)] : [];
        const images = Array.isArray(item.image) ? item.image.map(String) : item.image ? [String(item.image)] : [];
        const phone = phones.find((entry: string) => !entry.toUpperCase().includes('X')) ?? phones[0];
        const description = String(item.description ?? '');
        const sourceLocation = khmer24SourceLocation(nuxtPayload, url, target.city, description);
        const postedAt = originalPostedAt ?? khmer24PublishedAt(item.datePublished)
          ?? khmer24PublishedAt($('meta[property="article:published_time"]').attr('content'))
          ?? khmer24PublishedAt($('meta[itemprop="datePublished"]').attr('content'))
          ?? khmer24PublishedAt($('meta[name="datePublished"]').attr('content'));
        return {
          title: String(item.name),
          source_title: String(item.name),
          description,
          raw_text: description,
          price: parsePrice(offer.price),
          source_price: parsePrice(offer.price),
          ...(parsePrice(offer.price) ? {
            source_price_currency: offer.priceCurrency === 'KHR' ? 'KHR' as const :
              offer.priceCurrency === 'USD' ? 'USD' as const : undefined,
            source_price_origin: 'khmer24_json_ld_offer' as const,
          } : {}),
          currency: offer.priceCurrency === 'KHR' ? 'KHR' : 'USD',
          type: target.type ?? 'rent',
          category: target.category,
          location: String(address.streetAddress ?? address.addressLocality ?? '') || undefined,
          city: target.city,
          photos: images,
          phone: phone || undefined,
          posted_at: postedAt,
          ...sourceLocation,
          url,
          source_url: url,
        };
      }
    } catch (error) {
      void error;
    }
  }

  throw new Khmer24HttpFallbackError('Khmer24 detail has no usable Product JSON-LD');
}
