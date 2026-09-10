/**
 * Facebook Groups Real Estate Scraper — GraphQL API Interception Architecture
 *
 * Architecture:
 *  - STRICT LAW: Automated headless password entry or console credential passing to Facebook
 *    is prohibited (triggers instant checkpoints/blocks). Authentication must be performed
 *    visually by a human (via /auth_fb remote browser stream or visual fb:login).
 *  - Must always route through resident proxy (FB_PROXY) to safeguard datacenter IP reputation.
 *  - Uses Playwright with Stealth plugin and saved session cookies (`./data/fb_session.json`).
 *  - Navigates to targeted Facebook Groups (e.g., Siem Reap real estate & rental groups).
 *  - Intercepts internal GraphQL API responses (`/api/graphql/`) via `page.on('response')`.
 *  - Recursively extracts full un-truncated post text, direct photo URLs, and timestamps from Relay Comet nodes.
 *  - Emulates human-like scrolling behavior with randomized delays to trigger React GraphQL pagination.
 *  - Feeds extracted data through `extractor.ts` heuristics/LLM to structure price, location, bedrooms, etc.
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
import { InlineKeyboard } from 'grammy';
import { env } from '../../config/env';
import type { Property } from '../../database/repositories/properties.repo';
import {
  parseProxyConfig,
  isProxyError,
  ProxyConnectionError,
  type PlaywrightProxyConfig,
  type ParsedProxyResult,
} from './proxy';
import { attachTrafficGuard } from './traffic-guard';
import { FB_GROUPS, type CityKey, type PropertyCategory } from '../../config/settings';
import { loadGroupState, saveGroupState, FBGroupState } from './fb-state';
import { fetchPostTextAnonymous, type FetchedFbPost } from './fb-worker';
import {
  extractBedrooms,
  extractBathrooms,
  extractCategory,
  extractDeposit,
  extractHasPool,
  extractListingWithLLM,
  extractListingsBatchWithLLM,
  extractLocation,
  extractMapsUrl,
  extractMinLease,
  extractPrice,
  extractType,
  isExcessiveKhmer,
  type LLMExtractedListing,
} from './extractor';
import { cleanPhotoUrls, extractDirectContacts, formatDomesticPhone } from './normalizer';
import { isNonRealEstateSpam } from './spam-detector';

// Apply stealth plugin
chromium.use(stealthPlugin());

export const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');
export const BROWSER_CACHE_DIR = path.join(process.cwd(), 'data', 'browser_cache');
export const SCRAPER_STATE_PATH = path.join(process.cwd(), 'data', 'scraper_state.json');

export interface ScraperState {
  fbGroupCursor: number;
  lastCycleAt?: string;
}

export function loadScraperState(): ScraperState {
  try {
    if (fs.existsSync(SCRAPER_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(SCRAPER_STATE_PATH, 'utf-8'));
      if (typeof data.fbGroupCursor === 'number') {
        return data;
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to read scraper_state.json, starting from cursor 0:', err);
  }
  return { fbGroupCursor: 0 };
}

export function saveScraperState(state: ScraperState): void {
  try {
    const dir = path.dirname(SCRAPER_STATE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SCRAPER_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('⚠️ Failed to save scraper_state.json:', err);
  }
}

export function getNextGroupBatch(
  allTargets: readonly FBGroupTarget[],
  batchSize: number = env.FB_GROUPS_PER_CYCLE ?? 5,
): { batch: FBGroupTarget[]; nextCursor: number } {
  if (allTargets.length === 0) return { batch: [], nextCursor: 0 };
  const state = loadScraperState();
  const cursor = ((state.fbGroupCursor % allTargets.length) + allTargets.length) % allTargets.length;
  const batch: FBGroupTarget[] = [];

  const count = Math.min(batchSize, allTargets.length);
  for (let i = 0; i < count; i++) {
    const idx = (cursor + i) % allTargets.length;
    batch.push(allTargets[idx]!);
  }

  const nextCursor = (cursor + count) % allTargets.length;
  saveScraperState({
    fbGroupCursor: nextCursor,
    lastCycleAt: new Date().toISOString(),
  });

  return { batch, nextCursor };
}

/** In-Memory translation retry queue for posts with low-quality translation (>10% Khmer) */
export interface TranslationRetryItem {
  id: string;
  text: string;
  retries: number;
  target?: FBGroupTarget;
  postUrl?: string;
  photos?: string[];
  rawDate?: string;
}

export const MAX_TRANSLATION_RETRY_QUEUE_SIZE = 20;
export const translationRetryQueue: TranslationRetryItem[] = [];

export class SessionDegradedError extends Error {
  constructor() {
    super('FB Session Degraded or Logged Out');
  }
}

export class FacebookSessionExpiredError extends Error {
  constructor(message = 'Facebook session expired or blocked') {
    super(message);
    this.name = 'FacebookSessionExpiredError';
  }
}

export {
  parseProxyConfig,
  isProxyError,
  ProxyConnectionError,
  type PlaywrightProxyConfig,
  type ParsedProxyResult,
};

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
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
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
    // Standardize desktop web.facebook.com to www.facebook.com so mobile browsers open it natively
    if (parsed.hostname === 'web.facebook.com' || parsed.hostname === 'm.facebook.com') {
      parsed.hostname = 'www.facebook.com';
    }
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
    return (rawUrl.split('?')[0] || rawUrl).replace('web.facebook.com', 'www.facebook.com');
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
  precomputedLlm?: LLMExtractedListing | null,
): Promise<RawListing | null> {
  // 0. Pre-filter spam before calling LLM (saves AI quotas)
  const spamCheck = isNonRealEstateSpam(text.slice(0, 100), text);
  if (spamCheck.isSpam) {
    console.log(`  ⏩ [Skipped - Spam] ${spamCheck.reason}`);
    return null;
  }

  // 1. Try LLM extraction (use precomputed from batch or call single LLM)
  const llm = precomputedLlm !== undefined ? precomputedLlm : await extractListingWithLLM(text);

  // Ingestion Gateway Filter:
  // If LLM determines this is NOT real estate (e.g. second-hand items, vehicles) OR category is 'land', silently drop/ignore!
  if (llm) {
    if (llm.is_real_estate === false || llm.category === 'land') {
      return null;
    }
    // Translation quality check: discard if >10% Khmer characters in English description
    if (isExcessiveKhmer(llm.description_en)) {
      console.log(`  ⏩ [Skipped - Low Translation Quality] Post description has >10% Khmer`);
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
  if (llm?.category && ['apartment', 'house', 'room', 'hotel'].includes(llm.category)) {
    category = llm.category as PropertyCategory;
  } else {
    const heuristicCat = extractCategory(text);
    if (heuristicCat) category = heuristicCat;
  }

  const hasPool = llm?.has_pool != null ? llm.has_pool : extractHasPool(text);
  const minLease = llm?.min_lease ?? extractMinLease(text) ?? undefined;
  const depositCents = extractDeposit(text, priceResult?.amountCents);
  const depositInDollars =
    llm?.deposit != null ? llm.deposit  // LLM takes priority
    : depositCents ? depositCents / 100 : undefined;

  // The Facebook group is single-city and assigned at scrape time — always trust it.
  // Only use text matching to find the SPECIFIC sangkat/district within that city; never
  // let a marketing comparison ("cheaper than BKK1") flip the listing into the wrong city.
  const locationResult = extractLocation(text, target.city);
  const location = llm?.location || locationResult?.location || undefined;
  const city = target.city;
  const type = extractType(text) ?? 'rent';
  const mapsUrl = llm?.maps_url || extractMapsUrl(text) || undefined;
  const directContacts = extractDirectContacts(text);
  const regexPhone = directContacts.phone;
  const aiPhones = (llm?.phone_numbers ?? []).map((p) => formatDomesticPhone(p)).filter(Boolean) as string[];
  const allPhones = [...(regexPhone ? [regexPhone] : []), ...aiPhones];
  const uniquePhones = Array.from(new Set(allPhones));
  const phone = uniquePhones.length > 0 ? uniquePhones.join(' / ') : undefined;
  const telegram_contact = directContacts.telegram;

  const description = llm?.description_en || text;

  // Title: use catchy LLM title (max 5 words) or clean fallback
  let title = llm?.title_en?.trim() || '';
  if (!title) {
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 5);
    title = firstLine ? firstLine.slice(0, 80) : '';
  }
  if (!title) {
    const bedsText = bedrooms ? `${bedrooms}BR ` : '';
    const catText =
      category === 'apartment'
        ? 'Apartment'
        : category === 'hotel'
          ? 'Hotel Room'
          : category === 'room'
            ? 'Room'
            : 'House';
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
    photos: cleanPhotoUrls(photos),
    phone,
    telegram_contact,
    posted_at: parseFacebookRelativeDate(rawDate),
    property_type: llm?.property_type ?? undefined,
    electricity: llm?.electricity ?? undefined,
    water: llm?.water ?? undefined,
    cleaning: llm?.cleaning ?? undefined,
    restrictions: llm?.restrictions ?? undefined,
    pet_friendly: llm?.pet_friendly ?? undefined,
    amenities: llm?.discovered_amenities ?? undefined,
    marketing_landmarks: llm?.marketing_landmarks ?? undefined,
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

// ─── Facebook GraphQL API Types ───────────────────────────────────────────────

export interface FbGraphQLStoryNode {
  __typename?: string;
  id?: string;
  post_id?: string;
  url?: string;
  creation_time?: number | string;
  message?: { text?: string };
  shareable?: { url?: string; id?: string };
  comet_sections?: {
    context_layout?: {
      story?: {
        comet_sections?: {
          metadata?: Array<{
            story?: {
              creation_time?: number | string;
              url?: string;
            };
          }>;
        };
      };
    };
    content?: {
      story?: {
        message?: { text?: string };
        wwwURL?: string;
        comet_sections?: {
          message_container?: {
            story?: {
              message?: { text?: string };
            };
          };
        };
        attachments?: Array<{
          styles?: {
            attachment?: {
              media?: {
                photo_image?: { uri?: string };
                image?: { uri?: string };
              };
              all_subattachments?: {
                nodes?: Array<{
                  media?: {
                    image?: { uri?: string };
                    photo_image?: { uri?: string };
                  };
                }>;
              };
            };
          };
        }>;
      };
    };
    message?: {
      story?: {
        text?: string;
        message?: { text?: string };
      };
    };
  };
  attachments?: Array<unknown>;
  [key: string]: unknown;
}

export interface FbGraphQLEdge {
  node?: FbGraphQLStoryNode;
  cursor?: string;
  [key: string]: unknown;
}

export interface FbGraphQLFeedResponse {
  data?: {
    node?: {
      __typename?: string;
      group_feed?: {
        edges?: FbGraphQLEdge[];
        page_info?: { end_cursor?: string; has_next_page?: boolean };
      };
      [key: string]: unknown;
    };
    viewer?: {
      news_feed?: { edges?: FbGraphQLEdge[] };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ParsedFbGraphQLPost {
  id?: string;
  text: string;
  postUrl: string;
  photos: string[];
  rawDate?: string;
}

// ─── GraphQL Extraction Engine ────────────────────────────────────────────────

/**
 * Recursively traverses any nested GraphQL response object to discover all Story nodes.
 */
export function extractStoriesFromGraphQL(root: unknown): FbGraphQLStoryNode[] {
  const stories: FbGraphQLStoryNode[] = [];
  const visited = new Set<unknown>();

  function walk(curr: unknown): void {
    if (!curr || typeof curr !== 'object' || visited.has(curr)) return;
    visited.add(curr);

    if (Array.isArray(curr)) {
      for (const item of curr) walk(item);
      return;
    }

    const obj = curr as Record<string, unknown>;

    // Check if current object represents a top-level Story node
    const isStory =
      (obj.__typename === 'Story' && (obj.id != null || obj.post_id != null || obj.comet_sections != null)) ||
      (obj.comet_sections != null && typeof obj.comet_sections === 'object');

    if (isStory) {
      stories.push(obj as FbGraphQLStoryNode);
      // A Story's internal comet_sections contain child story fragments of the same post.
      // Avoid recursing deeper inside this story node for other stories.
      return;
    }

    // Traverse children
    for (const val of Object.values(obj)) {
      walk(val);
    }
  }

  walk(root);
  return stories;
}

function cleanFbText(rawText: string): string {
  if (!rawText) return '';
  return rawText
    .replace(
      /\b(?:Показать перевод|Show translation|See translation|See original|Поделился\/-ась|Подписаться|Общедоступная группа)\b/gi,
      '',
    )
    .replace(/\.\.\.\s*(?:Ещё|See more|See More)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUiNoiseText(t: string): boolean {
  return (
    t.length < 5 ||
    t === 'Like' ||
    t === 'Comment' ||
    t === 'Share' ||
    t.startsWith('http') ||
    t === 'Public group' ||
    t === 'Visible to anyone'
  );
}

/**
 * Extracts complete un-truncated post text from a Story node.
 */
export function extractTextFromStory(node: FbGraphQLStoryNode): string {
  // 1. Check known high-priority Comet paths
  const cometContent = node.comet_sections?.content?.story;
  if (cometContent?.message?.text) {
    return cleanFbText(cometContent.message.text);
  }

  const messageContainer = cometContent?.comet_sections?.message_container?.story;
  if (messageContainer?.message?.text) {
    return cleanFbText(messageContainer.message.text);
  }

  const cometMessage = node.comet_sections?.message?.story;
  if (cometMessage?.text) {
    return cleanFbText(cometMessage.text);
  }
  if (cometMessage?.message?.text) {
    return cleanFbText(cometMessage.message.text);
  }

  if (node.message?.text) {
    return cleanFbText(node.message.text);
  }

  // 2. Fallback: search recursively inside comet_sections for any message text
  let bestText = '';
  function findText(curr: unknown): void {
    if (!curr || typeof curr !== 'object' || bestText.length > 50) return;
    const o = curr as Record<string, unknown>;
    if (typeof o.text === 'string' && o.text.length > bestText.length) {
      const t = o.text.trim();
      if (!isUiNoiseText(t)) {
        bestText = t;
      }
    }
    for (const val of Object.values(o)) {
      findText(val);
    }
  }

  if (node.comet_sections) {
    findText(node.comet_sections);
  }

  return cleanFbText(bestText);
}

/**
 * Extracts high-resolution direct photo URLs from a Story node.
 */
export function extractPhotosFromStory(node: FbGraphQLStoryNode): string[] {
  const photos: string[] = [];

  function addUrl(uri?: string): void {
    if (!uri || typeof uri !== 'string') return;
    const isPhoto = uri.includes('fbcdn') || uri.includes('scontent');
    const isNoise =
      uri.includes('emoji') ||
      uri.includes('profile') ||
      uri.includes('rsrc.php') ||
      uri.includes('static.xx.fbcdn.net') ||
      uri.includes('lookaside');

    if (isPhoto && !isNoise && !photos.includes(uri)) {
      photos.push(uri);
    }
  }

  // 1. Check known attachment layouts
  const attachments = node.comet_sections?.content?.story?.attachments;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      const media = att.styles?.attachment?.media;
      addUrl(media?.photo_image?.uri);
      addUrl(media?.image?.uri);

      // Subattachments (multi-photo albums)
      const subNodes = att.styles?.attachment?.all_subattachments?.nodes;
      if (Array.isArray(subNodes)) {
        for (const sub of subNodes) {
          addUrl(sub.media?.photo_image?.uri);
          addUrl(sub.media?.image?.uri);
        }
      }
    }
  }

  // 2. Recursive fallback to capture image URIs anywhere in the story
  function findUris(curr: unknown): void {
    if (!curr || typeof curr !== 'object') return;
    if (Array.isArray(curr)) {
      for (const item of curr) findUris(item);
      return;
    }
    const o = curr as Record<string, unknown>;
    if (typeof o.uri === 'string') addUrl(o.uri);
    if (typeof o.url === 'string') addUrl(o.url);

    for (const val of Object.values(o)) {
      findUris(val);
    }
  }

  findUris(node);
  return photos;
}

/**
 * Extracts the permalink URL for a Story node.
 */
export function extractUrlFromStory(node: FbGraphQLStoryNode, targetGroupUrl: string): string {
  // 1. Direct url property
  if (node.url) return cleanFacebookUrl(node.url);

  // 2. Metadata array in context layout
  const metadata = node.comet_sections?.context_layout?.story?.comet_sections?.metadata;
  if (Array.isArray(metadata)) {
    for (const meta of metadata) {
      if (meta.story?.url) return cleanFacebookUrl(meta.story.url);
    }
  }

  // 3. wwwURL in content story
  const wwwURL = node.comet_sections?.content?.story?.wwwURL;
  if (wwwURL) return cleanFacebookUrl(wwwURL);

  // 4. Shareable URL
  if (node.shareable?.url) return cleanFacebookUrl(node.shareable.url);

  // 5. Construct URL from Post ID if available
  const postId =
    node.post_id || (typeof node.id === 'string' && /^\d+$/.test(node.id) ? node.id : undefined);
  if (postId) {
    const baseGroup =
      targetGroupUrl.split('?')[0]?.replace(/\/$/, '') || 'https://www.facebook.com/groups';
    return `${baseGroup}/posts/${postId}/`;
  }

  return '';
}

/**
 * Extracts the publication date string from a Story node.
 */
export function extractDateFromStory(node: FbGraphQLStoryNode): string | undefined {
  // 1. Creation time (epoch seconds or milliseconds)
  const ct = node.creation_time;
  if (typeof ct === 'number' && ct > 0) {
    const ms = ct > 1e11 ? ct : ct * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof ct === 'string' && /^\d+$/.test(ct)) {
    const num = parseInt(ct, 10);
    const ms = num > 1e11 ? num : num * 1000;
    return new Date(ms).toISOString();
  }

  // 2. Metadata creation_time
  const metadata = node.comet_sections?.context_layout?.story?.comet_sections?.metadata;
  if (Array.isArray(metadata)) {
    for (const meta of metadata) {
      const metaCt = meta.story?.creation_time;
      if (typeof metaCt === 'number' && metaCt > 0) {
        const ms = metaCt > 1e11 ? metaCt : metaCt * 1000;
        return new Date(ms).toISOString();
      }
    }
  }

  return undefined;
}

/**
 * Extracts and maps all real estate candidate posts from a Facebook GraphQL response JSON.
 */
export function extractPostsFromFbGraphQL(
  json: unknown,
  targetGroupUrl: string,
): ParsedFbGraphQLPost[] {
  const stories = extractStoriesFromGraphQL(json);
  const results: ParsedFbGraphQLPost[] = [];
  const seenKeys = new Set<string>();

  for (const story of stories) {
    const text = extractTextFromStory(story);
    // Ignore posts with insufficient text for a real estate listing
    if (text.length < 25) continue;

    const postUrl = extractUrlFromStory(story, targetGroupUrl);
    const photos = extractPhotosFromStory(story);
    const rawDate = extractDateFromStory(story);

    const postId = story.post_id || story.id;
    const dedupKey = postId || postUrl || text.slice(0, 50);

    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    results.push({
      id: postId,
      text,
      postUrl,
      photos,
      rawDate,
    });
  }

  return results;
}

// ─── Group Scraper ────────────────────────────────────────────────────────────


function updateRecentIds(state: FBGroupState, extractedIds: string[]) {
    const all = [...extractedIds, ...state.recentPostIds];
    const unique = Array.from(new Set(all));
    state.recentPostIds = unique.slice(0, 50);
}

function updateAdaptiveInterval(state: FBGroupState, newPostsCount: number) {
    if (newPostsCount > 0) {
        state.currentIntervalMs = 5 * 60 * 1000;
    } else {
        const next = state.currentIntervalMs * 2;
        state.currentIntervalMs = Math.min(next, 4 * 60 * 60 * 1000);
    }
}

async function discoverNewPosts(page: any, target: FBGroupTarget, state: FBGroupState): Promise<string[]> {
    await attachTrafficGuard(page);
    const extractedIds: string[] = [];
    
    try {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const pageUrl = page.url();
        if (pageUrl.includes('/login') || (await page.content()).includes('You must log in to continue')) {
            throw new SessionDegradedError();
        }
        
        await page.evaluate(() => window.scrollBy(0, 500));
        await page.waitForTimeout(1500);
        
        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/posts/"]'));
            return anchors.map((a: any) => a.href);
        });

        for (const link of links) {
            const match = link.match(/\/posts\/(\d+)/);
            if (match) extractedIds.push(match[1]);
        }
    } catch (e) {
        throw e;
    }

    const uniqueExtracted = Array.from(new Set(extractedIds));
    const newIds = uniqueExtracted.filter(id => !state.recentPostIds.includes(id));
    
    newIds.forEach(id => {
        const groupPath = target.url.split('groups/')[1].split('?')[0].replace(/\/$/, '');
        const url = `https://www.facebook.com/groups/${groupPath}/posts/${id}/`;
        if (!state.pendingQueue.includes(url)) state.pendingQueue.push(url);
    });
    
    updateRecentIds(state, uniqueExtracted);
    updateAdaptiveInterval(state, newIds.length);
    state.lastCheckedAt = Date.now();
    
    return newIds;
}

export interface ScrapeGroupResult {
  listings: RawListing[];
  wireBytes: number;
  cachedHits: number;
  networkHits: number;
}

export async function scrapeFacebookGroup(
  context: BrowserContext | null,
  target: FBGroupTarget,
  maxPosts = 10,
  container: AppContainer,
  maxScrolls = 3,
): Promise<ScrapeGroupResult> {
    const groupId = target.url.match(/groups\/([^/?]+)/)?.[1] || "unknown";
    const state = loadGroupState(groupId);
    
    console.log(`\n🔎 [Adaptive FB] ${target.name}`);
    console.log(`   Pending in queue: ${state.pendingQueue.length}`);
    
    const timeSinceLast = Date.now() - state.lastCheckedAt;
    
    if (timeSinceLast >= state.currentIntervalMs) {
        console.log(`   Time to run Discovery (Interval: ${Math.round(state.currentIntervalMs/60000)}m)...`);
        if (!context) {
           console.log(`   No context available, skipping discovery.`);
        } else {
            const page = await context.newPage();
            try {
                const newIds = await discoverNewPosts(page, target, state);
                console.log(`   Discovery found ${newIds.length} new posts.`);
                saveGroupState(groupId, state);
            } catch (e: any) {
                if (e instanceof SessionDegradedError) {
                    console.warn(`   ⚠️  Session Degraded! Pausing Discovery. Worker will continue processing queue.`);
                    container.alertService.critical('Facebook Checkpoint: Session Expired. Discovery paused until re-auth.');
                } else {
                    console.error(`   ❌ Discovery error: ${e.message}`);
                }
            } finally {
                await page.close().catch(() => {});
            }
        }
    } else {
        console.log(`   Skipping Discovery. Next check in ${Math.round((state.currentIntervalMs - timeSinceLast)/60000)}m.`);
    }

    const listings: RawListing[] = [];
    // Process up to maxPosts from the queue
    const itemsToProcess = state.pendingQueue.splice(0, maxPosts);

    if (itemsToProcess.length > 0) {
        console.log(`   Worker processing ${itemsToProcess.length} posts from queue...`);

        // Phase 1: fetch raw post text/photos for the whole batch first (no LLM calls
        // yet). Still throttled between HTTP fetches to stay gentle on Facebook.
        const fetched: FetchedFbPost[] = [];
        for (const url of itemsToProcess) {
            const post = await fetchPostTextAnonymous(url);
            if (post) fetched.push(post);
            await new Promise(r => setTimeout(r, 1500));
        }

        // Phase 2: send all fetched posts through Gemini in micro-batches, then
        // finish building each RawListing via the existing single-post merge logic
        // (parseFacebookPostText), reusing its precomputedLlm hook to skip a second
        // per-post LLM call.
        const llmResults = await batchExtractFbPosts(fetched);
        for (let i = 0; i < fetched.length; i++) {
            const post = fetched[i]!;
            const precomputedLlm = llmResults.has(i) ? llmResults.get(i)! : null;
            try {
                const listing = await parseFacebookPostText(post.text, target, post.postUrl, post.photos, undefined, precomputedLlm);
                if (listing) listings.push(listing);
            } catch (err: unknown) {
                console.warn(`   ⚠️ Failed to parse post ${post.postUrl}:`, err instanceof Error ? err.message : String(err));
            }
        }

        saveGroupState(groupId, state);
    }

    return {
        listings,
        wireBytes: 0,
        cachedHits: 0,
        networkHits: itemsToProcess.length
    };
}

/** Number of posts sent per Gemini request — balances token cost vs. per-item accuracy. */
const FB_LLM_BATCH_SIZE = 6;

/**
 * Batches fetched Facebook post texts through `extractListingsBatchWithLLM` in
 * groups of `FB_LLM_BATCH_SIZE` to conserve Gemini quota (mirrors the batching
 * pattern used by `khmer24.scraper.ts` and `scripts/reparse-listings.ts`).
 * Obvious spam is pre-filtered before spending any quota on it. Returns a map
 * keyed by the post's index in `fetched`; callers should treat a missing key
 * as "no LLM data for this post" and fall back to heuristics-only extraction
 * (via `parseFacebookPostText`'s existing regex fallbacks) rather than firing
 * an extra single-post LLM call.
 */
export async function batchExtractFbPosts(fetched: FetchedFbPost[]): Promise<Map<number, LLMExtractedListing>> {
  const results = new Map<number, LLMExtractedListing>();
  if (fetched.length === 0) return results;

  const candidateIndices: number[] = [];
  fetched.forEach((post, idx) => {
    const spamCheck = isNonRealEstateSpam(post.text.slice(0, 100), post.text);
    if (spamCheck.isSpam) {
      console.log(`   ⏩ [Skipped - Spam] ${spamCheck.reason}`);
      return;
    }
    candidateIndices.push(idx);
  });

  for (let i = 0; i < candidateIndices.length; i += FB_LLM_BATCH_SIZE) {
    const chunkIndices = candidateIndices.slice(i, i + FB_LLM_BATCH_SIZE);
    const batchInput = chunkIndices.map((idx) => ({ id: idx, text: fetched[idx]!.text }));

    console.log(
      `   🚀 [AI Batch ${Math.floor(i / FB_LLM_BATCH_SIZE) + 1}/${Math.ceil(candidateIndices.length / FB_LLM_BATCH_SIZE)}] Rewriting ${batchInput.length} posts with Gemini...`,
    );
    try {
      const batchResult = await extractListingsBatchWithLLM(batchInput);
      for (const [id, llm] of batchResult) {
        results.set(Number(id), llm);
      }
    } catch (err: unknown) {
      console.warn(`   ⚠️ [AI Batch] Failed, remaining posts in this chunk fall back to heuristics: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}
export async function reparseFacebookViaGroupFeed(
  containerInstance?: AppContainer,
  options: {
    maxScrollsPerGroup?: number;
    targets?: FBGroupTarget[];
  } = {},
): Promise<{
  totalChecked: number;
  totalUpdated: number;
  totalInserted: number;
  errors: number;
}> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🌐 Facebook Feed-Based Safe Re-Parser (GraphQL + Stealth)');
  console.log('═══════════════════════════════════════════════════════════════');

  const container = containerInstance ?? createContainer();
  runMigrations(container.db);

  if (!fs.existsSync(FB_SESSION_PATH)) {
    console.error('❌ Cannot run Facebook re-parser without active data/fb_session.json.');
    return { totalChecked: 0, totalUpdated: 0, totalInserted: 0, errors: 1 };
  }

  const isLocal = process.argv.includes('--local');
  const proxyResult = parseProxyConfig(env.FB_PROXY);
  const proxyConfig = isLocal ? undefined : proxyResult?.config;

  if (!proxyConfig && !isLocal) {
    console.warn('⚠️ Running Facebook re-parser WITHOUT FB_PROXY.');
  } else if (isLocal) {
    console.log('🏠 Running locally, bypassing FB_PROXY.');
  }

  let totalChecked = 0;
  let totalUpdated = 0;
  let totalInserted = 0;
  let errors = 0;

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyConfig,
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

  const context = await browser.newContext({
    storageState: FB_SESSION_PATH,
    userAgent: chosenUserAgent,
    viewport: chosenViewport,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  const targets = options.targets ?? shuffleArray(FB_GROUP_TARGETS);
  const maxScrolls = options.maxScrollsPerGroup ?? 14;

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      console.log(`\n📂 [${i + 1}/${targets.length}] Scanning group feed: ${target.name} (${target.url})`);

      const page = await context.newPage();
      await attachTrafficGuard(page);

      const interceptedPosts: ParsedFbGraphQLPost[] = [];
      const seenPostIds = new Set<string>();

      page.on('response', async (resp) => {
        const url = resp.url();
        if (!url.includes('/api/graphql')) return;

        try {
          const bodyText = await resp.text();
          const lines = bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            try {
              const cleanLine = line.replace(/^for\s*\(\s*;\s*;\s*\);/, '');
              const json = JSON.parse(cleanLine);
              const posts = extractPostsFromFbGraphQL(json, target.url);
              for (const post of posts) {
                const key = post.id || post.postUrl || post.text.slice(0, 40);
                if (seenPostIds.has(key)) continue;
                seenPostIds.add(key);
                interceptedPosts.push(post);
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      });

      try {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleepRandom(3000, 5000);

        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
          throw new FacebookSessionExpiredError(`Redirected to login/checkpoint URL: ${currentUrl}`);
        }

        const closeButtons = page.locator(
          'div[role="dialog"] div[role="button"][aria-label="Close"], [aria-label="Decline optional cookies"], [data-testid="cookie-policy-manage-dialog-accept-button"]',
        );
        if ((await closeButtons.count()) > 0) {
          await closeButtons.first().click().catch(() => {});
          await sleepRandom(1000, 2000);
        }

        for (let scroll = 0; scroll < maxScrolls; scroll++) {
          await simulateHumanMouseMove(page);
          await simulateHumanScroll(page);
          await sleepRandom(2500, 4500);

          if (Math.random() < 0.1) {
            await sleepRandom(5000, 8000);
          }
        }

        console.log(`  📊 Intercepted ${interceptedPosts.length} posts from GraphQL during feed scroll.`);

        for (const post of interceptedPosts) {
          totalChecked++;
          const cleanedUrl = cleanFacebookUrl(post.postUrl);
          const idMatch = (post.postUrl || '').match(/(?:posts|permalink)\/(\d+)/);
          const numericId = idMatch ? idMatch[1] : null;

          let existingRow: Property | undefined = undefined;
          if (numericId) {
            existingRow = container.propertiesRepo.findByPostId(numericId);
          }
          if (!existingRow && cleanedUrl) {
            existingRow = container.propertiesRepo.findBySourceUrl(cleanedUrl);
          }

          if (existingRow) {
            const currentDesc = existingRow.description || '';
            const newText = (post.text || '').trim();
            const wasTruncated =
              currentDesc.includes('... See more') ||
              currentDesc.includes('... See More') ||
              currentDesc.includes('... Ещё') ||
              currentDesc.endsWith('…') ||
              currentDesc.length < 60;
            const isLonger = newText.length > currentDesc.length;

            let existingPhotos: string[] = Array.isArray(existingRow.photos) ? existingRow.photos : [];
            const combinedPhotos = Array.from(new Set([...existingPhotos, ...post.photos]));
            const hasMorePhotos = combinedPhotos.length > existingPhotos.length;

            if ((isLonger || wasTruncated || hasMorePhotos) && newText.length > 30) {
              const bestDesc = (isLonger || wasTruncated) ? newText : currentDesc;
              container.db
                .prepare(
                  `UPDATE properties
                   SET description = ?, photos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                   WHERE id = ?`,
                )
                .run(bestDesc, JSON.stringify(combinedPhotos), existingRow.id);

              totalUpdated++;
              console.log(
                `  ✨ [Re-parsed #${existingRow.id}] Recovered ${bestDesc.length} chars (was ${currentDesc.length}) & ${combinedPhotos.length} photos`,
              );
            }
          } else if (post.text && post.text.length > 50) {
            try {
              const rawListing = await parseFacebookPostText(
                post.text,
                target,
                cleanedUrl || `https://facebook.com/groups/post-${Date.now()}`,
                post.photos,
                post.rawDate,
              );
              if (rawListing) {
                const ingestRes = await container.ingestionService.ingestRawListing(rawListing);
                if (ingestRes.status === 'inserted') {
                  totalInserted++;
                  console.log(`  ➕ [New Ingest #${ingestRes.propertyId}] "${(rawListing.title ?? '').slice(0, 40)}"`);
                }
              }
            } catch {
              // ignore ingest errors
            }
          }
        }
      } catch (err: unknown) {
        errors++;
        if (err instanceof FacebookSessionExpiredError) {
          throw err;
        }
        console.error(`💥 Error in group [${target.name}]:`, err instanceof Error ? err.message : String(err));
      } finally {
        await page.close().catch(() => {});
      }

      if (i < targets.length - 1) {
        const pauseMs = Math.floor(Math.random() * 20000) + 20000;
        console.log(`⏳ Cooldown: waiting ${Math.round(pauseMs / 1000)}s before next group feed...`);
        await sleepRandom(pauseMs, pauseMs + 1000);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 Facebook Feed Re-parser Summary:');
  console.log(`   Checked from Feed : ${totalChecked}`);
  console.log(`   ✨ Updated in DB  : ${totalUpdated}`);
  console.log(`   ➕ Inserted New   : ${totalInserted}`);
  console.log(`   ❌ Errors         : ${errors}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  return { totalChecked, totalUpdated, totalInserted, errors };
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

export async function runFacebookScraper(
  containerInstance?: AppContainer,
  options: {
    targets?: FBGroupTarget[];
    maxScrollsPerGroup?: number;
  } = {},
): Promise<{
  totalScraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
  wireBytesTransferred: number;
}> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🤖 Facebook Groups Real Estate Scraper — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');

  const container = containerInstance ?? createContainer();
  runMigrations(container.db);

  // Check if session file exists
  if (!fs.existsSync(FB_SESSION_PATH)) {
    console.warn(`\n⚠️  Facebook session not found at: ${FB_SESSION_PATH}`);
    console.warn('👉 Use /auth_fb in Telegram or run "npm run fb:login".\n');
    const authKb = new InlineKeyboard().text('🔑 Log in to Facebook', 'admin:auth:fb');
    await container.notifierService.notifyAdmins(
      '⚠️ <b>Facebook session not found.</b>\nClick the button below to open an interactive authorization window via residential proxy.',
      authKb,
    );
    return { totalScraped: 0, inserted: 0, duplicates: 0, errors: 1, wireBytesTransferred: 0 };
  }

  // Check proxy requirement (mandatory to prevent IP bans)
  const isLocal = process.argv.includes('--local');
  const proxyResult = parseProxyConfig(env.FB_PROXY);
  const proxyConfig = isLocal ? undefined : proxyResult?.config;

  if (!proxyConfig && !isLocal) {
    console.warn('⚠️ Running FB scraper WITHOUT PROXY.');
  }

  let totalScraped = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let totalWireBytes = 0;
  let context: BrowserContext | null = null;

  try {
    if (proxyConfig) console.log(`🌐 Proxy enabled: ${proxyResult?.masked}`);

    const chosenViewport = VIEWPORT_PRESETS[Math.floor(Math.random() * VIEWPORT_PRESETS.length)]!;
    const chosenUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;

    // 🛡️ CONSERVATION: Use persistent context with disk cache to prevent re-downloading static JS bundles
    if (!fs.existsSync(BROWSER_CACHE_DIR)) {
      fs.mkdirSync(BROWSER_CACHE_DIR, { recursive: true });
    }

    console.log(`💾 Launching persistent browser context with disk cache: ${BROWSER_CACHE_DIR}`);
    context = await chromium.launchPersistentContext(BROWSER_CACHE_DIR, {
      headless: true,
      proxy: proxyConfig,
      userAgent: chosenUserAgent,
      viewport: chosenViewport,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
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
        `--disk-cache-dir=${path.join(BROWSER_CACHE_DIR, 'http_cache')}`,
      ],
    });

    // Populate saved session cookies if available
    if (fs.existsSync(FB_SESSION_PATH)) {
      try {
        const sessionData = JSON.parse(fs.readFileSync(FB_SESSION_PATH, 'utf-8'));
        if (Array.isArray(sessionData.cookies) && sessionData.cookies.length > 0) {
          await context.addCookies(sessionData.cookies);
        }
      } catch (cookieErr) {
        console.warn('⚠️ Could not load session cookies into persistent context:', cookieErr);
      }
    }

    // Determine targets: custom targets (if specified) or round-robin batch
    let targets: FBGroupTarget[];
    if (options.targets && options.targets.length > 0) {
      targets = options.targets;
      console.log(`📋 [Custom Targets] Scanning ${targets.length} specified groups.`);
    } else {
      const { batch, nextCursor } = getNextGroupBatch(FB_GROUP_TARGETS, env.FB_GROUPS_PER_CYCLE);
      targets = batch;
      console.log(
        `🔄 [Round-Robin] Selected batch of ${targets.length} groups (next cursor: ${nextCursor}/${FB_GROUP_TARGETS.length}).`,
      );
    }

    const maxScrolls = options.maxScrollsPerGroup ?? env.FB_MAX_SCROLLS_PER_GROUP ?? 1;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;

      try {
        const groupResult = await scrapeFacebookGroup(context, target, 10, container, maxScrolls);
        const listings = groupResult.listings;
        totalWireBytes += groupResult.wireBytes;
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
        if (err instanceof ProxyConnectionError || isProxyError(err)) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`💥 Facebook proxy failure: ${errMsg}`);
          console.error('📢 Sending high-priority alert to administrators...');
          await container.notifierService.notifyAdmins(
            `🚨 <b>Facebook Scraper Aborted: Proxy Failure</b>\n\n` +
              `Proxy tunnel failed to connect or disconnected:\n<code>${errMsg}</code>\n\n` +
              `Scraper halted immediately to prevent unproxied requests and IP blocks. Please check your proxy service.`,
          );
          totalErrors++;
          // Abort all remaining groups immediately to prevent further failures or unproxied leaks
          break;
        } else if (err instanceof FacebookSessionExpiredError) {
          await container.alertService.critical('<b>Facebook Checkpoint!</b> Scraper halted. Manual authorization required via /auth_fb');
          const authKb = new InlineKeyboard().text('🔑 Log in to Facebook', 'admin:auth:fb');
          await container.notifierService.notifyAdmins(
            '⚠️ <b>Facebook session expired or blocked.</b>\nClick the button below to open an interactive authorization window via residential proxy.',
            authKb,
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
    if (err instanceof ProxyConnectionError || isProxyError(err)) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`💥 Fatal Facebook proxy failure: ${errMsg}`);
      await container.notifierService.notifyAdmins(
        `🚨 <b>Facebook Scraper Aborted: Proxy Failure</b>\n\n` +
          `Failed to initialize browser or establish proxy tunnel:\n<code>${errMsg}</code>`,
      );
    } else {
      console.error('💥 Fatal Facebook scraper error:', err instanceof Error ? err.message : String(err));
    }
    totalErrors++;
  } finally {
    if (context) await context.close().catch(() => {});
    await container.notifierService.flushNotificationQueue().catch((err) => console.error('[Notifier] Flush error:', err));
  }

  const totalMb = (totalWireBytes / 1024 / 1024).toFixed(2);
  const totalKb = Math.round(totalWireBytes / 1024);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 Facebook Scraper Summary:');
  console.log(`   Total Scraped      : ${totalScraped}`);
  console.log(`   ✅ Inserted        : ${totalInserted}`);
  console.log(`   🔁 Duplicates      : ${totalDuplicates}`);
  console.log(`   ❌ Errors          : ${totalErrors}`);
  console.log(`   🌐 Proxy Wire Data : ${totalMb} MB (${totalKb} KB)`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  return {
    totalScraped,
    inserted: totalInserted,
    duplicates: totalDuplicates,
    errors: totalErrors,
    wireBytesTransferred: totalWireBytes,
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