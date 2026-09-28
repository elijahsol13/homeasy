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

const MAX_HTML_BYTES = 5 * 1024 * 1024;

export async function fetchKhmer24Html(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.status === 403 || response.status === 429) {
      throw new Khmer24HttpFallbackError(`Khmer24 returned HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`Khmer24 returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error('Khmer24 HTML response exceeds size limit');
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('Khmer24 HTML response exceeds size limit');
    if (/just a moment|attention required|cf-chl-|cloudflare/i.test(html.slice(0, 20_000))) {
      throw new Khmer24HttpFallbackError('Khmer24 challenge page detected');
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
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
