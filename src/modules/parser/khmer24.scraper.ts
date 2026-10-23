/**
 * Khmer24 Scraper — Camoufox + Nuxt SSR Parsing
 *
 * Strategy:
 *  - Use pinned Camoufox with Playwright to load Khmer24 feed/detail pages.
 *  - Attach the traffic guard to avoid unnecessary heavy resources.
 *  - Extract province/category-verified listing URLs from Nuxt SSR feed data.
 *  - Visit selected listing pages in the same browser context.
 *  - Extract raw text, price, and apply the "-b.jpg" trick for high-res photos.
 *  - Yield the raw data to the AI-First Ingestor pipeline for semantic extraction.
 */

import path from 'path';
import fs from 'fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { RawListing } from './schemas';
import { classifyKhmer24DetailLiveness } from './khmer24-liveness';
import { runMigrations } from '../../database/migrate';
import { assertLegacyPropertiesUnchanged, installLegacyPropertiesWriteGuard, snapshotLegacyProperties } from '../../database/legacy-write-guard';
import type { AppContainer } from '../../container';
import { createContainer } from '../../container';
import type { PropertyCategory } from '../../config/settings';
import { Khmer24LiveAdapter, type LiveListingEnvelope } from './live-source-adapters';
import {
  extractListingsBatchWithLLM,
  categoryFromPropertyType,
  isExcessiveKhmer,
  type LLMExtractedListing,
} from './extractor';
import { isNonRealEstateSpam } from './spam-detector';
import { findCanonicalLocation, isCoordinateInSanityBounds, resolveGoogleMapsShortlink } from '../../config/locations';
import { launchCamoufox, type CamoufoxBrowser } from './camoufox-server';
import { attachTrafficGuard } from './traffic-guard';
import { isStaleKhmer24Original, khmer24OriginalPostedAt, khmer24PublishedAt, khmer24SourceLocation } from './khmer24-http';
import { isKnownKhmer24AdministrativePin } from './source-geography';
import { factualListingFallback } from './listing-editorial';

export const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');
export const K24_DEVICE_PATH = path.join(process.cwd(), 'data', 'k24_device.json');

export class Khmer24SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Khmer24SessionExpiredError';
  }
}

/** A dead Playwright browser cannot be reused for another Khmer24 detail. */
export function isKhmer24BrowserClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /browser closed|browser has been closed|target page, context or browser has been closed/i.test(message);
}

// ─── Target Definitions ───────────────────────────────────────────────────────

export interface ScrapeTarget {
  name: string;
  category: PropertyCategory;
  city: 'siem_reap' | 'phnom_penh';
  type?: 'rent' | 'sale';
  categorySlug: string;
  locationSlug: string;
}

export const KHMER24_TARGETS: ScrapeTarget[] = [
  { name: 'Siem Reap — Houses for Rent', category: 'house', city: 'siem_reap', type: 'rent', categorySlug: 'house-for-rent', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Apartments & Condos for Rent', category: 'apartment', city: 'siem_reap', type: 'rent', categorySlug: 'apartment-for-rent', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Rooms for Rent', category: 'room', city: 'siem_reap', type: 'rent', categorySlug: 'room-for-rent', locationSlug: 'siem-reap' },
];

export function buildFeedPageUrl(target: ScrapeTarget): string {
  // Khmer24 recognizes province=siem-reap; location=siem-reap leaves the city unselected.
  return `https://www.khmer24.com/en/c-${target.categorySlug}?province=${target.locationSlug}&sortby=newads&date=last-7-days`;
}

/**
 * Khmer24 places promoted ads from other provinces at the start of a filtered
 * Nuxt feed. Resolve the SSR references and enforce the actual post province
 * before applying the listing limit. Do not fall back to unfiltered DOM links.
 */
export function parseKhmer24FeedNuxtData(
  payload: string,
  target: Pick<ScrapeTarget, 'locationSlug' | 'categorySlug'>,
  maxLinks: number,
): string[] {
  if (!payload || maxLinks <= 0) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const resolve = (value: unknown): unknown => typeof value === 'number' ? raw[value] : value;
  const asObject = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;

  for (const item of raw) {
    const feed = asObject(item);
    if (!feed || !('total' in feed) || !('limit' in feed) || !('data' in feed)) continue;
    const data = resolve(feed.data);
    if (data === null || typeof data !== 'object') continue;

    const wrappers = Array.isArray(data) ? data : Object.values(data);
    const links: string[] = [];
    const seen = new Set<string>();
    for (const wrapperRef of wrappers) {
      const wrapper = asObject(resolve(wrapperRef));
      const post = asObject(resolve(wrapper?.data));
      if (!post) continue;

      const location = asObject(resolve(post.location));
      const category = asObject(resolve(post.category));
      if (resolve(location?.slug) !== target.locationSlug || resolve(category?.slug) !== target.categorySlug) {
        continue;
      }

      const link = resolve(post.link);
      if (typeof link !== 'string' || !link.includes('-adid-')) continue;
      let url: URL;
      try {
        url = new URL(link, 'https://www.khmer24.com');
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || !['khmer24.com', 'www.khmer24.com'].includes(url.hostname)) continue;
      const canonical = `${url.origin}${url.pathname}`;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      links.push(canonical);
      if (links.length >= maxLinks) return links;
    }
    if (links.length > 0) return links;
  }
  return [];
}

// ─── Browser Automation Helpers ───────────────────────────────────────────────

/**
 * Checks if Cloudflare blocked the page and throws an error if necessary.
 */
async function checkCloudflareBlock(page: Page, url: string) {
  const title = await page.title().catch(() => '');
  if (title.includes('Attention Required') || title.includes('Just a moment') || title.includes('Cloudflare')) {
    throw new Khmer24SessionExpiredError(`Cloudflare blocked access to: ${url} (Title: "${title}")`);
  }
}

/**
 * Custom Traffic Guard: Blocks unneeded heavy visual assets,
 * but ALLOWS scripts and XHR so Nuxt/Vue can hydrate the page.
 */
async function setupRelaxedTrafficGuard(page: Page) {
  await attachTrafficGuard(page);
}

/**
 * Parses raw price string to number (e.g. "$ 350" -> 350)
 */
function parseRawPrice(priceStr: string): number | undefined {
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

/**
 * Scrapes individual post URLs from the category feed page.
 *
 * Strategy: Khmer24 (Nuxt 3) fully SSR-renders feed data into __NUXT_DATA__.
 * We load the page once, parse the flat dehydrated payload, resolve the `link`
 * field for each post, and return absolute URLs — no Vue hydration needed.
 */
async function fetchListingUrlsFromFeed(
  ctx: BrowserContext,
  target: ScrapeTarget,
  maxLinks = 15,
): Promise<string[]> {
  const feedUrl = buildFeedPageUrl(target);
  const page = await ctx.newPage();

  try {
    await setupRelaxedTrafficGuard(page);
    await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await checkCloudflareBlock(page, feedUrl);

    const payload = await page.evaluate(() => document.getElementById('__NUXT_DATA__')?.textContent ?? '');
    const links = parseKhmer24FeedNuxtData(payload, target, maxLinks);
    if (links.length === 0) console.warn(`⚠️  [Feed Scraper] No eligible ${target.locationSlug} posts in ${feedUrl}`);
    return links;
  } catch (err: unknown) {
    if (isKhmer24BrowserClosedError(err)) throw err;
    console.warn(`⚠️  [Feed Scraper] Error on ${feedUrl}:`, err instanceof Error ? err.message : String(err));
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Scrapes a single listing detail page using JSON-LD Schema.org data.
 *
 * Khmer24 injects a `Product` + `Offer` schema into every detail page:
 *   - description: full post text (no masks)
 *   - offers.price / offers.priceCurrency: clean numeric price in USD
 *   - offers.seller.telephone[]: array of UNMASKED phone numbers
 *   - image[]: array of high-res photo URLs (-b.jpg)
 *   - offers.seller.address.streetAddress: district-level location
 *
 * Falls back to DOM extraction if JSON-LD is missing or malformed.
 */
export async function scrapeListingDetail(ctx: BrowserContext, target: ScrapeTarget, url: string): Promise<RawListing | null> {
  const page = await ctx.newPage();
  let listing: RawListing | null = null;

  try {
    await setupRelaxedTrafficGuard(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await checkCloudflareBlock(page, url);

    const nuxtPayload = await page.evaluate(() => document.getElementById('__NUXT_DATA__')?.textContent ?? '');
    const originalPostedAt = khmer24OriginalPostedAt(nuxtPayload, url);

    // ── Primary: extract from JSON-LD (no hydration needed, pure SSR) ──────────
    const extracted = await page.evaluate(() => {
      // Khmer24 injects a `Product` schema in <script type="application/ld+json">
      const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of ldScripts) {
        try {
          const raw = JSON.parse(script.textContent || '[]');
          // The data is an array: find the Product entry
          const items = Array.isArray(raw) ? raw : [raw];
          for (const item of items) {
            if (item['@type'] !== 'Product' || !item.name) continue;

            const offer = item.offers || {};
            const seller = offer.seller || {};
            const address = seller.address || {};
            const publishedMeta = document.querySelector('meta[property="article:published_time"],meta[itemprop="datePublished"],meta[name="datePublished"]')?.getAttribute('content');

            // Price: offer.price is already a clean number string e.g. "1300.00"
            const priceStr: string = String(offer.price || '');
            const price = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || undefined;
            const sourceCurrency: 'USD' | 'KHR' | undefined =
              offer.priceCurrency === 'USD' || offer.priceCurrency === 'KHR'
                ? offer.priceCurrency : undefined;
            const currency: string = sourceCurrency || 'USD';

            // Phones: seller.telephone is string | string[] — all unmasked
            const rawPhones = seller.telephone;
            const phones: string[] = Array.isArray(rawPhones)
              ? rawPhones
              : rawPhones ? [rawPhones] : [];

            // Photos: item.image is string | string[]
            const rawImages = item.image;
            const photos: string[] = Array.isArray(rawImages)
              ? rawImages
              : rawImages ? [rawImages] : [];

            // Location: street address is the most precise (district level)
            const location: string = address.streetAddress || address.addressLocality || '';

            return {
              title: item.name as string,
              description: item.description as string || '',
              price,
              currency,
              sourceCurrency,
              phone: phones[0] || '',
              allPhones: phones,
              photos,
              location,
              postedAt: item.datePublished || null,
              publishedMeta,
            };
          }
        } catch {
          // malformed JSON-LD — skip
        }
      }
      return null;
    });

    if (extracted && extracted.title) {
      // ✅ JSON-LD succeeded — rich structured data
      const phone = extracted.allPhones.find(p => p && !p.toUpperCase().includes('X'))
        ?? extracted.allPhones[0];

      listing = {
        title: extracted.title,
        description: extracted.description,
        raw_text: extracted.description,
        source_title: extracted.title,
        price: extracted.price,
        currency: extracted.currency as 'USD' | 'KHR',
        ...(extracted.price ? {
          source_price: extracted.price,
          source_price_currency: extracted.sourceCurrency,
          source_price_origin: 'khmer24_json_ld_offer' as const,
        } : {}),
        type: target.type ?? 'rent',
        category: target.category,
        location: extracted.location || undefined,
        city: target.city,
        photos: extracted.photos,
        phone: phone || undefined,
        posted_at: originalPostedAt ?? khmer24PublishedAt(extracted.postedAt) ?? khmer24PublishedAt(extracted.publishedMeta),
        url,
        source_url: url,
      };

      // JSON-LD sometimes omits offers.price — fall back to a DOM scan of the
      // header block (the <p> right under the title carries the price).
      if (!listing.price) {
        const domPriceText = await page.evaluate(() => {
          const priceRe = /(?:\$|USD|KHR|៛|US\$)\s*\d[\d,.]*|\d[\d,.]*\s*(?:USD|KHR|៛|\$)/i;
          const headerRoot =
            document.querySelector('article header') ||
            document.querySelector('article') ||
            document.querySelector('main');
          if (!headerRoot) return '';
          for (const el of Array.from(headerRoot.querySelectorAll('p, span, div'))) {
            if (el.children.length > 0) continue;
            const t = (el.textContent || '').trim();
            if (t.length <= 40 && priceRe.test(t)) return t;
          }
          const el = document.querySelector('[class*="text-error-500"]') || document.querySelector('[class*="price"]');
          return el?.textContent?.trim() || '';
        });
        const domPrice = parseRawPrice(domPriceText);
        if (domPrice) {
          listing.price = domPrice;
          listing.source_price = domPrice;
          listing.source_price_origin = 'khmer24_dom_header';
          listing.source_price_currency = /KHR|៛/i.test(domPriceText) ? 'KHR' : /USD|\$/i.test(domPriceText) ? 'USD' : undefined;
        }
      }
    } else {
      // ── Fallback: DOM extraction (CSS selectors + visible text) ────────────
      // Wait for h1 to confirm page rendered
      await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});

      const domData = await page.evaluate(() => {
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';

        // Price: sits in the article header block, same container as the title —
        // the <p> sibling right below the h1 (per site layout), historically
        // styled text-error-500. Try semantic scan first, then class heuristics.
        const priceRe = /(?:\$|USD|KHR|៛|US\$)\s*\d[\d,.]*|\d[\d,.]*\s*(?:USD|KHR|៛|\$)/i;
        let priceText = '';
        const headerRoot =
          document.querySelector('article header') ||
          document.querySelector('article') ||
          document.querySelector('main');
        if (headerRoot) {
          const nodes = Array.from(headerRoot.querySelectorAll('p, span, div'));
          for (const el of nodes) {
            if (el.children.length > 0) continue; // leaf nodes only
            const t = (el.textContent || '').trim();
            if (t.length <= 40 && priceRe.test(t)) {
              priceText = t;
              break;
            }
          }
        }
        if (!priceText) {
          const priceEl =
            document.querySelector('[class*="text-error-500"]') ||
            document.querySelector('[class*="price"]');
          priceText = priceEl?.textContent?.trim() || '';
        }

        // Description: whitespace-break-spaces paragraph is the post body
        const descEl = document.querySelector('[class*="whitespace-break-spaces"]');
        const description = descEl?.textContent?.trim() || '';

        // Photos from img src
        const imgs: string[] = [];
        document.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('data-src') || img.getAttribute('src') || '';
          if (src.includes('images.khmer24.co')) {
            const hi = src.replace(/-[a-z]\.jpg$/i, '-b.jpg');
            if (!imgs.includes(hi)) imgs.push(hi);
          }
        });

        // Phones from tel: links
        const phones = Array.from(document.querySelectorAll('a[href^="tel:"]'))
          .map(a => a.getAttribute('href')?.replace(/^tel:/i, '') || '')
          .filter(p => p && !p.toUpperCase().includes('X'));

        const postedAt = document.querySelector('meta[property="article:published_time"],meta[itemprop="datePublished"],meta[name="datePublished"]')?.getAttribute('content');

        return { h1, priceText, description, photos: imgs, phones, postedAt };
      });

      if (!domData.h1) return null;

      listing = {
        title: domData.h1,
        description: domData.description,
        raw_text: domData.description,
        source_title: domData.h1,
        price: parseRawPrice(domData.priceText),
        currency: 'USD',
        source_price: parseRawPrice(domData.priceText),
        ...(parseRawPrice(domData.priceText) ? {
          source_price_origin: 'khmer24_dom_header' as const,
          source_price_currency: /KHR|៛/i.test(domData.priceText) ? 'KHR' as const :
            /USD|\$/i.test(domData.priceText) ? 'USD' as const : undefined,
        } : {}),
        type: target.type ?? 'rent',
        category: target.category,
        location: undefined,
        city: target.city,
        photos: domData.photos,
        phone: domData.phones[0] || undefined,
        posted_at: originalPostedAt ?? khmer24PublishedAt(domData.postedAt),
        url,
        source_url: url,
      };
    }
    if (listing) {
      Object.assign(listing, khmer24SourceLocation(nuxtPayload, url, target.city, listing.raw_text ?? ''));
      if (listing.maps_url) {
        const resolvedMap = await resolveGoogleMapsShortlink(listing.maps_url, 2500);
        listing.maps_url = resolvedMap.resolvedUrl;
        const point = resolvedMap.coordinates;
        if (point && isCoordinateInSanityBounds(point.latitude, point.longitude, target.city)
          && !isKnownKhmer24AdministrativePin(point.latitude, point.longitude)) {
          listing.latitude = point.latitude;
          listing.longitude = point.longitude;
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Khmer24SessionExpiredError || isKhmer24BrowserClosedError(err)) throw err;
    console.warn(`⚠️  [Detail Scraper] Error on ${url}:`, err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => {});
    await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000)); // Gentle jitter
  }

  return listing;
}

// ─── Target Scraper ───────────────────────────────────────────────────────────

export async function scrapeTargetWithBrowser(
  browser: Browser,
  target: ScrapeTarget,
  maxListings = 15,
): Promise<RawListing[]> {
  console.log(`\n🔎 Scraping [${target.name}]...`);
  const listings: RawListing[] = [];
  let staleCount = 0;
  let unknownDateCount = 0;

  const contextOptions: Parameters<Browser['newContext']>[0] = {};

  if (fs.existsSync(K24_SESSION_PATH)) {
    contextOptions.storageState = K24_SESSION_PATH;
  }

  const ctx = await browser.newContext(contextOptions);

  try {
    // 1. Get raw URLs from feed
    const urls = await fetchListingUrlsFromFeed(ctx, target, maxListings);
    console.log(`  🔗 Found ${urls.length} raw URLs in feed.`);

    // 2. Process each URL
    for (const url of urls) {
      console.log(`  📄 Processing: ${url.split('/').pop()}`);
      const listing = await scrapeListingDetail(ctx, target, url);
      if (listing) {
        if (isStaleKhmer24Original(listing.posted_at)) {
          staleCount++;
          console.log(`  ⏳ Skipping original post over 30 days old (${listing.posted_at}): ${url.split('/').pop()}`);
          continue;
        }
        if (!listing.posted_at) unknownDateCount++;
        listings.push(listing);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log(`  ✅ Eligible ${listings.length}; skipped stale ${staleCount}; unknown date ${unknownDateCount} [${target.name}]`);
  return listings;
}

/**
 * Use a fresh browser per category to bound Camoufox/Firefox memory growth.
 * A crashed browser discards only this category's in-memory scrape and is
 * restarted once; ingestion happens later, so retries cannot double-ingest.
 */
export async function scrapeTargetWithRecovery(
  target: ScrapeTarget,
  maxListings = 15,
  launchBrowser: () => Promise<CamoufoxBrowser> = () => launchCamoufox({ headless: true, devicePath: K24_DEVICE_PATH }),
): Promise<RawListing[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: CamoufoxBrowser | null = null;
    try {
      handle = await launchBrowser();
      return await scrapeTargetWithBrowser(handle.browser, target, maxListings);
    } catch (err: unknown) {
      if (attempt !== 0 || !isKhmer24BrowserClosedError(err)) throw err;
      console.warn(`⚠️  [Khmer24] Camoufox closed while scraping ${target.name}; restarting this category once.`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  throw new Error(`Khmer24 browser recovery exhausted for ${target.name}`);
}

// ─── AI-First Enrichment (micro-batched, same model cascade as Facebook) ─────

/** Number of listings sent per Gemini request — balances token cost vs. per-item accuracy. */
const LLM_BATCH_SIZE = 6;

/**
 * Rewrites title/description to clean English and backfills structured fields
 * (bedrooms, category, deposit, utilities, etc.) via the Gemini model cascade,
 * sent in micro-batches of `LLM_BATCH_SIZE` to conserve API quota — mirrors the
 * batching pattern used by `scripts/reparse-listings.ts`.
 *
 * Listings the LLM flags as non-real-estate/land, or whose translated description
 * is still >10% Khmer (low translation quality), are dropped. If the batch call
 * fails or omits an item, that listing is ingested with its original scraped
 * text rather than being silently discarded.
 */
const KHMER24_EXTRACTION_HINTS = `
Source: Khmer24. For each item, text includes the source heading and body. The separate
platform_metadata object comes from Khmer24's structured page fields and may contain
defaults, stale categories or errors inserted by the seller. Compare every metadata value
with the headline and free-form description. Explicit text overrides a contradictory form
field; when either is unclear or genuinely conflicting, return null for the disputed fact.
Do not assume an address/price/room-count field exists if it was not supplied. A "for-rent"
section can still contain a sale listing: use is_supported_listing=false for a clear sale.
Return exactly the shared canonical JSON keys including city, sangkat and rejection_reason.
Preserve stated Khmer facts, amounts, units, rates and conditions in accurate English.
`;

/** A missing enrichment result is inconclusive: the extractor also omits low-quality translations. */
export function classifyKhmer24Listing(enriched: RawListing | undefined): NonNullable<LiveListingEnvelope['classification']> {
  if (enriched?.is_real_estate === true) return 'HOUSING_SUPPLY';
  if (enriched?.is_real_estate === false) return 'IRRELEVANT';
  return 'UNCLASSIFIED';
}

export async function enrichListingsWithLLM(
  listings: RawListing[],
  options: { inclusive?: boolean } = {},
): Promise<RawListing[]> {
  if (listings.length === 0) return listings;

  // Pre-filter obvious spam before spending any Gemini quota on it.
  const inclusiveResults = new Map<number, RawListing>();
  const candidates = listings.flatMap((original, originalIndex) => {
    // Preserve the verbatim source heading before the AI replaces title with
    // its English rendering; downstream room checks need the original heading.
    const listing = { ...original, source_title: original.source_title ?? original.title };
    const spamCheck = isNonRealEstateSpam(listing.title ?? '', listing.description ?? '');
    if (spamCheck.isSpam) {
      console.log(`  ⏩ [Skipped - Spam] "${(listing.title ?? '').slice(0, 40)}": ${spamCheck.reason}`);
      if (options.inclusive) {
        inclusiveResults.set(originalIndex, {
          ...listing, is_real_estate: null, review_status: 'pending',
          review_reason: `Spam prefilter: ${spamCheck.reason}`,
        });
      }
      return [];
    }
    return [{ listing, originalIndex }];
  });

  const llmResults = new Map<number, LLMExtractedListing>();
  for (let i = 0; i < candidates.length; i += LLM_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + LLM_BATCH_SIZE);
    const batchInput = chunk.map(({ listing }, idx) => ({
      id: i + idx,
      // Use the source post, not a potentially normalized/translated display
      // description, when extracting facts or verifying literal room counts.
      text: `${listing.source_title ?? listing.title ?? ''}\n\n${listing.raw_text ?? listing.description ?? ''}`.trim(),
      platformMetadata: {
        ...(listing.source_price != null ? { asking_price: listing.source_price } : {}),
        ...(listing.source_price_currency ? { asking_currency: listing.source_price_currency } : {}),
        ...(listing.source_price_origin ? { asking_price_origin: listing.source_price_origin } : {}),
        ...(listing.location ? { platform_location: listing.location } : {}),
        ...(listing.category ? { platform_category: listing.category } : {}),
        ...(listing.bedrooms != null ? { platform_bedrooms: String(listing.bedrooms) } : {}),
        ...(listing.bathrooms != null ? { platform_bathrooms: String(listing.bathrooms) } : {}),
      },
    }));

    console.log(
      `  🚀 [AI Batch ${Math.floor(i / LLM_BATCH_SIZE) + 1}/${Math.ceil(candidates.length / LLM_BATCH_SIZE)}] Rewriting ${chunk.length} listings with Gemini...`,
    );
    try {
      const batchResult = await extractListingsBatchWithLLM(
        batchInput,
        KHMER24_EXTRACTION_HINTS,
      );
      for (const [id, llm] of batchResult) {
        llmResults.set(Number(id), llm);
      }
    } catch (err: unknown) {
      console.warn(`  ⚠️ [AI Batch] Failed, falling back to original text for this chunk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const enriched: RawListing[] = [];
  const fallbackDescription = (listing: RawListing, values: {
    propertyType?: string | null; category?: string | null;
    bedrooms?: number | string | null; bathrooms?: number | string | null;
  } = {}) => factualListingFallback({
    sourceText: `${listing.source_title ?? listing.title ?? ''}\n${listing.raw_text ?? listing.description ?? ''}`,
    propertyType: values.propertyType ?? listing.property_type,
    category: values.category ?? listing.category,
    bedrooms: typeof (values.bedrooms === undefined ? listing.bedrooms : values.bedrooms) === 'number'
      ? Number(values.bedrooms === undefined ? listing.bedrooms : values.bedrooms) : null,
    bathrooms: typeof (values.bathrooms === undefined ? listing.bathrooms : values.bathrooms) === 'number'
      ? Number(values.bathrooms === undefined ? listing.bathrooms : values.bathrooms) : null,
  });
  candidates.forEach(({ listing, originalIndex }, idx) => {
    const llm = llmResults.get(idx);
    if (!llm) {
      const unclassified: RawListing = {
        ...listing,
        description: fallbackDescription(listing),
        review_status: 'pending',
        review_reason: 'LLM extraction unavailable',
        ...(options.inclusive ? { is_real_estate: null } : {}),
      };
      enriched.push(unclassified);
      if (options.inclusive) inclusiveResults.set(originalIndex, unclassified);
      return;
    }

    if (llm.is_real_estate === false || llm.category === 'land') {
      console.log(`  ⏩ [Skipped - Not Residential Real Estate] "${(listing.title ?? '').slice(0, 40)}"`);
      if (options.inclusive) {
        inclusiveResults.set(originalIndex, {
          ...listing,
          is_real_estate: false,
          review_status: 'pending',
          review_reason: llm.admission_reason || llm.canonical_facts?.rejection_reason ||
            (llm.category === 'land' ? 'Unsupported land category' : 'AI rejected as non-housing'),
          listing_facts_json: llm.canonical_facts ? JSON.stringify(llm.canonical_facts) : listing.listing_facts_json,
        });
      }
      return;
    }
    const canonicalFacts = llm.canonical_facts;
    const reviewStatus: 'approved' | 'pending' = llm.is_real_estate === true &&
      (!canonicalFacts || (canonicalFacts.price !== null && canonicalFacts.currency !== null)) ? 'approved' : 'pending';
    const reviewReason = reviewStatus === 'pending'
      ? (canonicalFacts && (canonicalFacts.price === null || canonicalFacts.price !== null && canonicalFacts.currency === null)
        ? 'Monthly rent or currency unknown'
        : llm.admission_reason || 'LLM admission decision missing or uncertain')
      : undefined;
    if (isExcessiveKhmer(llm.description_en)) {
      console.log(`  ⏩ [Skipped - Low Translation Quality] "${(listing.title ?? '').slice(0, 40)}"`);
      if (options.inclusive) {
        inclusiveResults.set(originalIndex, {
          ...listing, is_real_estate: null, review_status: 'pending',
          review_reason: 'Low English translation quality; AI admission unverified',
          listing_facts_json: llm.canonical_facts ? JSON.stringify(llm.canonical_facts) : listing.listing_facts_json,
        });
      }
      return;
    }

    const propertyType = llm.property_type ?? listing.property_type;
    // property_type is a more reliable signal than the LLM's own loose `category`
    // field or the Khmer24 browse-category the listing happened to be scraped
    // from (e.g. Khmer24's "Room for Rent" page routinely includes full
    // self-contained studios/condos/apartments). Derive category from it first.
    const category = (categoryFromPropertyType(propertyType)
      ?? (llm.category ? llm.category : listing.category)) as PropertyCategory | undefined;

    const location = listing.location || llm.location || undefined;

    // Khmer24's own province filter (the page we scraped this listing from) is
    // NOT always accurate — ads get cross-posted or mis-tagged on Khmer24's side,
    // so a "Siem Reap" browse page can still surface a Phnom Penh property. The
    // structured district/sangkat we extracted (JSON-LD street address, or the
    // AI's `location`) is the ground truth. Cross-check it against the canonical
    // location table and correct the city when it confidently resolves to the
    // OTHER city.
    let city = listing.city;
    if (location) {
      const canonical = findCanonicalLocation(location);
      if (canonical && canonical.city !== city) {
        console.log(
          `  🌍 [City Fix] "${(listing.title ?? '').slice(0, 40)}" location "${location}" resolves to ${canonical.city}, not scraped ${city}. Correcting.`,
        );
        city = canonical.city;
      }
    }

    const result: RawListing = {
      ...listing,
      title: llm.title_en?.trim() || listing.title,
      description: llm.description_en?.trim() || fallbackDescription(listing, {
        propertyType, category,
        bedrooms: canonicalFacts ? canonicalFacts.bedrooms : llm.bedrooms ?? listing.bedrooms,
        bathrooms: canonicalFacts ? canonicalFacts.bathrooms : llm.bathrooms ?? listing.bathrooms,
      }),
      // Explicit rent in post text wins over conflicting platform metadata.
      // Retain structured platform price only when the canonical text has none.
      price: canonicalFacts ? canonicalFacts.price != null && canonicalFacts.currency ? canonicalFacts.price : undefined
        : listing.price ?? llm.price ?? undefined,
      currency: canonicalFacts ? canonicalFacts.currency ?? undefined : listing.currency,
      // (llm.category === 'land' already handled above.)
      category,
      city,
      bedrooms: canonicalFacts ? canonicalFacts.bedrooms ?? undefined : llm.bedrooms ?? listing.bedrooms,
      bathrooms: canonicalFacts ? canonicalFacts.bathrooms ?? undefined : llm.bathrooms ?? listing.bathrooms,
      deposit: canonicalFacts ? canonicalFacts.deposit_amount ?? undefined : llm.deposit ?? listing.deposit,
      min_lease: canonicalFacts ? canonicalFacts.min_lease_months ?? undefined : llm.min_lease ?? listing.min_lease,
      has_pool: canonicalFacts ? canonicalFacts.has_pool : llm.has_pool ?? listing.has_pool,
      location,
      // Source map links are extracted from the matching Khmer24 post or an
      // explicit property-labelled link in the original text. AI landmarks
      // must not turn into a false "exact property" map pin.
      maps_url: listing.maps_url || undefined,
      property_type: propertyType,
      electricity: canonicalFacts ? llm.electricity ?? undefined : llm.electricity ?? listing.electricity,
      water: canonicalFacts ? llm.water ?? undefined : llm.water ?? listing.water,
      cleaning: canonicalFacts ? llm.cleaning ?? undefined : llm.cleaning ?? listing.cleaning,
      restrictions: canonicalFacts ? llm.restrictions : (llm.restrictions && llm.restrictions.length > 0) ? llm.restrictions : listing.restrictions,
      pet_friendly: canonicalFacts ? llm.pet_friendly : llm.pet_friendly ?? listing.pet_friendly,
      marketing_landmarks: (llm.marketing_landmarks && llm.marketing_landmarks.length > 0) ? llm.marketing_landmarks : listing.marketing_landmarks,
      amenities: (llm.discovered_amenities && llm.discovered_amenities.length > 0) ? llm.discovered_amenities : listing.amenities,
      review_status: reviewStatus,
      review_reason: reviewReason,
      is_real_estate: llm.is_real_estate,
      deposit_months: canonicalFacts ? canonicalFacts.deposit_months ?? undefined : listing.deposit_months,
      listing_facts_json: llm.canonical_facts ? JSON.stringify(llm.canonical_facts) : listing.listing_facts_json,
    };
    enriched.push(result);
    if (options.inclusive) inclusiveResults.set(originalIndex, result);
  });

  console.log(`  ✅ AI enrichment complete: ${enriched.length}/${listings.length} listings kept (rewritten to English).`);
  return options.inclusive
    ? listings.map((listing, index) => inclusiveResults.get(index) ?? {
      ...listing, description: fallbackDescription(listing),
      is_real_estate: null, review_status: 'pending', review_reason: 'LLM extraction unavailable',
    })
    : enriched;
}

// ─── Backward-compatible stubs (used in tests) ───────────────────────────────

/** @deprecated Superseded by the Playwright scraper. Kept for test imports. */
export function parseKhmer24DetailHtml(
  _html: string,
  detailUrl: string,
  category: PropertyCategory,
  city: 'siem_reap' | 'phnom_penh' = 'siem_reap',
): RawListing | null {
  return {
    title: '', description: '', price: undefined, currency: 'USD',
    type: 'rent', category, location: 'Siem Reap', city,
    photos: [], url: detailUrl, source_url: detailUrl,
  };
}

/** Converts thumbnail CDN URL to full-resolution. Retained for test compatibility. */
export function toHighResImageUrl(url: string): string {
  if (!url) return '';
  return url.replace(/\/thumbs\//i, '/uploads/').replace(/\/s\//i, '/l/').replace(/\/m\//i, '/l/');
}

// ─── Freshness Sweep ──────────────────────────────────────────────────────────
// Re-checks stored Khmer24 ads and deactivates ones whose source page is gone.

export function classifyKhmer24PageLiveness(html: string): 'alive' | 'dead' | 'unknown' {
  return classifyKhmer24DetailLiveness(html);
}

export interface FreshnessSweepOptions {
  dryRun?: boolean;
  limit?: number;
  dbPath?: string;
}

export async function runKhmer24FreshnessSweep(
  containerInstance?: AppContainer,
  options: FreshnessSweepOptions = {},
): Promise<{ checked: number; alive: number; dead: number; unknown: number; errors: number }> {
  const container = containerInstance ?? createContainer(options.dbPath ? { dbPath: options.dbPath } : undefined);
  runMigrations(container.db);

  const all = container.propertiesRepo.getActivePropertiesByUrlPattern('%khmer24.com%');
  const targets = options.limit ? all.slice(0, options.limit) : all;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`🧹 Khmer24 Freshness Sweep — ${targets.length} active ads to re-check${options.dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════');

  let alive = 0;
  let dead = 0;
  let unknown = 0;
  let errors = 0;
  const browserHolder: { camoufox: CamoufoxBrowser | null } = { camoufox: null };

  const getBrowser = async (): Promise<Browser> => {
    if (!browserHolder.camoufox) {
      browserHolder.camoufox = await launchCamoufox({ headless: true, devicePath: K24_DEVICE_PATH });
    }
    return browserHolder.camoufox.browser;
  };

  try {
    for (const prop of targets) {
      const url = prop.original_url;
      let verdict: 'alive' | 'dead' | 'unknown' = 'unknown';
      try {
        const browser = await getBrowser();
        const contextOptions: { storageState?: string } = {};
        if (fs.existsSync(K24_SESSION_PATH)) contextOptions.storageState = K24_SESSION_PATH;
        const ctx = await browser.newContext(contextOptions);
        try {
          const page = await ctx.newPage();
          await setupRelaxedTrafficGuard(page);
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          if (!response || (response.status() >= 400 && response.status() !== 404 && response.status() !== 410)) {
            throw new Error(`Khmer24 freshness HTTP ${response?.status() ?? 'no response'}`);
          }
          await checkCloudflareBlock(page, url);
          verdict = classifyKhmer24DetailLiveness(await page.content(), /-adid-(\d+)/i.exec(url)?.[1]);
        } finally {
          await ctx.close().catch(() => {});
        }
      } catch (err) {
        errors++;
        console.warn(`  ⚠️ #${prop.id} check failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      if (verdict === 'dead') {
        dead++;
        console.log(`  🪦 #${prop.id} "${prop.title.slice(0, 45)}" — source ad gone`);
        if (!options.dryRun) {
          container.propertiesRepo.deactivateProperty(prop.id);
        }
      } else if (verdict === 'alive') {
        alive++;
      } else {
        unknown++;
        console.log(`  ❓ #${prop.id} "${prop.title.slice(0, 45)}" — inconclusive page, kept active`);
      }
    }
  } finally {
    if (browserHolder.camoufox) await browserHolder.camoufox.close().catch(() => {});
  }

  console.log('\n📊 Freshness summary:');
  console.log(`   Checked  : ${targets.length}`);
  console.log(`   ✅ Alive   : ${alive}`);
  console.log(`   🪦 Dead    : ${dead}${options.dryRun ? ' (dry run — nothing deactivated)' : ' → deactivated'}`);
  console.log(`   ❓ Unknown : ${unknown}`);
  console.log(`   ⚠️ Errors  : ${errors}`);

  return { checked: targets.length, alive, dead, unknown, errors };
}

// ─── Main Ingestion Runner ────────────────────────────────────────────────────

export interface RunKhmer24Options {
  limitListings?: number;
  noEnrich?: boolean;
  targetIndex?: number;
  dumpRaw?: string;
  dbPath?: string;
  shadowOnly?: boolean;
}

export async function runKhmer24Scraper(
  containerInstance?: AppContainer,
  options: RunKhmer24Options = {},
): Promise<{
  totalScraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
}> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🤖 Khmer24 Scraper (Camoufox + Nuxt SSR + AI-First) — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');

  const container = containerInstance ?? createContainer(options.dbPath ? { dbPath: options.dbPath } : undefined);
  runMigrations(container.db);
  // Canonical ingestion is the normal path. Keep --shadow as a CLI alias while
  // older job configurations migrate; neither mode can mutate legacy inventory.
  const legacySnapshot = snapshotLegacyProperties(container.db);
  installLegacyPropertiesWriteGuard(container.db);

  const targets = options.targetIndex !== undefined
    ? KHMER24_TARGETS.filter((_, i) => i === options.targetIndex)
    : KHMER24_TARGETS;

  if (targets.length === 0) {
    console.error(`💥 No Khmer24 target with index ${options.targetIndex}`);
    return { totalScraped: 0, inserted: 0, duplicates: 0, errors: 1 };
  }

  let totalScraped = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  const maxListings = options.limitListings ?? 10;

  try {
    for (const target of targets) {
      try {
        const rawListings = await scrapeTargetWithRecovery(target, maxListings);
        totalScraped += rawListings.length;

        if (options.dumpRaw) {
          fs.writeFileSync(options.dumpRaw, JSON.stringify(rawListings, null, 2), 'utf8');
          console.log(`  💾 Dumped ${rawListings.length} raw listings to ${options.dumpRaw}`);
          continue;
        }

        {
          const envelopes: LiveListingEnvelope[] = rawListings.map((listing) => ({
            listing, sourceName: 'Khmer24 Siem Reap', sourceId: 'siem-reap', sourceUrl: 'https://www.khmer24.com/en',
          }));
          const baseAdapter = new Khmer24LiveAdapter(async function* () { yield* envelopes; });
          const states = new Map<string, { contentChanged:boolean; classification:LiveListingEnvelope['classification'] }>();
          const contentChanged:LiveListingEnvelope[]=[];
          for(const envelope of envelopes){
            const normalized = baseAdapter.normalize(envelope);
            const sourceId = container.sourceIngestionRepo.findSourceId(container.sourceIngestionRepo.makeSourceKey(normalized.sourceIdentity));
            const existing=sourceId===undefined?undefined:container.sourceIngestionRepo.findSourceItemState(sourceId,normalized.externalId);
            const textChanged=!existing||existing.contentHash!==(normalized.contentHash??null)||existing.classification==='UNCLASSIFIED'||existing.classification===null;
            const classification=existing?.classification;
            const priorClass=['HOUSING_SUPPLY','HOUSING_DEMAND','HOUSING_ADJACENT','IRRELEVANT','UNCLASSIFIED'].includes(classification??'')
              ? classification as LiveListingEnvelope['classification'] : undefined;
            const url=envelope.listing.source_url??envelope.listing.url??'';
            states.set(url,{contentChanged:textChanged,classification:priorClass});
            if(textChanged)contentChanged.push(envelope);
          }
          const changedListings = options.noEnrich || !contentChanged.length
            ? contentChanged.map((envelope) => envelope.listing)
            : await enrichListingsWithLLM(contentChanged.map((envelope) => envelope.listing), { inclusive: true });
          const enrichedByUrl = new Map(changedListings.map((listing) => [listing.source_url ?? listing.url ?? '', listing]));
          const shadowEnvelopes = envelopes.map((envelope) => {
            const url=envelope.listing.source_url??envelope.listing.url??'';
            const state=states.get(url);
            const enriched=enrichedByUrl.get(url);
            const classification=state?.contentChanged
              ? classifyKhmer24Listing(options.noEnrich ? undefined : enriched)
              : state?.classification ?? 'UNCLASSIFIED';
            return {...envelope,classification,listing:enriched??envelope.listing};
          });
          const shadowAdapter = new Khmer24LiveAdapter(async function* () { yield* shadowEnvelopes; });
          const result = await container.ingestionService.ingestBatch(shadowAdapter, {
            runType: 'DISCOVERY', ingestionMethod: 'KHMER24_SCRAPER', parserVersion: 'khmer24-canonical-v1',
          });
          totalInserted += result.newSourceItems;
          totalDuplicates += result.unchangedSourceItems;
          totalErrors += result.errors.length;
          console.log(`  📥 Canonical ingestion [${target.name}]: received=${result.inputItems}, new=${result.newSourceItems}, changed=${result.updatedSourceItems}, unchanged=${result.unchangedSourceItems}, errors=${result.errors.length}`);
          continue;
        }
      } catch (err: unknown) {
        if (err instanceof Khmer24SessionExpiredError) {
          console.error(`💥 Khmer24 session expired or Cloudflare 403 blocked: ${err.message}`);
          await container.notifierService.notifyAdmins(
            '⚠️ Khmer24 session expired or Cloudflare 403 blocked. Check access or run `npm run k24:login`',
          ).catch(() => {});
          totalErrors++;
          break; // Halt Khmer24 loop on CF block
        } else {
          totalErrors++;
          console.error(`💥 Error processing Khmer24 target [${target.name}]:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
  } catch (err: unknown) {
    console.error('💥 Fatal scraper error:', err instanceof Error ? err.message : String(err));
  } finally {
    await container.notifierService.flushNotificationQueue().catch((err) => console.error('[Notifier] Flush error:', err));
    assertLegacyPropertiesUnchanged(container.db, legacySnapshot);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 Summary:');
  console.log(`   Total Scraped : ${totalScraped}`);
  console.log(`   ✅ Inserted   : ${totalInserted}`);
  console.log(`   🔁 Duplicates : ${totalDuplicates}`);
  console.log(`   ❌ Errors     : ${totalErrors}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  return { totalScraped, inserted: totalInserted, duplicates: totalDuplicates, errors: totalErrors };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const options: RunKhmer24Options = {};
  let freshness = false;
  const freshnessOptions: FreshnessSweepOptions = {};

  for (const arg of args) {
    if (arg.startsWith('--limit-listings=')) {
      const n = parseInt(arg.replace('--limit-listings=', ''), 10);
      if (!isNaN(n) && n > 0) options.limitListings = n;
    } else if (arg.startsWith('--target=')) {
      const n = parseInt(arg.replace('--target=', ''), 10);
      if (!isNaN(n)) options.targetIndex = n;
    } else if (arg === '--no-enrich') {
      options.noEnrich = true;
    } else if (arg === '--shadow') {
      // Backward-compatible no-op: Khmer24 always writes through canonical ingestion.
    } else if (arg === '--freshness') {
      freshness = true;
    } else if (arg === '--dry-run') {
      freshnessOptions.dryRun = true;
    } else if (arg.startsWith('--freshness-limit=')) {
      const n = parseInt(arg.replace('--freshness-limit=', ''), 10);
      if (!isNaN(n) && n > 0) freshnessOptions.limit = n;
    } else if (arg.startsWith('--dump-raw=')) {
      options.dumpRaw = arg.replace('--dump-raw=', '');
    } else if (arg.startsWith('--db-path=')) {
      options.dbPath = arg.replace('--db-path=', '');
      freshnessOptions.dbPath = options.dbPath;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: ts-node src/modules/parser/khmer24.scraper.ts [--target=N] [--limit-listings=N] [--no-enrich] [--shadow (legacy no-op)] [--dump-raw=path.json] [--db-path=path.db] [--freshness] [--dry-run] [--freshness-limit=N]');
      process.exit(0);
    }
  }

  const runner = freshness
    ? runKhmer24FreshnessSweep(undefined, freshnessOptions)
    : runKhmer24Scraper(undefined, options);

  runner.then(() => process.exit(0)).catch((err) => {
    console.error('💥 Fatal:', err);
    process.exit(1);
  });
}
