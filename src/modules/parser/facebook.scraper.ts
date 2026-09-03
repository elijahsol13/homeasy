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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleepRandom(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  };
}

// ─── DOM Post Extractor ───────────────────────────────────────────────────────

interface ExtractedDomPost {
  text: string;
  url: string;
  photos: string[];
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
    const results: Array<{ text: string; url: string; photos: string[] }> = [];

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

      if (text && (postUrl || photos.length > 0)) {
        results.push({ text, url: postUrl, photos });
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
    // Block video media and custom fonts to minimize Chromium memory footprint
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['media', 'font'].includes(type)) {
        return route.abort();
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
    const maxScrolls = 8;

    while (listings.length < maxPosts && scrollAttempts < maxScrolls) {
      // Expand "See more" buttons to reveal full description text
      try {
        const seeMoreBtns = page.locator(
          'div[role="button"]:has-text("See more"), div[role="button"]:has-text("See More"), div[role="button"]:has-text("Показать больше")',
        );
        const count = await seeMoreBtns.count();
        for (let i = 0; i < Math.min(count, 5); i++) {
          await seeMoreBtns.nth(i).click().catch(() => {});
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
          const rawListing = await parseFacebookPostText(domPost.text, target, cleanedUrl, domPost.photos);
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

      // Gentle smooth scroll down to trigger React virtualized rendering
      await page.evaluate(() => {
        const win = globalThis as unknown as { scrollBy: (opt: { top: number; behavior: string }) => void };
        if (typeof win.scrollBy === 'function') {
          win.scrollBy({ top: 600, behavior: 'smooth' });
        }
      });
      scrollAttempts++;
      await sleepRandom(2500, 4500);
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

    context = await browser.newContext({
      storageState: FB_SESSION_PATH,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 850 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    for (let i = 0; i < FB_GROUP_TARGETS.length; i++) {
      const target = FB_GROUP_TARGETS[i]!;

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

      // Randomized delay (10-30s) between groups to avoid rate-limiting
      if (i < FB_GROUP_TARGETS.length - 1) {
        console.log('⏳ Waiting 10-30s before scraping next group to avoid rate-limiting...');
        await sleepRandom(10000, 30000);
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
