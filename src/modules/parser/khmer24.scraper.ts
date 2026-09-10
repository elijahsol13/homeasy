/**
 * Khmer24 Scraper — Classic DOM Parsing Architecture
 *
 * Strategy:
 *  - Use Playwright (Stealth) to load HTML pages directly.
 *  - Use a "relaxed" traffic guard: block images, media, fonts, and CSS to save proxy bandwidth,
 *    BUT allow scripts and fetch/XHR requests so Nuxt 3 (Vue) can hydrate and render the DOM.
 *  - Extract listing URLs from the category feed.
 *  - Visit each listing page, bypass Cloudflare naturally.
 *  - Extract raw text, price, and apply the "-b.jpg" trick for high-res photos.
 *  - Yield the raw data to the AI-First Ingestor pipeline for semantic extraction.
 */

import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { RawListing } from './schemas';
import { runMigrations } from '../../database/migrate';
import type { AppContainer } from '../../container';
import { createContainer } from '../../container';
import type { PropertyCategory } from '../../config/settings';
import { extractListingsBatchWithLLM, isExcessiveKhmer, type LLMExtractedListing } from './extractor';
import { isNonRealEstateSpam } from './spam-detector';

export const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');

// Apply stealth plugin once at module load
chromium.use(stealthPlugin());

export class Khmer24SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Khmer24SessionExpiredError';
  }
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
  // ─── Siem Reap Rentals ───────────────────────────────────────────────────────
  { name: 'Siem Reap — Houses for Rent', category: 'house', city: 'siem_reap', type: 'rent', categorySlug: 'house-for-rent', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Apartments & Condos for Rent', category: 'apartment', city: 'siem_reap', type: 'rent', categorySlug: 'apartment-for-rent', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Rooms for Rent', category: 'room', city: 'siem_reap', type: 'rent', categorySlug: 'room-for-rent', locationSlug: 'siem-reap' },

  // ─── Siem Reap Sales ────────────────────────────────────────────────────────
  { name: 'Siem Reap — Houses for Sale', category: 'house', city: 'siem_reap', type: 'sale', categorySlug: 'house-for-sale', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Condos for Sale', category: 'apartment', city: 'siem_reap', type: 'sale', categorySlug: 'condo-for-sale', locationSlug: 'siem-reap' },

  // ─── Phnom Penh Rentals ─────────────────────────────────────────────────────
  { name: 'Phnom Penh — Houses for Rent', category: 'house', city: 'phnom_penh', type: 'rent', categorySlug: 'house-for-rent', locationSlug: 'phnom-penh' },
  { name: 'Phnom Penh — Apartments for Rent', category: 'apartment', city: 'phnom_penh', type: 'rent', categorySlug: 'apartment-for-rent', locationSlug: 'phnom-penh' },
  { name: 'Phnom Penh — Rooms for Rent', category: 'room', city: 'phnom_penh', type: 'rent', categorySlug: 'room-for-rent', locationSlug: 'phnom-penh' },

  // ─── Phnom Penh Sales ───────────────────────────────────────────────────────
  { name: 'Phnom Penh — Houses for Sale', category: 'house', city: 'phnom_penh', type: 'sale', categorySlug: 'house-for-sale', locationSlug: 'phnom-penh' },
  { name: 'Phnom Penh — Condos for Sale', category: 'apartment', city: 'phnom_penh', type: 'sale', categorySlug: 'condo-for-sale', locationSlug: 'phnom-penh' },
];

function buildFeedPageUrl(target: ScrapeTarget): string {
  // CORRECTED: using province= instead of location=
  return `https://www.khmer24.com/en/c-${target.categorySlug}?province=${target.locationSlug}&sortby=newads&date=last-7-days`;
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
 * Custom Traffic Guard: Blocks heavy visual assets to save proxy traffic,
 * but ALLOWS scripts and XHR so Nuxt/Vue can hydrate the page.
 */
async function setupRelaxedTrafficGuard(page: Page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url().toLowerCase();

    // Блокируем ТОЛЬКО тяжелый медиа-контент и шрифты (экономит 95% трафика)
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    // Блокируем только очевидную стороннюю аналитику
    if (
      url.includes('google-analytics') || 
      url.includes('googletagmanager') ||
      url.includes('doubleclick') || 
      url.includes('onesignal')
    ) {
      return route.abort();
    }
    
    // Пропускаем всё остальное (scripts, fetch, xhr, document, stylesheet)
    return route.continue();
  });
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
  const links: string[] = [];

  try {
    await setupRelaxedTrafficGuard(page);
    await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await checkCloudflareBlock(page, feedUrl);

    // Parse Nuxt 3 dehydrated SSR payload — all post data is already in the HTML
    const extractedLinks = await page.evaluate((max: number) => {
      const el = document.getElementById('__NUXT_DATA__');
      if (!el) return [];
      try {
        const raw: unknown[] = JSON.parse(el.textContent || '[]');
        function r(v: unknown): unknown { return typeof v === 'number' ? raw[v as number] : v; }

        // Find feed object: has {total, limit, data} keys
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i];
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const obj = item as Record<string, unknown>;
          if (!('total' in obj) || !('data' in obj) || !('limit' in obj)) continue;

          const dataRef = r(obj.data);
          if (!dataRef || typeof dataRef !== 'object') continue;

          // dataRef is either an Array or numeric-keyed object of post wrapper refs
          const postIndices: unknown[] = Array.isArray(dataRef)
            ? (dataRef as unknown[])
            : Object.values(dataRef as Record<string, unknown>);

          const urls: string[] = [];
          for (const idx of postIndices) {
            if (urls.length >= max) break;
            const wrapper = r(idx);
            if (!wrapper || typeof wrapper !== 'object') continue;
            const w = wrapper as Record<string, unknown>;
            const postData = r(w.data);
            if (!postData || typeof postData !== 'object') continue;
            const p = postData as Record<string, unknown>;
            // `link` may be relative ("/en/house-adid-123") or absolute URL
            const link = r(p.link);
            if (typeof link === 'string' && link.includes('-adid-')) {
              const absUrl = link.startsWith('http') ? link : 'https://www.khmer24.com' + link;
              urls.push(absUrl);
            }
          }

          if (urls.length > 0) return urls;
        }
        return [];
      } catch {
        return [];
      }
    }, maxLinks);

    links.push(...extractedLinks);

    // Fallback: if SSR parsing didn't work, wait briefly for Vue and scrape DOM
    if (links.length === 0) {
      await page.waitForSelector('a[href*="-adid-"]', { timeout: 8000 }).catch(() => {});
      const domLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="-adid-"]'))
          .map(a => (a as HTMLAnchorElement).href)
          .filter(h => !h.includes('/user/'))
          .map(h => h.split('?')[0]),
      );
      const seen = new Set<string>();
      for (const l of domLinks) {
        if (seen.has(l) || seen.size >= maxLinks) break;
        seen.add(l);
        links.push(l);
      }
    }
  } catch (err: unknown) {
    console.warn(`⚠️  [Feed Scraper] Error on ${feedUrl}:`, err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => {});
  }

  return links;
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
async function scrapeListingDetail(ctx: BrowserContext, target: ScrapeTarget, url: string): Promise<RawListing | null> {
  const page = await ctx.newPage();
  let listing: RawListing | null = null;

  try {
    await setupRelaxedTrafficGuard(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await checkCloudflareBlock(page, url);

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

            // Price: offer.price is already a clean number string e.g. "1300.00"
            const priceStr: string = String(offer.price || '');
            const price = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || undefined;
            const currency: string = offer.priceCurrency || 'USD';

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
              phone: phones[0] || '',
              allPhones: phones,
              photos,
              location,
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
        price: extracted.price,
        currency: extracted.currency as 'USD' | 'KHR',
        type: target.type ?? 'rent',
        category: target.category,
        location: extracted.location || undefined,
        city: target.city,
        photos: extracted.photos,
        phone: phone || undefined,
        url,
        source_url: url,
      };
    } else {
      // ── Fallback: DOM extraction (CSS selectors + visible text) ────────────
      // Wait for h1 to confirm page rendered
      await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});

      const domData = await page.evaluate(() => {
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';

        // Price: Khmer24 uses text-error-500 for the price text
        const priceEl =
          document.querySelector('[class*="text-error-500"]') ||
          document.querySelector('[class*="price"]');
        const priceText = priceEl?.textContent?.trim() || '';

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

        return { h1, priceText, description, photos: imgs, phones };
      });

      if (!domData.h1) return null;

      listing = {
        title: domData.h1,
        description: domData.description,
        price: parseRawPrice(domData.priceText),
        currency: 'USD',
        type: target.type ?? 'rent',
        category: target.category,
        location: undefined,
        city: target.city,
        photos: domData.photos,
        phone: domData.phones[0] || undefined,
        url,
        source_url: url,
      };
    }
  } catch (err: unknown) {
    if (err instanceof Khmer24SessionExpiredError) throw err;
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

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };

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
        if (listing.phone) console.log(`  📞 Phone extracted: ${listing.phone}`);
        listings.push(listing);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log(`  ✅ Successfully extracted ${listings.length} listings from [${target.name}]`);
  return listings;
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
export async function enrichListingsWithLLM(listings: RawListing[]): Promise<RawListing[]> {
  if (listings.length === 0) return listings;

  // Pre-filter obvious spam before spending any Gemini quota on it.
  const candidates = listings.filter((listing) => {
    const spamCheck = isNonRealEstateSpam(listing.title ?? '', listing.description ?? '');
    if (spamCheck.isSpam) {
      console.log(`  ⏩ [Skipped - Spam] "${(listing.title ?? '').slice(0, 40)}": ${spamCheck.reason}`);
      return false;
    }
    return true;
  });

  const llmResults = new Map<number, LLMExtractedListing>();
  for (let i = 0; i < candidates.length; i += LLM_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + LLM_BATCH_SIZE);
    const batchInput = chunk.map((listing, idx) => ({
      id: i + idx,
      text: `${listing.title ?? ''}\n\n${listing.description ?? ''}`.trim(),
    }));

    console.log(
      `  🚀 [AI Batch ${Math.floor(i / LLM_BATCH_SIZE) + 1}/${Math.ceil(candidates.length / LLM_BATCH_SIZE)}] Rewriting ${chunk.length} listings with Gemini...`,
    );
    try {
      const batchResult = await extractListingsBatchWithLLM(batchInput);
      for (const [id, llm] of batchResult) {
        llmResults.set(Number(id), llm);
      }
    } catch (err: unknown) {
      console.warn(`  ⚠️ [AI Batch] Failed, falling back to original text for this chunk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const enriched: RawListing[] = [];
  candidates.forEach((listing, idx) => {
    const llm = llmResults.get(idx);
    if (!llm) {
      // Batch call failed or omitted this item — ingest with original scraped text
      // rather than dropping it.
      enriched.push(listing);
      return;
    }

    if (llm.is_real_estate === false || llm.category === 'land') {
      console.log(`  ⏩ [Skipped - Not Residential Real Estate] "${(listing.title ?? '').slice(0, 40)}"`);
      return;
    }
    if (isExcessiveKhmer(llm.description_en)) {
      console.log(`  ⏩ [Skipped - Low Translation Quality] "${(listing.title ?? '').slice(0, 40)}"`);
      return;
    }

    enriched.push({
      ...listing,
      title: llm.title_en?.trim() || listing.title,
      description: llm.description_en || listing.description,
      // Khmer24's own JSON-LD price/photos/phone are already reliable — never override those.
      // (llm.category === 'land' already handled above.)
      category: (llm.category ? llm.category : listing.category) as PropertyCategory | undefined,
      bedrooms: llm.bedrooms ?? listing.bedrooms,
      bathrooms: llm.bathrooms ?? listing.bathrooms,
      deposit: llm.deposit ?? listing.deposit,
      min_lease: llm.min_lease ?? listing.min_lease,
      has_pool: llm.has_pool ?? listing.has_pool,
      location: listing.location || llm.location || undefined,
      maps_url: listing.maps_url || llm.maps_url || undefined,
      property_type: llm.property_type ?? listing.property_type,
      electricity: llm.electricity ?? listing.electricity,
      water: llm.water ?? listing.water,
      cleaning: llm.cleaning ?? listing.cleaning,
      restrictions: (llm.restrictions && llm.restrictions.length > 0) ? llm.restrictions : listing.restrictions,
      pet_friendly: llm.pet_friendly ?? listing.pet_friendly,
      marketing_landmarks: (llm.marketing_landmarks && llm.marketing_landmarks.length > 0) ? llm.marketing_landmarks : listing.marketing_landmarks,
      amenities: (llm.discovered_amenities && llm.discovered_amenities.length > 0) ? llm.discovered_amenities : listing.amenities,
    });
  });

  console.log(`  ✅ AI enrichment complete: ${enriched.length}/${listings.length} listings kept (rewritten to English).`);
  return enriched;
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

// ─── Main Ingestion Runner ────────────────────────────────────────────────────

export async function runKhmer24Scraper(containerInstance?: AppContainer): Promise<{
  totalScraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
}> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🤖 Khmer24 Scraper (Classic DOM + AI-First) — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');

  const container = containerInstance ?? createContainer();
  runMigrations(container.db);

  let totalScraped = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let browser: Browser | null = null;

  try {
    const isLocal = process.argv.includes('--local');
    const proxyConfig = (!isLocal && process.env.PROXY_URL) ? { server: process.env.PROXY_URL } : undefined;
    
    browser = await chromium.launch({
      headless: true, // You can switch this to false for debugging
      proxy: proxyConfig,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-zygote', '--disable-extensions',
        '--disable-default-apps', '--mute-audio', '--disable-background-networking',
        '--disable-blink-features=AutomationControlled', '--disable-infobars',
        '--js-flags=--max-old-space-size=128',
      ],
    });

    for (const target of KHMER24_TARGETS) {
      try {
        const rawListings = await scrapeTargetWithBrowser(browser, target, 10);
        totalScraped += rawListings.length;
        const listings = await enrichListingsWithLLM(rawListings);

        for (const listing of listings) {
          try {
            // Send straight to AI-First pipeline
            const result = await container.ingestionService.ingestRawListing(listing);
            if (result.status === 'inserted') {
              totalInserted++;
              console.log(`  ✅ Inserted: "${listing.title?.slice(0, 40)}" (ID #${result.propertyId})`);
            } else if (result.status === 'duplicate') {
              totalDuplicates++;
              console.log(`  🔁 Duplicate: "${listing.title?.slice(0, 40)}"`);
            } else {
              totalErrors++;
              console.log(`  ❌ Error: ${result.error}`);
            }
          } catch (err: unknown) {
            totalErrors++;
            console.error(`  ❌ Ingest error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Khmer24SessionExpiredError) {
          console.error(`💥 Khmer24 session expired or Cloudflare 403 blocked: ${err.message}`);
          await container.notifierService.notifyAdmins(
            '⚠️ Khmer24 session expired or Cloudflare 403 blocked. Check proxy or run `npm run k24:login`',
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
    if (browser) await browser.close().catch(() => {});
    await container.notifierService.flushNotificationQueue().catch((err) => console.error('[Notifier] Flush error:', err));
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
  runKhmer24Scraper().then(() => process.exit(0)).catch((err) => {
    console.error('💥 Fatal:', err);
    process.exit(1);
  });
}