/**
 * Facebook Groups Real Estate Scraper
 *
 * Architecture:
 *  - Uses Playwright with Stealth plugin and saved session cookies (`./data/fb_session.json`).
 *  - Navigates to targeted Facebook Groups (e.g., Siem Reap real estate & rental groups).
 *  - Emulates human-like scrolling behavior with randomized delays to trigger React lazy-loading.
 *  - Expands "See more" post buttons to capture complete text.
 *  - Extracts post permalinks, text content, and photos (for pHash deduplication).
 *  - Feeds extracted data through `extractor.ts` heuristics to structure price, location, bedrooms, etc.
 *  - Ingests clean listings into the `ingestRawListing` pipeline with automatic deduplication.
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
import { FB_GROUPS, type CityKey, type FBGroupConfig, type PropertyCategory } from '../../config/settings';
import {
  extractBedrooms,
  extractBathrooms,
  extractCategory,
  extractDeposit,
  extractHasPool,
  extractListingWithLLM,
  extractLocation,
  extractMapsUrl,
  extractMinLease,
  extractPrice,
  extractType,
} from './extractor';

// Apply stealth plugin
chromium.use(stealthPlugin());

export const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');

export class FacebookSessionExpiredError extends Error {
  constructor(message = 'Facebook session expired or blocked') {
    super(message);
    this.name = 'FacebookSessionExpiredError';
  }
}

// ─── Target Group Definitions ─────────────────────────────────────────────────

export interface FBGroupTarget {
  name: string;
  url: string;
  city: CityKey;
  defaultCategory?: PropertyCategory;
}

export const FB_GROUP_TARGETS: FBGroupTarget[] = FB_GROUPS.map((g) => ({
  name: g.name,
  url: g.url,
  city: g.city,
  defaultCategory: g.defaultCategory,
}));

// ─── Helpers & Anti-Bot Human Simulation ──────────────────────────────────────

function sleepRandom(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shuffleArray<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

const VIEWPORT_PRESETS = [
  { width: 1280, height: 850 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

async function simulateHumanMouseMove(page: Page): Promise<void> {
  try {
    const x = Math.floor(Math.random() * 700) + 150;
    const y = Math.floor(Math.random() * 450) + 150;
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 7) + 3 });
  } catch {
    // ignore
  }
}

async function simulateHumanScroll(page: Page): Promise<void> {
  // 15% chance of small reverse scroll up (mimics re-reading or re-checking a listing)
  if (Math.random() < 0.15) {
    const upDist = -(Math.floor(Math.random() * 180) + 80);
    await page.evaluate((top) => {
      const win = globalThis as unknown as { scrollBy: (opt: { top: number; behavior: string }) => void };
      if (typeof win.scrollBy === 'function') win.scrollBy({ top, behavior: 'smooth' });
    }, upDist);
    await sleepRandom(700, 1500);
  }

  // Downward scroll with variable distance
  const downDist = Math.floor(Math.random() * 380) + 380;
  await page.evaluate((top) => {
    const win = globalThis as unknown as { scrollBy: (opt: { top: number; behavior: string }) => void };
    if (typeof win.scrollBy === 'function') win.scrollBy({ top, behavior: 'smooth' });
  }, downDist);
}

/**
 * Strips tracking parameters from Facebook URLs.
 */
export function cleanFacebookUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = ['__cft__', '__tn__', 'ref', 'extid', 'mibextid', 'rdid'];
    trackingParams.forEach((param) => {
      Array.from(parsed.searchParams.keys()).forEach((key) => {
        if (key.startsWith(param)) {
          parsed.searchParams.delete(key);
        }
      });
    });
    const query = parsed.searchParams.toString();
    return query ? `${parsed.origin}${parsed.pathname}?${query}` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl.split('?')[0] || rawUrl;
  }
}

/** Extracts phone numbers from raw text using Cambodia phone regex */
export function extractPhoneFromText(text: string): string | undefined {
  const m = /(?:\+?855[\d\s-]{7,12}|0\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4})/.exec(text);
  return m?.[0]?.trim();
}

/** Parses raw Facebook post content into a structured RawListing via LLM or heuristics fallback */
export async function parseFacebookPostText(
  text: string,
  target: FBGroupTarget,
  postUrl: string,
  photos: string[] = [],
  rawDate?: string,
): Promise<RawListing | null> {
  // 1. Try LLM extraction first (Gemini / OpenAI)
  const llm = await extractListingWithLLM(text);

  // Ingestion Gateway Filter:
  // If LLM determines this is NOT real estate (e.g. second-hand items, vehicles) OR category is 'land', silently drop/ignore!
  if (llm) {
    if (llm.is_real_estate === false || llm.category === 'land') {
      return null;
    }
  }

  // Heuristic land sales detection fallback
  const isLand =
    /\b(?:land for sale|selling land|ដីលក់|ដីអាជីវកម្ម|\$\s*\d+\s*\/\s*m2|\$\s*\d+\s*ក្នុង\s*១\s*ម៉ែត្រការ៉េ)\b/i.test(
      text,
    );
  if (isLand && (!llm || llm.category === null)) {
    return null;
  }

  // 2. Extract values combining LLM results with heuristic fallbacks
  const priceResult = extractPrice(text);
  const priceInDollars =
    llm?.price != null ? llm.price : priceResult ? priceResult.amountCents / 100 : undefined;
  const currency = llm?.currency ?? priceResult?.currency ?? 'USD';

  const bedrooms =
    llm?.bedrooms !== undefined && llm.bedrooms !== null
      ? llm.bedrooms
      : extractBedrooms(text) ?? undefined;
  const bathrooms =
    llm?.bathrooms !== undefined && llm.bathrooms !== null
      ? llm.bathrooms
      : extractBathrooms(text) ?? undefined;

  let category: PropertyCategory = target.defaultCategory ?? 'house';
  if (llm?.category && ['apartment', 'house', 'room'].includes(llm.category)) {
    category = llm.category as PropertyCategory;
  } else {
    const heuristicCat = extractCategory(text);
    if (heuristicCat) category = heuristicCat;
  }

  const hasPool = llm?.has_pool != null ? llm.has_pool : extractHasPool(text);
  const minLease = llm?.min_lease ?? extractMinLease(text) ?? undefined;
  const depositCents = extractDeposit(text, priceResult?.amountCents);
  const depositInDollars = depositCents ? depositCents / 100 : undefined;

  const locationResult = extractLocation(text);
  const location = llm?.location || locationResult?.location || undefined;
  const city = locationResult?.city ?? target.city;
  const type = extractType(text) ?? 'rent';
  const mapsUrl = llm?.maps_url || extractMapsUrl(text) || undefined;
  const regexPhone = extractPhoneFromText(text);
  const aiPhones = llm?.phone_numbers ?? [];
  const allPhones = [...aiPhones, regexPhone].filter(Boolean) as string[];
  const uniquePhones = Array.from(new Set(allPhones));
  const phone = uniquePhones.length > 0 ? uniquePhones.join(' / ') : undefined;

  const description = llm?.description_en || text;

  // Title: use catchy LLM title (max 5 words) or clean fallback
  let title = llm?.title?.trim() || '';
  if (!title) {
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 5);
    title = firstLine ? firstLine.slice(0, 80) : '';
  }
  if (!title) {
    const bedsText = bedrooms ? `${bedrooms}BR ` : '';
    const catText = category === 'apartment' ? 'Apartment' : category === 'room' ? 'Room' : 'House';
    const locPart = location ? ` in ${location}` : '';
    title = `${bedsText}${catText}${locPart}`;
  }

  const cleanedUrl = cleanFacebookUrl(postUrl);

  return {
    title,
    description,
    price: priceInDollars,
    currency,
    type,
    category,
    bedrooms,
    bathrooms,
    deposit: depositInDollars,
    min_lease: minLease,
    has_pool: hasPool,
    location,
    city,
    maps_url: mapsUrl,
    source_url: cleanedUrl,
    url: cleanedUrl,
    photos,
    phone,
    posted_at: parseFacebookRelativeDate(rawDate),
  };
}

export function parseFacebookRelativeDate(dateStr?: string, nowMs = Date.now()): string | undefined {
  if (!dateStr) return undefined;
  const s = dateStr.trim().toLowerCase();

  // "5m", "5 min", "5 mins", "5 minutes ago", "5 мин."
  const minMatch = /(\d+)\s*(?:m|min|mins|minute|minutes|мин)/.exec(s);
  if (minMatch) {
    return new Date(nowMs - parseInt(minMatch[1]!, 10) * 60 * 1000).toISOString();
  }

  // "3h", "3 hr", "3 hrs", "3 hours ago", "3 ч."
  const hrMatch = /(\d+)\s*(?:h|hr|hrs|hour|hours|ч)/.exec(s);
  if (hrMatch) {
    return new Date(nowMs - parseInt(hrMatch[1]!, 10) * 3600 * 1000).toISOString();
  }

  // "2d", "2 days ago", "2 дн."
  const dayMatch = /(\d+)\s*(?:d|day|days|дн)/.exec(s);
  if (dayMatch) {
    return new Date(nowMs - parseInt(dayMatch[1]!, 10) * 86400 * 1000).toISOString();
  }

  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  return undefined;
}

// ─── DOM Post Extractor ───────────────────────────────────────────────────────

interface ExtractedDomPost {
  text: string;
  url: string;
  photos: string[];
  rawDate?: string;
}

/**
 * Extracts visible posts from the Facebook group feed in the browser page context.
 * Targets ONLY message body, explicitly excluding UI noise, timestamps, and author text.
 */
async function extractPostsFromPage(page: Page): Promise<ExtractedDomPost[]> {
  return page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: {
          querySelectorAll: (sel: string) => { forEach: (cb: (unit: unknown) => void) => void };
        };
      }
    ).document;
    const results: Array<{ text: string; url: string; photos: string[]; rawDate?: string }> = [];

    // Find all post feed containers
    const feedUnits = doc.querySelectorAll(
      '[role="feed"] > div, div[role="article"], div[data-pagelet*="FeedUnit"]',
    );

    feedUnits.forEach((unit: unknown) => {
      const el = unit as {
        querySelector: (sel: string) => {
          textContent?: string | null;
          getAttribute: (attr: string) => string | null;
          href?: string;
        } | null;
        querySelectorAll: (sel: string) => Array<{
          getAttribute: (attr: string) => string | null;
          src?: string;
          width?: number;
          height?: number;
          naturalWidth?: number;
          naturalHeight?: number;
          textContent?: string | null;
        }>;
        textContent?: string | null;
      };

      // 1. Target specifically the post message body (excluding headers, authors, timestamps)
      const textContainer = el.querySelector(
        'div[data-ad-comet-preview="message"], div[data-ad-preview="message"]',
      );

      let rawText = '';
      if (textContainer && textContainer.textContent) {
        rawText = textContainer.textContent;
      } else {
        const contentContainers = el.querySelectorAll('div[dir="auto"]');
        for (const c of contentContainers) {
          const t = (c.textContent || '').trim();
          if (t.length > 30 && !t.includes('Поделился') && !t.includes('Подписаться')) {
            rawText = t;
            break;
          }
        }
      }

      // Clean out UI noise / button artifacts ("Translate", "See translation", "Ещё", etc.)
      const text = rawText
        .replace(
          /\b(?:Показать перевод|Show translation|See translation|See original|Поделился\/-ась|Подписаться|Общедоступная группа)\b/gi,
          '',
        )
        .replace(/\.\.\.\s*(?:Ещё|See more|See More)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Skip posts that are too short to be property listings
      if (text.length < 25) return;

      // 2. Extract Post Permanent URL
      let postUrl = '';
      const permalinkAnchor = el.querySelector(
        'a[href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[role="link"][href*="facebook.com/groups/"]',
      );
      if (permalinkAnchor) {
        postUrl = permalinkAnchor.href || permalinkAnchor.getAttribute('href') || '';
      }

      if (!postUrl) {
        const anyPostLink = el.querySelector('a[href*="groups/"]');
        if (anyPostLink) {
          postUrl = anyPostLink.href || anyPostLink.getAttribute('href') || '';
        }
      }

      // 3. Extract Attached Images (filtering out small icons/avatars)
      const photos: string[] = [];
      const imgElements = el.querySelectorAll('img');
      imgElements.forEach((img) => {
        const src = img.src || img.getAttribute('src');
        if (!src) return;
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        const isThumbnail =
          src.includes('emoji') ||
          src.includes('profile') ||
          (width > 0 && width < 120) ||
          (height > 0 && height < 120);
        if (!isThumbnail && (src.includes('fbcdn') || src.includes('scontent'))) {
          if (!photos.includes(src)) {
            photos.push(src);
          }
        }
      });

      // 4. Extract Post Creation Timestamp String
      let rawDate = '';
      if (permalinkAnchor) {
        rawDate = permalinkAnchor.getAttribute('aria-label') || permalinkAnchor.textContent || '';
      }
      if (!rawDate) {
        const timeEl = el.querySelector('abbr, a[href*="/posts/"] span, span[id*="jsc_c"]');
        if (timeEl) {
          rawDate = timeEl.getAttribute('aria-label') || timeEl.textContent || '';
        }
      }

      if (text && (postUrl || photos.length > 0)) {
        results.push({ text, url: postUrl, photos, rawDate: rawDate.trim() });
      }
    });

    return results;
  });
}

// ─── Group Scraper ────────────────────────────────────────────────────────────

export async function scrapeFacebookGroup(
  context: BrowserContext,
  target: FBGroupTarget,
  maxPosts = 15,
  container?: AppContainer,
): Promise<RawListing[]> {
  console.log(`\n🔎 Scraping Facebook Group: [${target.name}]`);
  console.log(`🔗 URL: ${target.url}`);

  const page = await context.newPage();
  const listings: RawListing[] = [];
  const seenUrls = new Set<string>();

  try {
    // Block stylesheets, fonts, media, tracking, and non-listing UI images to minimize Chromium memory footprint
    await page.route('**/*', (route) => {
      const req = route.request();
      const url = req.url().toLowerCase();
      const type = req.resourceType();

      // Block tracking, analytics, and telemetry
      if (
        url.includes('google-analytics') ||
        url.includes('googletagmanager') ||
        url.includes('doubleclick') ||
        url.includes('connect.facebook.net/signals') ||
        url.includes('facebook.com/tr/') ||
        url.includes('facebook.com/ajax/bz') ||
        url.includes('pixel')
      ) {
        return route.abort();
      }

      // Block stylesheets, fonts, audio/video media, and non-essential resources
      if (['stylesheet', 'font', 'media', 'other'].includes(type)) {
        return route.abort();
      }

      // Block non-listing images: emojis, UI icons, profile photos, static sprites
      if (type === 'image') {
        const isListingPhoto = url.includes('scontent') || url.includes('fbcdn.net/v/');
        const isNoise =
          url.includes('emoji') ||
          url.includes('rsrc.php') ||
          url.includes('profile') ||
          url.includes('static.xx.fbcdn.net') ||
          url.includes('lookaside');

        if (isNoise || !isListingPhoto) {
          return route.abort();
        }
      }

      return route.continue();
    });

    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleepRandom(3000, 5000);

    // 1. Detect if redirected to login page or checkpoint
    const currentUrl = page.url();
    const isLoginRedirect =
      currentUrl.includes('/login') ||
      currentUrl.includes('/checkpoint') ||
      currentUrl.includes('/recover') ||
      currentUrl.includes('two_step_verification');

    if (isLoginRedirect) {
      throw new FacebookSessionExpiredError(`Redirected to login/checkpoint URL: ${currentUrl}`);
    }

    // 2. Detect login form elements on page
    const hasLoginForm =
      (await page
        .locator(
          'input[name="email"], input[name="pass"], form[action*="login"], [data-testid="royal_login_button"]',
        )
        .count()) > 0;

    if (hasLoginForm) {
      throw new FacebookSessionExpiredError('Facebook login form detected on page');
    }

    // Click "Close" / dismiss on any login/cookie popups if present
    const closeButtons = page.locator(
      'div[role="dialog"] div[role="button"][aria-label="Close"], [aria-label="Decline optional cookies"], [data-testid="cookie-policy-manage-dialog-accept-button"]',
    );
    if ((await closeButtons.count()) > 0) {
      await closeButtons.first().click().catch(() => {});
      await sleepRandom(1000, 2000);
    }

    // 3. Verify feed container or posts presence
    const hasFeed =
      (await page
        .locator(
          '[role="feed"], div[role="article"], div[data-pagelet*="FeedUnit"], div[data-ad-preview="message"]',
        )
        .count()) > 0;

    if (!hasFeed) {
      const isBlockedDialog =
        (await page
          .locator('[role="dialog"]:has-text("Log In"), [role="dialog"]:has-text("Sign Up"), [role="dialog"]:has-text("blocked")')
          .count()) > 0;
      if (isBlockedDialog) {
        throw new FacebookSessionExpiredError('Facebook login/blocking dialog detected');
      }
    }

    let scrollAttempts = 0;
    const maxScrolls = 6;

    while (listings.length < maxPosts && scrollAttempts < maxScrolls) {
      // Natural human mouse movement across the viewport
      await simulateHumanMouseMove(page);

      // Expand "See more" buttons with realistic human cadence
      try {
        const seeMoreBtns = page.locator(
          'div[role="button"]:has-text("See more"), div[role="button"]:has-text("See More"), div[role="button"]:has-text("Показать больше")',
        );
        const count = await seeMoreBtns.count();
        for (let i = 0; i < Math.min(count, 4); i++) {
          await simulateHumanMouseMove(page);
          await seeMoreBtns.nth(i).click().catch(() => {});
          await sleepRandom(350, 950);
        }
      } catch {
        // Continue if expanding fails
      }

      // Extract visible posts from current viewport DOM
      const domPosts = await extractPostsFromPage(page);

      for (const domPost of domPosts) {
        const cleanedUrl = cleanFacebookUrl(domPost.url) || `https://facebook.com/post-${listings.length + 1}`;
        if (seenUrls.has(cleanedUrl)) continue;
        seenUrls.add(cleanedUrl);

        // Pre-Filtering (Save AI Tokens): check if source_url already exists in DB
        if (container && cleanedUrl && !cleanedUrl.includes('post-')) {
          const existingInDb = container.propertiesRepo.findBySourceUrl(cleanedUrl);
          if (existingInDb) {
            const createdAtMs = new Date(existingInDb.created_at).getTime();
            const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000;
            const isOlderThan45Days =
              !isNaN(createdAtMs) && Date.now() - createdAtMs >= FORTY_FIVE_DAYS_MS;

            if (isOlderThan45Days) {
              console.log(
                `  🔄 [Re-listing >45 days old] Post #${existingInDb.id} (${existingInDb.created_at}): ${cleanedUrl}`,
              );
            } else {
              console.log(`  ⏩ [Skipped - Already in DB] Post #${existingInDb.id}: ${cleanedUrl}`);
              continue;
            }
          }
        }

        try {
          const rawListing = await parseFacebookPostText(domPost.text, target, cleanedUrl, domPost.photos, domPost.rawDate);
          if (!rawListing) {
            console.log(`  ⏩ [Skipped] Post identified as non-residential / land sale / irrelevant`);
            continue;
          }
          listings.push(rawListing);
          console.log(
            `  📄 [Post #${listings.length}] "${rawListing.title?.slice(0, 45)}" | ` +
              `💰 $${rawListing.price ?? '?'} | 📍 ${rawListing.location} | 🖼️ ${rawListing.photos.length} photos`,
          );
        } catch (err: unknown) {
          console.warn(`  ⚠️ Failed to parse post: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (listings.length >= maxPosts) break;
      }

      // Variable human scroll with occasional slight upward backtrack
      await simulateHumanScroll(page);
      scrollAttempts++;

      // Realistic reading pause between scroll iterations
      await sleepRandom(2800, 5200);

      // 12% probability of a longer human reading pause (6s - 11s)
      if (Math.random() < 0.12) {
        await sleepRandom(6000, 11000);
      }
    }
  } catch (err: unknown) {
    if (err instanceof FacebookSessionExpiredError) {
      throw err;
    }
    console.error(`💥 Error scraping group [${target.name}]:`, err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`  ✅ Extracted ${listings.length} posts from [${target.name}]`);
  return listings;
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

export async function runFacebookScraper(containerInstance?: AppContainer): Promise<{
  totalScraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
}> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🤖 Facebook Groups Real Estate Scraper — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');

  const container = containerInstance ?? createContainer();
  runMigrations(container.db);

  // Check if session file exists
  if (!fs.existsSync(FB_SESSION_PATH)) {
    console.warn(`\n⚠️  Facebook session not found at: ${FB_SESSION_PATH}`);
    console.warn('👉 Please run "npm run fb:login" first to log in manually and save your session.\n');
    await container.notifierService.notifyAdmins('⚠️ Facebook session expired or blocked. Please run <code>npm run fb:login</code> on the server.');
    return { totalScraped: 0, inserted: 0, duplicates: 0, errors: 1 };
  }

  let totalScraped = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    console.log('🌐 Launching headless browser with saved session...');
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

    const chosenViewport = VIEWPORT_PRESETS[Math.floor(Math.random() * VIEWPORT_PRESETS.length)]!;
    const chosenUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;

    context = await browser.newContext({
      storageState: FB_SESSION_PATH,
      userAgent: chosenUserAgent,
      viewport: chosenViewport,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Shuffle groups to break predictable traversal patterns
    const targets = shuffleArray(FB_GROUP_TARGETS);
    console.log(`🎲 [Anti-Bot] Randomized group traversal order (${targets.length} groups, viewport ${chosenViewport.width}x${chosenViewport.height}).`);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;

      try {
        const listings = await scrapeFacebookGroup(context, target, 10, container);
        totalScraped += listings.length;

        console.log(`\n📥 Ingesting ${listings.length} listings from [${target.name}]...`);

        for (const listing of listings) {
          try {
            const result = await container.ingestionService.ingestRawListing(listing);
            if (result.status === 'inserted') {
              totalInserted++;
              console.log(`  ✅ Inserted: "${listing.title?.slice(0, 40)}" (ID #${result.propertyId})`);
            } else if (result.status === 'duplicate') {
              totalDuplicates++;
              console.log(`  🔁 Duplicate: "${listing.title?.slice(0, 40)}" (Reason: ${result.reason || 'match'})`);
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
        if (err instanceof FacebookSessionExpiredError) {
          console.error(`💥 Facebook session expired or blocked: ${err.message}`);
          console.error('📢 Sending high-priority alert to administrators...');
          await container.notifierService.notifyAdmins(
            '⚠️ Facebook session expired or blocked. Please run <code>npm run fb:login</code> on the server.',
          );
          totalErrors++;
          // Halt further group scraping to avoid triggering security flags
          break;
        } else {
          totalErrors++;
          console.error(`💥 Error processing group [${target.name}]:`, err instanceof Error ? err.message : String(err));
        }
      }

      // Randomized human-like cooldown (15s to 35s) between groups to evade rate-limits
      if (i < targets.length - 1) {
        const cooldownMs = Math.floor(Math.random() * 20000) + 15000;
        console.log(`⏳ Anti-bot cooldown: waiting ${Math.round(cooldownMs / 1000)}s before next group...`);
        await sleepRandom(cooldownMs, cooldownMs + 1000);
      }
    }
  } catch (err: unknown) {
    console.error('💥 Fatal Facebook scraper error:', err instanceof Error ? err.message : String(err));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await container.notifierService.flushNotificationQueue().catch((err) => console.error('[Notifier] Flush error:', err));
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 Facebook Scraper Summary:');
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
  runFacebookScraper()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('💥 Fatal:', err);
      process.exit(1);
    });
}
