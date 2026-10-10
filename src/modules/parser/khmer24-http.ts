import * as cheerio from 'cheerio';
import type { RawListing } from './schemas';
import type { PropertyCategory } from '../../config/settings';

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

export function parseKhmer24DetailHtml(
  html: string,
  url: string,
  target: Khmer24HttpTarget,
): RawListing {
  const $ = cheerio.load(html);
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
        return {
          title: String(item.name),
          description,
          raw_text: description,
          price: parsePrice(offer.price),
          currency: offer.priceCurrency === 'KHR' ? 'KHR' : 'USD',
          type: target.type ?? 'rent',
          category: target.category,
          location: String(address.streetAddress ?? address.addressLocality ?? '') || undefined,
          city: target.city,
          photos: images,
          phone: phone || undefined,
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
