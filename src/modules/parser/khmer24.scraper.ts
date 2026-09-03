/**
 * Khmer24 Scraper — API-First Architecture
 *
 * Strategy:
 *  - Use Playwright (Stealth) to load khmer24.com pages and acquire valid Cloudflare cookies.
 *  - Intercept the JSON responses from api-posts.khmer24.com directly inside the browser context.
 *  - Parse the clean JSON API responses (no HTML/Cheerio required).
 *
 * API Endpoints discovered via live network interception:
 *   Feed:   https://api-posts.khmer24.com/feed?category=house-for-rent&location=siem-reap&sortby=newads&...
 *
 * Sorting:
 *   sortby=newads     → genuinely newest listings (ignores VIP/bumped)
 *   sortby=latestads  → most recently renewed (bumped VIP listings dominate)
 *
 * Post type field (on the post object, not the feed item):
 *   "normal"   → organic new listing ✅
 *   "top"      → paid top placement ❌  (skipped)
 *   "featured" → paid featured banner ❌  (skipped)
 */

import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext } from 'playwright';
import type { RawListing } from './schemas';
import { runMigrations } from '../../database/migrate';
import type { AppContainer } from '../../container';
import { createContainer } from '../../container';
import type { PropertyCategory } from '../../config/settings';

export const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');

// Apply stealth plugin once at module load
chromium.use(stealthPlugin());

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
  {
    name: 'Siem Reap — Houses for Rent',
    category: 'house',
    city: 'siem_reap',
    type: 'rent',
    categorySlug: 'house-for-rent',
    locationSlug: 'siem-reap',
  },
  {
    name: 'Siem Reap — Apartments & Condos for Rent',
    category: 'apartment',
    city: 'siem_reap',
    type: 'rent',
    categorySlug: 'apartment-for-rent',
    locationSlug: 'siem-reap',
  },
  {
    name: 'Siem Reap — Rooms for Rent',
    category: 'room',
    city: 'siem_reap',
    type: 'rent',
    categorySlug: 'room-for-rent',
    locationSlug: 'siem-reap',
  },

  // ─── Siem Reap Sales ────────────────────────────────────────────────────────
  {
    name: 'Siem Reap — Houses for Sale',
    category: 'house',
    city: 'siem_reap',
    type: 'sale',
    categorySlug: 'house-for-sale',
    locationSlug: 'siem-reap',
  },
  {
    name: 'Siem Reap — Condos for Sale',
    category: 'apartment',
    city: 'siem_reap',
    type: 'sale',
    categorySlug: 'condo-for-sale',
    locationSlug: 'siem-reap',
  },

  // ─── Phnom Penh Rentals ─────────────────────────────────────────────────────
  {
    name: 'Phnom Penh — Houses for Rent',
    category: 'house',
    city: 'phnom_penh',
    type: 'rent',
    categorySlug: 'house-for-rent',
    locationSlug: 'phnom-penh',
  },
  {
    name: 'Phnom Penh — Apartments for Rent',
    category: 'apartment',
    city: 'phnom_penh',
    type: 'rent',
    categorySlug: 'apartment-for-rent',
    locationSlug: 'phnom-penh',
  },
  {
    name: 'Phnom Penh — Rooms for Rent',
    category: 'room',
    city: 'phnom_penh',
    type: 'rent',
    categorySlug: 'room-for-rent',
    locationSlug: 'phnom-penh',
  },

  // ─── Phnom Penh Sales ───────────────────────────────────────────────────────
  {
    name: 'Phnom Penh — Houses for Sale',
    category: 'house',
    city: 'phnom_penh',
    type: 'sale',
    categorySlug: 'house-for-sale',
    locationSlug: 'phnom-penh',
  },
  {
    name: 'Phnom Penh — Condos for Sale',
    category: 'apartment',
    city: 'phnom_penh',
    type: 'sale',
    categorySlug: 'condo-for-sale',
    locationSlug: 'phnom-penh',
  },
];

// ─── Khmer24 API Types ────────────────────────────────────────────────────────

interface K24Location {
  id?: string;
  en_name: string;
  en_name2?: string;
  en_name3?: string;
  slug: string;
  map?: { x?: string | number; y?: string | number; z?: number };
  [key: string]: unknown;
}

interface K24HighlightSpec {
  title: string;
  field: string;
  value: string;
  display_value?: string;
  value_slug?: string | number;
  [key: string]: unknown;
}

interface K24Post {
  id: string;
  title: string;
  price: string;
  /** Promotion tier: "normal" | "top" | "featured" */
  type?: string;
  photos: string[];
  link?: string;
  short_link?: string;
  description?: string;
  location?: K24Location;
  category?: { id?: string; en_name: string; slug: string; [key: string]: unknown };
  condition?: { value: string; title?: string; field?: string; [key: string]: unknown };
  object_highlight_specs?: {
    bedroom?: K24HighlightSpec;
    bathroom?: K24HighlightSpec;
    size?: K24HighlightSpec;
    [key: string]: K24HighlightSpec | undefined;
  };
  user?: { id: string; name: string; username: string; [key: string]: unknown };
  renew_date?: string;
  [key: string]: unknown;
}

interface K24FeedItem {
  type: 'post' | 'banner';
  data?: K24Post;
}

interface K24FeedResponse {
  total: number;
  limit: number;
  offset: number;
  data: K24FeedItem[];
}

// ─── API Constants ────────────────────────────────────────────────────────────

const API_BASE = 'https://api-posts.khmer24.com/feed';

const API_FIELDS =
  'thumbnails,thumbnail,location,photos,user,store,renew_date,is_like,is_saved,category,link,object_highlight_specs,condition,video,description';

const API_FUNCTIONS =
  'save,chat,like,apply_job,shipping,banner,highlight_ads[object_highlight_specs]';

/** Build the API URL for a feed page */
function buildFeedUrl(target: ScrapeTarget, offset: number): string {
  const params = new URLSearchParams({
    meta: 'true',
    fields: API_FIELDS,
    functions: API_FUNCTIONS,
    offset: String(offset),
    filter_version: '4',
    lang: 'en',
    category: target.categorySlug,
    location: target.locationSlug,
    // Sort by genuine creation date — ignores VIP/bumped promotions
    sortby: 'newads',
    // Only listings from the last 7 days — keeps 30-min cron efficient
    date: 'last-7-days',
  });
  return `${API_BASE}?${params.toString()}`;
}

/** Build the corresponding front-end page URL for CF cookie acquisition */
function buildFeedPageUrl(target: ScrapeTarget): string {
  return (
    `https://www.khmer24.com/en/c-${target.categorySlug}` +
    `?location=${target.locationSlug}&sortby=newads&date=last-7-days`
  );
}

// ─── Data Extraction Helpers ──────────────────────────────────────────────────

/** Extract the most specific Sangkat/district name from the location object */
function extractLocationText(loc?: K24Location): string | undefined {
  if (!loc) return undefined;
  // en_name3 is most specific: "Svay Dangkum, Siem Reap, Siem Reap"
  const full = loc.en_name3 ?? loc.en_name2 ?? loc.en_name ?? '';
  if (!full) return undefined;
  const parts = full.split(',').map((s) => s.trim());
  return parts[0] || undefined;
}

/** Build a verified Google Maps URL from embedded GPS or fallback to Sangkat search */
function extractMapsUrl(
  loc?: K24Location,
  city: 'siem_reap' | 'phnom_penh' = 'siem_reap',
  locationName?: string,
): string {
  const map = loc?.map;
  const cityName = city === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap';
  const fallbackQuery = locationName ? `${locationName}, ${cityName}, Cambodia` : `${cityName}, Cambodia`;
  const fallbackUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackQuery)}`;

  if (!map?.x || !map?.y) return fallbackUrl;

  const lat = typeof map.x === 'number' ? map.x : parseFloat(String(map.x));
  const lng = typeof map.y === 'number' ? map.y : parseFloat(String(map.y));

  if (isNaN(lat) || isNaN(lng)) return fallbackUrl;

  // Validate coordinates stay within the target city's actual bounds
  if (city === 'siem_reap') {
    const inSiemReap = lat >= 13.0 && lat <= 13.7 && lng >= 103.5 && lng <= 104.2;
    if (!inSiemReap) return fallbackUrl;
  } else if (city === 'phnom_penh') {
    const inPhnomPenh = lat >= 11.3 && lat <= 11.8 && lng >= 104.6 && lng <= 105.2;
    if (!inPhnomPenh) return fallbackUrl;
  }

  // Official universal Google Maps search URL that works accurately on iOS, Android, and Desktop
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function parseBedrooms(specs?: K24Post['object_highlight_specs']): number | undefined {
  const val = specs?.bedroom?.value;
  if (!val || val === 'more') return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function parseBathrooms(specs?: K24Post['object_highlight_specs']): number | undefined {
  const val = specs?.bathroom?.value;
  if (!val || val === 'more') return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function parseSize(specs?: K24Post['object_highlight_specs']): string | undefined {
  const raw = specs?.size?.display_value;
  return raw != null ? String(raw) : undefined;
}

function extractSpecsDetails(specs?: K24Post['object_highlight_specs']): string[] {
  if (!specs) return [];
  const parts: string[] = [];

  const size = specs.size?.display_value ?? specs.size?.value;
  if (size) parts.push(`Size: ${size}`);

  const floor = specs.floor?.display_value ?? specs.floor?.value;
  if (floor) parts.push(`Floor: ${floor}`);

  const furniture = specs.furniture?.display_value ?? specs.furniture?.value;
  if (furniture) parts.push(`Furniture: ${furniture}`);

  const facing = specs.facing?.display_value ?? specs.facing?.value;
  if (facing) parts.push(`Facing: ${facing}`);

  const parking = specs.parking?.display_value ?? specs.parking?.value;
  if (parking) parts.push(`Parking: ${parking}`);

  return parts;
}

function parsePrice(price: string): number | undefined {
  const cleaned = price.replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

/** Map a Khmer24 API post to our internal RawListing schema */
export function postToRawListing(post: K24Post, target: ScrapeTarget, phone?: string): RawListing {
  const location = extractLocationText(post.location);
  const priceRaw = parsePrice(post.price);
  const mapsUrl = extractMapsUrl(post.location, target.city, location);
  const listingUrl =
    post.link ?? post.short_link ?? `https://www.khmer24.com/post-adid-${post.id}`;

  let description = post.description ?? '';
  const specDetails = extractSpecsDetails(post.object_highlight_specs);
  if (specDetails.length > 0) {
    const specsStr = specDetails.join(' · ');
    if (!description.includes(specsStr)) {
      description = description ? `${description}\n\n${specsStr}` : specsStr;
    }
  }

  return {
    title: post.title,
    description,
    price: priceRaw,
    currency: 'USD',
    type: target.type ?? 'rent',
    category: target.category,
    location,
    city: target.city,
    photos: post.photos ?? [],
    bedrooms: parseBedrooms(post.object_highlight_specs),
    bathrooms: parseBathrooms(post.object_highlight_specs),
    maps_url: mapsUrl,
    phone,
    url: listingUrl,
    source_url: listingUrl,
  };
}

// ─── Browser Feed Fetching ────────────────────────────────────────────────────

async function fetchFeedPage(
  ctx: BrowserContext,
  target: ScrapeTarget,
  offset: number,
): Promise<K24FeedResponse | null> {
  const pageUrl = buildFeedPageUrl(target);
  const apiUrl = buildFeedUrl(target, offset);

  const page = await ctx.newPage();
  let feedData: K24FeedResponse | null = null;

  try {
    // Intercept the API response fired by the page's own JS
    page.on('response', async (resp) => {
      const u = resp.url();
      if (u.startsWith(API_BASE) && !u.includes('/relates')) {
        try {
          const json = (await resp.json()) as K24FeedResponse;
          if (json.data) feedData = json;
        } catch {
          // ignore JSON parse errors
        }
      }
    });

    if (offset === 0) {
      // Navigate to the front-end page — triggers CF cookie resolution + API call
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      // For subsequent pages use fetch() in the page context (reuses existing CF cookies)
      feedData = (await page.evaluate(async (url: string) => {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', Referer: 'https://www.khmer24.com/' },
        });
        return res.ok ? (res.json() as unknown) : null;
      }, apiUrl)) as K24FeedResponse | null;
    }

    // Poll up to 12s for the intercepted response
    const deadline = Date.now() + 12000;
    while (!feedData && Date.now() < deadline) {
      await page.waitForTimeout(300);
    }

    // Final fallback: in-browser fetch with full cookie context
    if (!feedData) {
      feedData = (await page.evaluate(async (url: string) => {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', Referer: 'https://www.khmer24.com/' },
        });
        return res.ok ? (res.json() as unknown) : null;
      }, apiUrl)) as K24FeedResponse | null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  [Scraper] fetchFeedPage error: ${msg}`);
  } finally {
    await page.close().catch(() => {});
  }

  return feedData;
}

async function fetchPostPhone(ctx: BrowserContext, adId: string): Promise<string | undefined> {
  const page = await ctx.newPage();
  let phone: string | undefined;

  try {
    // Block heavy media/fonts/images/css — we only need HTML text and API responses
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    // Listen for any API response that might contain the phone number
    page.on('response', async (resp) => {
      const u = resp.url();
      if (u.includes('khmer24') && (u.includes('contact') || u.includes('phone'))) {
        try {
          const json = (await resp.json()) as Record<string, unknown>;
          const txt = JSON.stringify(json);
          const m = /(?:phone|tel|mobile)["\s:]+["']?(\+?855[\d\s-]{6,12}|0\d{8,9})/.exec(txt);
          if (m?.[1]) phone = m[1].trim();
        } catch {
          // ignore
        }
      }
    });

    await page.goto(`https://www.khmer24.com/post-adid-${adId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.waitForTimeout(3000);

    // Click "Show Phone" button if present
    const phoneBtn = page
      .locator('[class*=phone] button, button[class*=phone], [class*=contact] button, [data-phone]')
      .first();
    if ((await phoneBtn.count()) > 0) {
      await phoneBtn.click();
      await page.waitForTimeout(2000);
    }

    // Extract from tel: links in DOM
    if (!phone) {
      const telLinks = await page.locator('a[href^="tel:"]').all();
      for (const link of telLinks) {
        const href = await link.getAttribute('href');
        if (href && !href.toUpperCase().includes('X')) {
          phone = href.replace(/^tel:/i, '').trim();
          break;
        }
      }
    }

    // Extract from phone/contact elements in DOM (unmasked when authenticated)
    if (!phone) {
      const phoneElements = page.locator(
        '[class*="contact"] a, [class*="phone"] a, .phone-number, [data-phone], [class*="contact-phone"]',
      );
      const count = await phoneElements.count();
      for (let i = 0; i < count; i++) {
        const text = (await phoneElements.nth(i).innerText()).trim();
        const m = /(\+855[\d\s-]{6,12}|0\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4})/.exec(text);
        if (m?.[1] && !m[1].toUpperCase().includes('X')) {
          phone = m[1].trim();
          break;
        }
      }
    }

    // Extract from visible page text as final fallback
    if (!phone) {
      const bodyText = (await page.evaluate(
        () => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText,
      )) as string;
      const m = /(\+855[\d\s-]{6,10}|0\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4})/.exec(bodyText);
      if (m?.[1] && !m[1].toUpperCase().includes('X')) phone = m[1].trim();
    }

    // Never return masked phone numbers ending in XXX
    if (phone && phone.toUpperCase().includes('X')) {
      phone = undefined;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  [Scraper] fetchPostPhone(${adId}) error: ${msg}`);
  } finally {
    await page.close().catch(() => {});
  }

  return phone;
}

// ─── Target Scraper ───────────────────────────────────────────────────────────

export async function scrapeTargetWithBrowser(
  browser: Browser,
  target: ScrapeTarget,
  maxListings = 20,
): Promise<RawListing[]> {
  console.log(`\n🔎 Scraping [${target.name}]...`);
  const listings: RawListing[] = [];

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };

  if (fs.existsSync(K24_SESSION_PATH)) {
    contextOptions.storageState = K24_SESSION_PATH;
    console.log('🔑 [Khmer24] Using saved authenticated session from data/k24_session.json');
  } else {
    console.log('ℹ️  [Khmer24] Running unauthenticated. For 100% unmasked phone numbers, run: npm run k24:login');
  }

  const ctx = await browser.newContext(contextOptions);

  try {
    let offset = 0;
    let totalFetched = 0;

    while (totalFetched < maxListings) {
      const feedData = await fetchFeedPage(ctx, target, offset);

      if (!feedData || !feedData.data?.length) {
        console.log(`  No more results at offset ${offset}.`);
        break;
      }

      const allPosts = feedData.data
        .filter(
          (item): item is { type: 'post'; data: K24Post } =>
            item.type === 'post' && !!item.data,
        )
        .map((item) => item.data);

      // Filter out paid/bumped posts (type="top"|"featured") — only "normal"/"new" are fresh
      const posts = allPosts.filter((p) => {
        const t = String(p.type ?? 'normal').toLowerCase();
        return t === 'normal' || t === 'new';
      });
      const skippedVip = allPosts.length - posts.length;

      console.log(
        `  offset=${offset}: ${allPosts.length} posts ` +
          `(${skippedVip} VIP skipped, ${posts.length} organic) | ` +
          `total available: ${feedData.total}`,
      );

      const toProcess = posts.slice(0, maxListings - totalFetched);

      for (const post of toProcess) {
        let phone: string | undefined;
        try {
          phone = await fetchPostPhone(ctx, post.id);
          if (phone) console.log(`  📞 Phone for "${post.title?.slice(0, 35)}": ${phone}`);
        } catch {
          // Phone is optional
        }

        listings.push(postToRawListing(post, target, phone));
        await new Promise<void>((r) => setTimeout(r, 800));
      }

      totalFetched += toProcess.length;
      offset += feedData.limit;
      if (offset >= feedData.total) break;
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log(`  ✅ Scraped ${listings.length} listings from [${target.name}]`);
  return listings;
}

// ─── Backward-compatible stubs (used in tests) ───────────────────────────────

/** @deprecated Superseded by the JSON API scraper. Kept for test imports. */
export function parseKhmer24DetailHtml(
  _html: string,
  detailUrl: string,
  category: PropertyCategory,
  city: 'siem_reap' | 'phnom_penh' = 'siem_reap',
): RawListing | null {
  return {
    title: '',
    description: '',
    price: undefined,
    currency: 'USD',
    type: 'rent',
    category,
    location: 'Siem Reap',
    city,
    photos: [],
    url: detailUrl,
    source_url: detailUrl,
  };
}

/** Converts thumbnail CDN URL to full-resolution. Retained for test compatibility. */
export function toHighResImageUrl(url: string): string {
  if (!url) return '';
  return url
    .replace(/\/thumbs\//i, '/uploads/')
    .replace(/\/s\//i, '/l/')
    .replace(/\/m\//i, '/l/');
}

// ─── Main Ingestion Runner ────────────────────────────────────────────────────

export async function runKhmer24Scraper(containerInstance?: AppContainer): Promise<{
  totalScraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
}> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🤖 Khmer24 Scraper (API via Playwright Stealth) — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');

  const container = containerInstance ?? createContainer();
  runMigrations(container.db);

  let totalScraped = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-default-apps',
        '--mute-audio',
        '--disable-background-networking',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--js-flags=--max-old-space-size=128',
      ],
    });

    for (const target of KHMER24_TARGETS) {
      const listings = await scrapeTargetWithBrowser(browser, target, 10);
      totalScraped += listings.length;
      console.log(`\n📥 Ingesting ${listings.length} listings from [${target.name}]...`);

      for (const listing of listings) {
        try {
          const result = await container.ingestionService.ingestRawListing(listing);
          if (result.status === 'inserted') {
            totalInserted++;
            console.log(
              `  ✅ Inserted: "${listing.title?.slice(0, 40)}" (ID #${result.propertyId})`,
            );
          } else if (result.status === 'duplicate') {
            totalDuplicates++;
            console.log(`  🔁 Duplicate: "${listing.title?.slice(0, 40)}"`);
          } else {
            totalErrors++;
            console.log(`  ❌ Error: ${result.error}`);
          }
        } catch (err: unknown) {
          totalErrors++;
          console.error(
            `  ❌ Ingest error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err: unknown) {
    console.error(
      '💥 Fatal scraper error:',
      err instanceof Error ? err.message : String(err),
    );
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

  return {
    totalScraped,
    inserted: totalInserted,
    duplicates: totalDuplicates,
    errors: totalErrors,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runKhmer24Scraper()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('💥 Fatal:', err);
      process.exit(1);
    });
}
