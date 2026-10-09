/**
 * HomEasy Listings Safe Re-Parser
 *
 * Capabilities:
 *  1. Gentle, stealthy Facebook re-parser (30-60s jitter + 3m cooldown per 10 items) via FB_PROXY + fb_session.json.
 *  2. Khmer24 detail re-parser (fetching full descriptions and 100% of photo URLs).
 *  3. Canonical `--ai` re-parse: re-extracts ListingFacts from stored text via
 *     `reparseCanonicalListings` (preview by default, `--apply` to write).
 *
 * The legacy Gemini two-stage enrichment pipeline (classification prompt +
 * rental-extraction prompt + checkpoint/eval-log machinery) was moved to
 * `scripts/reparse-legacy-enrichment.ts` on 2026-10-06. It is dead code kept
 * for reference only — it deactivates listings and writes `type='sale'`,
 * and must not be wired back in.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createContainer } from '../src/container';
import { reparseFacebookViaGroupFeed } from '../src/modules/parser/facebook.scraper';
import { attachTrafficGuard } from '../src/modules/parser/traffic-guard';
import { reparseCanonicalListings } from '../src/modules/parser/canonical-reparse';

chromium.use(stealthPlugin());

const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Step 1: Khmer24 Re-parser ───────────────────────────────────────────────

async function reparseKhmer24(db: any, limit?: number): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🇰🇭 Khmer24 Safe Re-Parser');
  console.log('═══════════════════════════════════════════════════════════════');

  const query = `
    SELECT id, source_url, original_url, title, description, photos
    FROM properties
    WHERE source_url LIKE '%khmer24%'
    ORDER BY id DESC
  `;
  const rows = db.prepare(query).all() as any[];
  console.log(`📦 Found ${rows.length} Khmer24 listings in database.`);

  const targets = limit ? rows.slice(0, limit) : rows;
  console.log(`🎯 Processing ${targets.length} listings...\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(K24_SESSION_PATH) ? K24_SESSION_PATH : undefined,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await attachTrafficGuard(page);

  let count = 0;
  for (const row of targets) {
    count++;
    const targetUrl = row.original_url || row.source_url;
    console.log(`[${count}/${targets.length}] #${row.id}: ${row.title.slice(0, 35)}...`);

    try {
      const res = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (res && res.status() === 200) {
        const pageData = await page.evaluate(() => {
          const descEl =
            document.querySelector('.post-description') ||
            document.querySelector('.post-content') ||
            document.querySelector('[itemprop="description"]') ||
            document.querySelector('.item-description');

          // Extract ALL photos without limits
          const allImgs: string[] = [];
          const imgs = document.querySelectorAll('img');
          imgs.forEach((img) => {
            const src = img.getAttribute('data-src') || img.getAttribute('src') || '';
            if (src.includes('images.khmer24.co') || src.includes('img.khmer24.com')) {
              // High-res version (-b.jpg)
              const clean = src.replace(/-[a-z]\.jpg/i, '-b.jpg');
              if (!allImgs.includes(clean)) {
                allImgs.push(clean);
              }
            }
          });

          return {
            description: descEl ? (descEl as HTMLElement).innerText.trim() : '',
            photos: allImgs,
          };
        });

        const newDesc = pageData.description;
        let existingPhotos: string[] = [];
        try {
          existingPhotos = JSON.parse(row.photos || '[]');
        } catch {
          existingPhotos = [];
        }

        // Merge photos (preserving all unique URLs)
        const combinedPhotos = Array.from(new Set([...existingPhotos, ...pageData.photos]));

        if (newDesc && newDesc.length > (row.description || '').length) {
          db.prepare(
            `UPDATE properties SET description = ?, photos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
          ).run(newDesc, JSON.stringify(combinedPhotos), row.id);
          console.log(`   ✅ Updated description (${newDesc.length} chars) & ${combinedPhotos.length} photos`);
        } else {
          if (newDesc !== row.description) {
             console.log(`   ℹ️  newDesc length: ${newDesc.length}, old: ${(row.description || '').length}`);
          }
          if (combinedPhotos.length > existingPhotos.length) {
            db.prepare(
              `UPDATE properties SET photos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
            ).run(JSON.stringify(combinedPhotos), row.id);
            console.log(`   📸 Updated ${combinedPhotos.length} photos`);
          } else {
            console.log(`   ⏭️  Listing unchanged or redirected.`);
          }
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Error visiting ${targetUrl}:`, err instanceof Error ? err.message : String(err));
    }

    // Respectful 3-6 second jitter between Khmer24 pages
    const delay = Math.floor(Math.random() * 3000) + 3000;
    await sleep(delay);
  }

  await browser.close();
  console.log('✅ Khmer24 re-parsing step finished.\n');
}

// ─── Step 2: Facebook Safe Gentle Re-parser (Feed-Based GraphQL) ────────────

async function reparseFacebook(db: any, _limit?: number): Promise<void> {
  const container = createContainer({ db });
  await reparseFacebookViaGroupFeed(container);
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doK24 = args.includes('--khmer24') || args.includes('--all');
  const doFB = args.includes('--fb') || args.includes('--all');
  const doAI = args.includes('--ai') || args.includes('--enrich-ai') || args.includes('--all');

  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

  const db = createDatabase();
  if (args.includes('--apply') || doK24 || doFB) runMigrations(db);

  try {
    if (doK24) {
      await reparseKhmer24(db, limit);
    }
    if (doFB) {
      await reparseFacebook(db, limit);
    }
    if (doAI || (!doK24 && !doFB)) {
      const apply = args.includes('--apply');
      const outcome = await reparseCanonicalListings(db, { limit, apply });
      console.log(`Canonical reparse ${apply ? 'applied' : 'preview only'}: ${JSON.stringify(outcome)}`);
    }
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('💥 Fatal error during re-parsing pipeline:', err);
    process.exit(1);
  });
}
