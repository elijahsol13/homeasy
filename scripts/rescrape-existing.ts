/**
 * Rescrape Existing Listings — backfill prices, raw_text, and corrected fields
 * for already-stored ads by re-fetching their original source URLs through the
 * CURRENT extraction pipeline (new price/map/commerce logic included).
 *
 * Re-ingested records merge into the existing row via the source_url check —
 * no duplicates are created.
 *
 * Usage:
 *   npx tsx scripts/rescrape-existing.ts [--source=khmer24|facebook|all] [--limit=N] [--no-llm]
 *
 * Notes:
 *  - Khmer24 needs no proxy. Facebook anonymous fetches may hit login walls
 *    depending on egress IP — failures are logged, never fatal.
 *  - Photos are NOT downloaded (URLs only) — image/media/font requests are
 *    blocked by the traffic guard.
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { scrapeListingDetail, enrichListingsWithLLM, K24_SESSION_PATH, type ScrapeTarget } from '../src/modules/parser/khmer24.scraper';
import { fetchPostTextAnonymous } from '../src/modules/parser/fb-worker';
import { parseFacebookPostText, type FBGroupTarget } from '../src/modules/parser/facebook.scraper';
import type { RawListing } from '../src/modules/parser/schemas';
import type { CityKey, PropertyCategory } from '../src/config/settings';

chromium.use(stealthPlugin());

interface Args {
  source: 'khmer24' | 'facebook' | 'all';
  limit: number;
  useLlm: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const source = (args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'all') as Args['source'];
  const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '200', 10);
  const useLlm = !args.includes('--no-llm');
  return { source, limit, useLlm };
}

async function setupTrafficGuard(page: import('playwright').Page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url().toLowerCase();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    if (
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('doubleclick') ||
      url.includes('onesignal')
    ) {
      return route.abort();
    }
    return route.continue();
  });
}

async function rescrapeKhmer24(container: ReturnType<typeof createContainer>, limit: number, useLlm: boolean) {
  const rows = container.db
    .prepare(
      `SELECT id, original_url, city, type, category FROM properties
       WHERE is_active = 1 AND original_url LIKE '%khmer24.com%'
       ORDER BY id ASC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ id: number; original_url: string; city: CityKey; type: string; category: string | null }>;

  console.log(`\n🔄 Rescraping ${rows.length} Khmer24 listings...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...(fs.existsSync(K24_SESSION_PATH) ? { storageState: K24_SESSION_PATH } : {}),
  });

  let ok = 0;
  let failed = 0;
  const scraped: RawListing[] = [];

  for (const row of rows) {
    const target: ScrapeTarget = {
      name: `rescan-${row.id}`,
      category: (row.category ?? 'house') as PropertyCategory,
      city: row.city,
      type: row.type === 'sale' ? 'sale' : 'rent',
      categorySlug: '',
      locationSlug: '',
    };
    try {
      const listing = await scrapeListingDetail(ctx, target, row.original_url);
      if (listing) {
        scraped.push(listing);
        ok++;
      } else {
        failed++;
        console.warn(`  ⚠️  #${row.id} returned null — page may be dead`);
      }
    } catch (err) {
      failed++;
      console.warn(`  ❌ #${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await browser.close().catch(() => {});

  const enriched = useLlm ? await enrichListingsWithLLM(scraped) : scraped;

  let merged = 0;
  for (const listing of enriched) {
    try {
      const res = await container.ingestionService.ingestRawListing(listing);
      if (res.status === 'duplicate') merged++;
    } catch (err) {
      console.warn(`  ❌ Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`✅ Khmer24 rescrape done: ${ok} fetched, ${failed} failed, ${merged} merged into existing rows.`);
}

async function rescrapeFacebook(container: ReturnType<typeof createContainer>, limit: number) {
  const rows = container.db
    .prepare(
      `SELECT id, original_url, city, category FROM properties
       WHERE is_active = 1 AND original_url LIKE '%facebook.com%'
       ORDER BY id ASC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ id: number; original_url: string; city: CityKey; category: string | null }>;

  console.log(`\n🔄 Rescraping ${rows.length} Facebook listings...`);

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const post = await fetchPostTextAnonymous(row.original_url);
      if (!post) {
        failed++;
        console.warn(`  ⚠️  #${row.id} — post fetch failed (login wall / dead)`);
        continue;
      }
      const target: FBGroupTarget = {
        name: 'rescrape',
        url: '',
        city: row.city,
        defaultCategory: (row.category ?? 'house') as PropertyCategory,
      };
      const listing = await parseFacebookPostText(post.text, target, post.postUrl, post.photos, undefined, undefined, post.commerce);
      if (listing) {
        const res = await container.ingestionService.ingestRawListing(listing);
        if (res.status !== 'error') ok++;
      }
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      failed++;
      console.warn(`  ❌ #${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`✅ Facebook rescrape done: ${ok} merged, ${failed} failed.`);
}

async function main() {
  const { source, limit, useLlm } = parseArgs();
  const container = createContainer();
  runMigrations(container.db);

  if (source === 'khmer24' || source === 'all') {
    await rescrapeKhmer24(container, limit, useLlm);
  }
  if (source === 'facebook' || source === 'all') {
    await rescrapeFacebook(container, limit);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('💥 Fatal:', err);
    process.exit(1);
  });
