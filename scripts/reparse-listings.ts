/**
 * HomEasy Listings Safe Re-Parser & Gemini AI Enrichment Pipeline
 *
 * Capabilities:
 *  1. Gentle, stealthy Facebook re-parser (30-60s jitter + 3m cooldown per 10 items) via FB_PROXY + fb_session.json.
 *  2. Khmer24 detail re-parser (fetching full descriptions and 100% of photo URLs).
 *  3. Gemini 2.5 Flash batch extractor (paced at 5-8 items/batch with 4s cooldown to respect 15 RPM).
 *  4. Evaluator dataset generator: outputs `data/ai_extraction_eval.json` (Regex vs AI side-by-side)
 *     to discover missing patterns and continuously improve the heuristic regex engine.
 *  5. Resumable checkpointing: saves state to `data/reparse_checkpoint.json`.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import {
  extractListingsBatchWithLLM,
  classifyListingsBatchWithLLM,
  extractElectricity,
  extractWater,
  extractPropertyType,
  type ClassifiedListing,
} from '../src/modules/parser/extractor';
import { extractCleaning, extractRestrictions } from '../src/services/notifier';
import { findLandmarksInText } from '../src/config/landmarks';
import { CANONICAL_AMENITIES } from '../src/config/amenities';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parseProxyConfig } from '../src/modules/parser/proxy';
import { env } from '../src/config/env';
import { createContainer } from '../src/container';
import { reparseFacebookViaGroupFeed } from '../src/modules/parser/facebook.scraper';
import { attachTrafficGuard } from '../src/modules/parser/traffic-guard';

chromium.use(stealthPlugin());

const CHECKPOINT_PATH = path.join(process.cwd(), 'data', 'reparse_checkpoint.json');
const EVAL_LOG_PATH = path.join(process.cwd(), 'data', 'ai_extraction_eval.json');
const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');
const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');

interface CheckpointState {
  processedIds: number[];
  lastRunAt: string;
  totalEnriched: number;
}

function loadCheckpoint(): CheckpointState {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    } catch {
      // fallback
    }
  }
  return { processedIds: [], lastRunAt: new Date().toISOString(), totalEnriched: 0 };
}

function saveCheckpoint(state: CheckpointState): void {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function appendEvalLog(entry: Record<string, unknown>): void {
  let existing: unknown[] = [];
  if (fs.existsSync(EVAL_LOG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(EVAL_LOG_PATH, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  existing.push(entry);
  fs.writeFileSync(EVAL_LOG_PATH, JSON.stringify(existing, null, 2), 'utf8');
}

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

  const isLocal = process.argv.includes('--local');
  const proxyConfig = (!isLocal && process.env.PROXY_URL) ? { server: process.env.PROXY_URL } : undefined;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    proxy: proxyConfig,
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(K24_SESSION_PATH) ? K24_SESSION_PATH : undefined,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Abort heavy unnecessary assets: images, styles, fonts, trackers, and video
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const u = route.request().url().toLowerCase();
    if (['image', 'font', 'media', 'stylesheet', 'other'].includes(type) || u.includes('google-analytics') || u.includes('doubleclick')) {
      return route.abort();
    }
    return route.continue();
  });

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

const RENTAL_EXTRACTION_INSTRUCTIONS = `
You are a rental data normalizer for a Cambodia real-estate platform.
You receive ONLY posts that have already been classified as valid long-term RESIDENTIAL MONTHLY RENTALS.
Your job is to extract a structured JSON object for each post and normalize the title and description into one clean English style.

CRITICAL RULE: The output MUST be 100% in English. TRANSLATE all Khmer and local names. DO NOT use original local names.

Input format:
[
  {"id": 1, "text": "..."},
  {"id": 2, "text": "..."}
]

Output format (MUST be a JSON array, same order, same ids):
[
  {"id": 1, "result": { <schema below> }},
  {"id": 2, "result": { <schema below> }}
]

Schema for each "result":
{
  "is_real_estate": true,
  "title_en": "string",
  "description_en": "string",
  "price": number | null,
  "currency": "USD" | "KHR",
  "category": "apartment" | "house" | "room" | "hotel" | null,
  "property_type": "Condo" | "Apartment" | "Studio" | "Room" | "Private Villa" | "Private House" | "Flat House" | "Hotel Room" | null,
  "bedrooms": number | null,
  "bathrooms": number | null,
  "deposit": number | null,
  "min_lease": number | null,
  "has_pool": boolean,
  "location": string | null,
  "landmarks": string[],
  "marketing_landmarks": string[],
  "maps_url": string | null,
  "phone_numbers": string[],
  "electricity": string | null,
  "water": string | null,
  "cleaning": string | null,
  "restrictions": string[],
  "pet_friendly": boolean | null,
  "discovered_amenities": string[]
}

STRICT RULES:

1. is_real_estate: always true for these posts. If you realize the post is actually not a rental, set false and put all other fields to null.

2. title_en:
   - Generate a clean, professional English marketing title.
   - Format: "{bedrooms}BR {Property Type} in {Sangkat}"
   - Max 6 words.
   - Do NOT copy the original text.
   - Translate all Khmer location names to English.
   - Examples: "2BR Apartment in BKK1", "1BR Studio in Svay Dangkum", "4BR Private Villa in Chreav", "1BR Room in Phsar Nge".
   - If bedrooms unknown, omit the number: "Studio in BKK1" or "Private Villa in Chreav".

3. description_en:
   - 1-3 short bullet points in English.
   - Do NOT repeat the price, title, or location word-for-word.
   - Focus on core details, included services, and top amenities.

4. price:
   - The MONTHLY rent in USD (or KHR if explicitly in riel).
   - The visible "list price" on Facebook/Khmer24 is often fake clickbait. ALWAYS prefer the real monthly rent written in the description.
   - If text says "$350/month", "350$ per month", "monthly 350$", return 350.
   - If text has a large total number like "$250,000" and no monthly mention, set is_real_estate: false.
   - If price not found, return null.

5. currency: "USD" if price is in dollars; "KHR" if explicitly in riel (៛/riel).

6. category: "apartment" for apartments/condos; "house" for houses/villas; "room" for single rooms; "hotel" only for long-term monthly hotel rooms.

7. property_type:
   - "Condo", "Apartment", "Studio", "Room", "Private Villa", "Private House", "Flat House" (shophouse used as residence), "Hotel Room".

8. min_lease: 1 for monthly/short term, 6 for "6 months", "long term", 12 for "1 year" or "12 months".

9. deposit: number of months ("1 month deposit" → 1). "deposit $500" is not months; return null.

10. location: ACTUAL sangkat/district from the allowed list. NEVER use relative phrases like "5 mins to Pub Street". Put those in marketing_landmarks. If not found, null.

11. landmarks: real named places (e.g. "Wat Bo", "AEON Mall 2"). marketing_landmarks: promotional distance markers (e.g. "5 min to Pub Street").

12. maps_url: Google Maps links (goo.gl, google.com/maps, maps.app.goo.gl) or null.

13. phone_numbers: strip non-numeric except leading '+'. Example: ["+85577448002", "089899084"].

14. electricity: "Included" if free; "EDC (State Rate) ~$0.20/kWh" for state/gov/EDC; "Fixed Rate ($X/kWh)" or "Fixed Rate (XR/kWh)" if a rate is given; otherwise null.

15. water: "Included" if free; "State Rate (~1000៛/m³)" for state water; "Fixed ($X/person)" if per person; otherwise null.

16. cleaning: frequency if included (e.g. "1 time/week"); otherwise null.

17. restrictions: array (e.g. ["No Pets", "No Smoking"]).

18. pet_friendly: true/false/null.

19. discovered_amenities: distinct amenities like AC, Fridge, Washing Machine, WiFi, Secure Parking, Balcony, Gym, Elevator, Swimming Pool, Fully Furnished, Free WiFi.

Examples:

Input:  {"id": 20, "text": "2 bedroom apartment for rent in BKK1 $450/month 1 month deposit fully furnished"}
Output:
{
  "id": 20,
  "result": {
    "is_real_estate": true,
    "title_en": "2BR Apartment in BKK1",
    "description_en": "• Spacious 2-bedroom apartment, fully furnished\\n• 1-month deposit, flexible monthly lease\\n• Close to BKK1 cafes, supermarkets and transport",
    "price": 450,
    "currency": "USD",
    "category": "apartment",
    "property_type": "Apartment",
    "bedrooms": 2,
    "bathrooms": null,
    "deposit": 1,
    "min_lease": 1,
    "has_pool": false,
    "location": "Boeng Keng Kang",
    "landmarks": [],
    "marketing_landmarks": [],
    "maps_url": null,
    "phone_numbers": [],
    "electricity": null,
    "water": null,
    "cleaning": null,
    "restrictions": [],
    "pet_friendly": null,
    "discovered_amenities": ["Fully Furnished"]
  }
}

Input:  {"id": 21, "text": "បន្ទប់ជាន់ក្រោម ម៉ាស៊ីនត្រជាក់ 90$/ខែ , នៅជិតផ្សារញ៉ែ ផ្សារហ៊ុយលេង"}
Output:
{
  "id": 21,
  "result": {
    "is_real_estate": true,
    "title_en": "1BR Room Near Phsar Nge",
    "description_en": "• Ground-floor room with air conditioning\\n• Monthly rent with nearby markets and eateries\\n• Convenient location close to Phsar Nge and Phsar Huy Ling",
    "price": 90,
    "currency": "USD",
    "category": "room",
    "property_type": "Room",
    "bedrooms": 1,
    "bathrooms": null,
    "deposit": null,
    "min_lease": 1,
    "has_pool": false,
    "location": "Sangkat Siem Reap",
    "landmarks": ["Phsar Nge", "Phsar Huy Ling"],
    "marketing_landmarks": ["near Phsar Nge", "near Phsar Huy Ling"],
    "maps_url": null,
    "phone_numbers": [],
    "electricity": null,
    "water": null,
    "cleaning": null,
    "restrictions": [],
    "pet_friendly": null,
    "discovered_amenities": ["AC"]
  }
}

Input:  {"id": 22, "text": "បន្ទប់ជួល | មានបន្ទប់ទំនេរ1 ចូលនៅបានភ្លាមៗ | ១ បន្ទប់ តម្លៃ $100/ខែ | បង់មុន ១ ខែ និងកក់ ១ ខែ | ទីតាំំា៖ ជាប់ផ្សារផល្លារាត្រីអង្គរ ខាងលិចផាប់ស្ត្រីត ប្រហែល 400 ម៉ែត្រ | បរិក្ខារមាន៖ ម៉ាស៊ីនត្រជាក់ កង្ហារ គ្រែ ពូក ភួយ ខ្នើយ | Free WiFi"}
Output:
{
  "id": 22,
  "result": {
    "is_real_estate": true,
    "title_en": "1BR Room in Siem Reap",
    "description_en": "• Air-conditioned room available for immediate move-in\\n• Monthly rent includes free WiFi, bed and pillows\\n• Located near Phalla Ratri Angkor and Pub Street, ~400m away",
    "price": 100,
    "currency": "USD",
    "category": "room",
    "property_type": "Room",
    "bedrooms": 1,
    "bathrooms": null,
    "deposit": 1,
    "min_lease": 1,
    "has_pool": false,
    "location": "Sangkat Siem Reap",
    "landmarks": ["Phalla Ratri Angkor"],
    "marketing_landmarks": ["~400m from Pub Street"],
    "maps_url": null,
    "phone_numbers": [],
    "electricity": null,
    "water": null,
    "cleaning": null,
    "restrictions": [],
    "pet_friendly": null,
    "discovered_amenities": ["AC", "Fan", "Free WiFi", "Bed"]
  }
}
`.trim();

const DISCOVERED_REPORT_PATH = path.join(process.cwd(), 'data', 'discovered_features_report.json');

// Two-stage prompts for the reparser. The live scrapers still use extractor.ts's combined
// SYSTEM_INSTRUCTIONS; the reparse pipeline first classifies, then extracts rentals only.

const CLASSIFICATION_INSTRUCTIONS = `
You are a rental-intent classifier for a Cambodia real-estate platform.
Your ONLY job is to read a batch of posts and classify each one as a valid long-term RESIDENTIAL MONTHLY RENTAL or not.

Input format:
[
  {"id": 1, "text": "..."},
  {"id": 2, "text": "..."}
]

Output format (MUST be a JSON array, same order, same ids):
[
  {"id": 1, "class": "rental", "reason": "monthly rent, 2BR apartment"},
  {"id": 2, "class": "sale", "reason": "urgent sale $250,000"}
]

Allowed classes:
- "rental"     — a residential property offered for MONTHLY rent (apartment, condo, house, villa, room, studio, flat house). Min 1 month.
- "sale"       — any property listed for sale, resale, "urgent sale", "for sale", "selling", land sale, condo resale.
- "commercial" — shop, office, warehouse, restaurant, business shophouse, guesthouse as business.
- "daily"      — daily/nightly/short-stay/Airbnb rates, per-night pricing.
- "not_property" — cars, clothes, phones, jobs, visas, services, food, general spam.
- "unclear"    — not enough information to decide (e.g. generic agency ad without a specific unit).

Classification rules:
1. The platform is for RESIDENTIAL monthly rentals. Anything else is "not rental".
2. Khmer signals: ជួល = RENT, លក់ = SALE. These are very strong.
3. If a post contains BOTH "for rent" and "for sale" prominently, choose the STRONGER signal:
   - explicit "$X/month" or "monthly" or "ជួល" → "rental"
   - explicit "for sale", "selling", "sale price", "$250,000" → "sale"
4. Numbers above $10,000 with no "month" or "/month" are almost always "sale".
5. Land = "sale" unless it explicitly says "land for rent monthly".
6. "Hotel" is "daily" unless it explicitly offers long-term monthly rent to residents.
7. "Shophouse" used for living: if text is about living, "rental"; if about business: "commercial".
8. Generic agency ads like "we have many rooms from $50 to $500" are "unclear".

Examples:
Input:  {"id": 10, "text": "2 bedroom apartment for rent in BKK1 $450/month fully furnished"}
Output: {"id": 10, "class": "rental", "reason": "monthly rent, 2BR apartment, $450/month"}

Input:  {"id": 11, "text": "UK618 2bedroom for sale urgent! I wanna sell my condo 40m2."}
Output: {"id": 11, "class": "sale", "reason": "explicit 'for sale' and 'sell my condo'"}

Input:  {"id": 12, "text": "Shophouse for rent near Russian market, $1,200/month, can open restaurant"}
Output: {"id": 12, "class": "commercial", "reason": "shophouse for business/restaurant"}

Input:  {"id": 13, "text": "Nice studio only $25/night, available daily in city center"}
Output: {"id": 13, "class": "daily", "reason": "per-night pricing, short stay"}

Input:  {"id": 14, "text": "🏡 ដីលក់នៅតាកែវ បន្ទាន់ តម្លៃល្អ សម្រាប់ទិញទុក ឬសាងសង់ផ្ទះ 65000$"}
Output: {"id": 14, "class": "sale", "reason": "លក់ = sale, land $65,000"}

Input:  {"id": 15, "text": "🏘 ផ្ទះអាជីវកម្ម លើផ្លូវជាតិលេខ1 ជិតធនាគារABA ត្រូវការលក់បន្ទាន់ខ្លាំង"}
Output: {"id": 15, "class": "commercial", "reason": "business shophouse for sale (ផ្ទះអាជីវកម្ម + លក់)"}

Input:  {"id": 16, "text": "បន្ទប់ជាន់ក្រោម ម៉ាស៊ីនត្រជាក់ 90$/ខែ , នៅជិតផ្សារញ៉ែ"}
Output: {"id": 16, "class": "rental", "reason": "ខែ = month, 90$/month, room for rent (ជួល)"}
`.trim();
export const FEATURE_PROPOSAL_THRESHOLD_PERCENT = 2.0; // 2.0% of total active database

function updateDiscoveredReport(featuresTally: Record<string, number>, totalAnalyzed: number): void {
  const safeTotal = Math.max(1, totalAnalyzed);
  const canonicalNames = new Set(
    CANONICAL_AMENITIES.flatMap((a) => [
      a.id.toLowerCase(),
      a.nameEn.toLowerCase(),
      a.nameKh.toLowerCase(),
      a.nameRu.toLowerCase(),
      // Common aliases
      a.nameEn.toLowerCase().replace(/ \/ .*/, ''),
    ]),
  );

  const ranking = Object.entries(featuresTally)
    .sort((a, b) => b[1] - a[1])
    .map(([feature, count]) => {
      const pct = (count / safeTotal) * 100;
      const isCanonical = canonicalNames.has(feature.toLowerCase()) ||
        CANONICAL_AMENITIES.some((a) => feature.toLowerCase().includes(a.id.toLowerCase()) || a.nameEn.toLowerCase().includes(feature.toLowerCase()));
      return {
        feature,
        count,
        percentage: `${pct.toFixed(1)}%`,
        percentageNum: pct,
        isCanonical,
      };
    });

  // Automatically filter proposals that exceed threshold percentage and are not yet canonical
  const proposedNewAmenities = ranking
    .filter((r) => !r.isCanonical && r.percentageNum >= FEATURE_PROPOSAL_THRESHOLD_PERCENT)
    .map((r) => ({
      feature: r.feature,
      count: r.count,
      percentage: r.percentage,
      recommendation: `Discovered in ${r.percentage} of listings (>= ${FEATURE_PROPOSAL_THRESHOLD_PERCENT}% threshold). Recommended for canonical catalog.`,
    }));

  const report = {
    totalListingsAnalyzed: totalAnalyzed,
    proposalThresholdPercent: `${FEATURE_PROPOSAL_THRESHOLD_PERCENT}%`,
    generatedAt: new Date().toISOString(),
    uniqueFeaturesCount: ranking.length,
    proposedNewAmenities,
    ranking: ranking.map(({ feature, count, percentage, isCanonical }) => ({
      feature,
      count,
      percentage,
      isCanonical,
    })),
  };

  fs.writeFileSync(DISCOVERED_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  if (proposedNewAmenities.length > 0) {
    console.log(`\n💡 [Feature Discovery] ${proposedNewAmenities.length} new features exceeded ${FEATURE_PROPOSAL_THRESHOLD_PERCENT}% threshold:`);
    for (const prop of proposedNewAmenities) {
      console.log(`   ✨ ${prop.feature} (${prop.percentage}, ${prop.count} listings)`);
    }
  }
}

// ─── Step 3: Full Gemini AI Batch Enrichment & Comparison Log ────────────────

async function runGeminiEnrichment(db: any, limit?: number): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧠 Gemini Aggregator-Grade Intelligence & Feature Discovery');
  console.log('═══════════════════════════════════════════════════════════════');

  const checkpoint = loadCheckpoint();
  console.log(`📋 Checkpoint: ${checkpoint.processedIds.length} listings already processed in previous runs.`);

  // Load existing features tally if exists
  const featuresTally: Record<string, number> = {};
  if (fs.existsSync(DISCOVERED_REPORT_PATH)) {
    try {
      const existingReport = JSON.parse(fs.readFileSync(DISCOVERED_REPORT_PATH, 'utf8'));
      if (Array.isArray(existingReport.ranking)) {
        for (const item of existingReport.ranking) {
          featuresTally[item.feature] = item.count;
        }
      }
    } catch {
      // ignore
    }
  }

  const query = `
    SELECT id, title, description, price, currency, type, category, bedrooms, bathrooms,
           location, city, has_pool, electricity, water, cleaning, restrictions, pet_friendly,
           landmarks, primary_landmark, deposit, min_lease
    FROM properties
    WHERE is_active = 1
    ORDER BY id DESC
  `;
  const allRows = db.prepare(query).all() as any[];

  // Filter out already processed IDs from checkpoint
  const pendingRows = allRows.filter((r) => !checkpoint.processedIds.includes(r.id));
  console.log(`📦 Total active listings: ${allRows.length} (${pendingRows.length} remaining to enrich).`);

  const targets = limit ? pendingRows.slice(0, limit) : pendingRows;
  console.log(`🎯 Enriching batch of ${targets.length} listings with Gemini...\n`);

  // ─── Stage 1: classify every target into rental / not-rental ─────────────────
  const classMap = new Map<number, ClassifiedListing>();
  const CLASS_BATCH_SIZE = 6;
  for (let ci = 0; ci < targets.length; ci += CLASS_BATCH_SIZE) {
    const cChunk = targets.slice(ci, ci + CLASS_BATCH_SIZE);
    const cInput = cChunk.map((r) => ({
      id: r.id,
      text: `${r.title}\n\n${r.description || ''}`.trim(),
    }));
    console.log(`🔎 [Classify ${Math.floor(ci / CLASS_BATCH_SIZE) + 1}/${Math.ceil(targets.length / CLASS_BATCH_SIZE)}] ${cChunk.map((c) => `#${c.id}`).join(', ')}...`);
    const cResults = await classifyListingsBatchWithLLM(cInput, CLASSIFICATION_INSTRUCTIONS);
    for (const row of cChunk) {
      const cls = cResults.get(row.id) ?? { class: 'unclear', reason: 'missing' };
      classMap.set(row.id, cls);
    }
    await sleep(1000); // light pause between classification batches
  }

  const rentalRows: any[] = [];
  for (const row of targets) {
    const cls = classMap.get(row.id) ?? { class: 'unclear', reason: 'missing' };
    const fullText = `${row.title}\n\n${row.description || ''}`.trim();

    if (cls.class === 'rental') {
      rentalRows.push(row);
    } else {
      // Log and, if it is clearly non-rental, deactivate
      const regexElec = extractElectricity(fullText);
      const regexWater = extractWater(fullText);
      const regexClean = extractCleaning(fullText);
      const regexRestr = extractRestrictions(fullText);
      const regexPropType = extractPropertyType(fullText, row.category);
      const regexLandmarks = findLandmarksInText(fullText, row.city);

      const evalEntry = {
        id: row.id,
        title: row.title,
        text_snippet: fullText.slice(0, 250),
        classification: { class: cls.class, reason: cls.reason },
        regex: {
          electricity: regexElec,
          water: regexWater,
          cleaning: regexClean,
          restrictions: regexRestr,
          property_type: regexPropType,
          landmarks: regexLandmarks.map((l) => l.canonicalName),
        },
        ai: null,
        timestamp: new Date().toISOString(),
      };
      appendEvalLog(evalEntry);

      if (cls.class !== 'unclear' && row.is_active !== 0) {
        try {
          db.prepare(
            `UPDATE properties SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
          ).run(0, row.id);
          console.log(`   🚫 #${row.id}: ${cls.class} — ${cls.reason}`);
        } catch (err: unknown) {
          console.error(`   ❌ #${row.id}: failed to deactivate: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (cls.class === 'unclear') {
        console.log(`   ❓ #${row.id}: unclear — left for manual review`);
      }

      checkpoint.processedIds.push(row.id);
      checkpoint.totalEnriched++;
    }
  }

  console.log(`🎯 ${rentalRows.length} of ${targets.length} listings are rentals; extracting details...\n`);

  // Persist the classification progress before extraction, so the run is resumable
  // even if there are no rental rows in this batch.
  checkpoint.lastRunAt = new Date().toISOString();
  saveCheckpoint(checkpoint);

  const rentalTargets = rentalRows;
  const BATCH_SIZE = 6;
  for (let i = 0; i < rentalTargets.length; i += BATCH_SIZE) {
    const chunk = rentalTargets.slice(i, i + BATCH_SIZE);
    const batchInput = chunk.map((r) => ({
      id: r.id,
      text: `${r.title}\n\n${r.description || ''}`.trim(),
    }));

    console.log(`🚀 [Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rentalTargets.length / BATCH_SIZE)}] Processing rentals: ${chunk.map((c) => `#${c.id}`).join(', ')}...`);

    const startTime = Date.now();
    // Second stage: the posts in this batch are already known to be rentals, so use
    // the strict rental-only extraction prompt to normalize title, description and
    // structured fields without the model trying to classify sale/daily posts.
    const batchResults = await extractListingsBatchWithLLM(batchInput, RENTAL_EXTRACTION_INSTRUCTIONS);
    const duration = Date.now() - startTime;
    console.log(`   ⏱️ Gemini response received in ${(duration / 1000).toFixed(1)}s (extracted ${batchResults.size}/${chunk.length} items)`);

    for (const row of chunk) {
      const fullText = `${row.title}\n\n${row.description || ''}`.trim();
      const aiResult = batchResults.get(row.id);

      // Tabulate discovered amenities
      if (aiResult?.discovered_amenities) {
        for (const amen of aiResult.discovered_amenities) {
          const cleanAmen = amen.trim();
          if (cleanAmen.length > 2) {
            featuresTally[cleanAmen] = (featuresTally[cleanAmen] || 0) + 1;
          }
        }
      }

      // Run Heuristic Regex Extractor for Side-by-Side Comparison
      const regexElec = extractElectricity(fullText);
      const regexWater = extractWater(fullText);
      const regexClean = extractCleaning(fullText);
      const regexRestr = extractRestrictions(fullText);
      const regexPropType = extractPropertyType(fullText, row.category);
      const regexLandmarks = findLandmarksInText(fullText, row.city);

      // Build Evaluation Log Entry
      const evalEntry = {
        id: row.id,
        title: row.title,
        text_snippet: fullText.slice(0, 250),
        regex: {
          electricity: regexElec,
          water: regexWater,
          cleaning: regexClean,
          restrictions: regexRestr,
          property_type: regexPropType,
          landmarks: regexLandmarks.map((l) => l.canonicalName),
        },
        ai: aiResult
          ? {
              is_real_estate: aiResult.is_real_estate,
              title_en: aiResult.title_en,
              description_en: aiResult.description_en,
              price: aiResult.price,
              electricity: aiResult.electricity,
              water: aiResult.water,
              cleaning: aiResult.cleaning,
              restrictions: aiResult.restrictions,
              pet_friendly: aiResult.pet_friendly,
              property_type: aiResult.property_type,
              landmarks: aiResult.landmarks,
              bedrooms: aiResult.bedrooms,
              bathrooms: aiResult.bathrooms,
              deposit: aiResult.deposit,
              min_lease: aiResult.min_lease,
              category: aiResult.category,
              location: aiResult.location,
              discovered_amenities: aiResult.discovered_amenities,
            }
          : null,
        timestamp: new Date().toISOString(),
      };
      appendEvalLog(evalEntry);

      // Merge Best Values (AI priority with regex fallback)
      const patch: Record<string, unknown> = {};

      if (aiResult) {
        if (aiResult.is_real_estate === false) {
          patch.is_active = 0;
          console.log(`   🚫 #${row.id}: Skipped: LLM flagged as non-real-estate / commercial / spam`);
          // If it's not real estate, we don't care about other fields, but we should update the DB.
        } else {
          if (aiResult.title_en && aiResult.title_en !== row.title) {
            patch.title = aiResult.title_en;
          }
          if (aiResult.description_en && aiResult.description_en !== row.description) {
            patch.description = aiResult.description_en;
          }
          
          // `properties.price` is NOT NULL — only touch it when the AI actually
          // returned a usable positive price. If it returned null/0 (couldn't find
          // a price in the text), keep the listing's existing price untouched
          // rather than nulling out a perfectly good value and crashing the run.
          if (aiResult.price && aiResult.price > 0) {
            const newPriceCents = Math.round(aiResult.price * 100);
            if (newPriceCents !== row.price) {
              patch.price = newPriceCents;
            }
          }
        }
      }

      const finalElec = aiResult?.electricity || regexElec;
      if (finalElec && finalElec !== row.electricity) patch.electricity = finalElec;

      const finalWater = aiResult?.water || regexWater;
      if (finalWater && finalWater !== row.water) patch.water = finalWater;

      const finalClean = aiResult?.cleaning || regexClean;
      if (finalClean && finalClean !== row.cleaning) patch.cleaning = finalClean;

      const finalRestr = (aiResult?.restrictions && aiResult.restrictions.length > 0)
        ? aiResult.restrictions
        : regexRestr;
      if (finalRestr.length > 0) patch.restrictions = JSON.stringify(finalRestr);

      const finalPet = aiResult?.pet_friendly !== undefined ? (aiResult.pet_friendly ? 1 : 0) : undefined;
      if (finalPet !== undefined && finalPet !== row.pet_friendly) patch.pet_friendly = finalPet;

      const baseLandmarks = (aiResult?.landmarks && aiResult.landmarks.length > 0)
        ? aiResult.landmarks
        : regexLandmarks.map((l) => l.canonicalName);
      const marketing = aiResult?.marketing_landmarks || [];
      const finalLandmarks = Array.from(new Set([...baseLandmarks, ...marketing]));
      
      if (finalLandmarks.length > 0) {
        patch.landmarks = JSON.stringify(finalLandmarks);
        if (!row.primary_landmark && baseLandmarks.length > 0) {
          patch.primary_landmark = baseLandmarks[0];
        }
      }

      const finalPropType = aiResult?.property_type || regexPropType;
      if (finalPropType && finalPropType !== row.property_type) patch.property_type = finalPropType;

      if (aiResult?.discovered_amenities && aiResult.discovered_amenities.length > 0) {
        patch.amenities = JSON.stringify(aiResult.discovered_amenities);
      }

      if (aiResult?.bedrooms !== null && aiResult?.bedrooms !== undefined && row.bedrooms === null) {
        patch.bedrooms = aiResult.bedrooms;
      }
      if (aiResult?.bathrooms !== null && aiResult?.bathrooms !== undefined && row.bathrooms === null) {
        patch.bathrooms = aiResult.bathrooms;
      }
      if (aiResult?.category && !row.category) {
        patch.category = aiResult.category;
      }
      if (aiResult?.deposit !== null && aiResult?.deposit !== undefined && row.deposit === null) {
        patch.deposit = aiResult.deposit;
      }
      if (aiResult?.min_lease !== null && aiResult?.min_lease !== undefined && row.min_lease === null) {
        patch.min_lease = aiResult.min_lease;
      }

      // Update Database. Wrapped so a constraint violation or bad value on a single
      // row (e.g. an unexpected NULL) doesn't abort the entire run and lose the
      // checkpoint progress for every other row already processed in this batch.
      const fields = Object.keys(patch);
      if (fields.length > 0) {
        try {
          const setClause = fields.map((f) => `${f} = ?`).join(', ');
          const values = fields.map((f) => patch[f]);
          db.prepare(
            `UPDATE properties SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
          ).run(...values, row.id);
          console.log(`   ✨ #${row.id}: updated ${fields.join(', ')}`);
        } catch (err: unknown) {
          console.error(`   ❌ #${row.id}: failed to apply update (${Object.keys(patch).join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      checkpoint.processedIds.push(row.id);
      checkpoint.totalEnriched++;
    }

    // Save checkpoint and update discovered features report after every batch
    checkpoint.lastRunAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
    updateDiscoveredReport(featuresTally, checkpoint.totalEnriched);

    // Rate limit cooldown (4 seconds between Gemini batches)
    await sleep(4000);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`🎉 Gemini Enrichment Complete!`);
  console.log(`📊 Total processed: ${checkpoint.totalEnriched}`);
  console.log(`📝 Evaluation log saved to: ${EVAL_LOG_PATH}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doK24 = args.includes('--khmer24') || args.includes('--all');
  const doFB = args.includes('--fb') || args.includes('--all');
  const doAI = args.includes('--ai') || args.includes('--enrich-ai') || args.includes('--all');
  const reset = args.includes('--reset');

  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

  if (reset) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(CHECKPOINT_PATH)) {
      fs.renameSync(CHECKPOINT_PATH, `${CHECKPOINT_PATH}.${ts}.bak`);
      console.log('🔄 Checkpoint reset (archived)');
    }
    if (fs.existsSync(EVAL_LOG_PATH)) {
      fs.renameSync(EVAL_LOG_PATH, `${EVAL_LOG_PATH}.${ts}.bak`);
      console.log('🔄 Eval log reset (archived)');
    }
  }

  const db = createDatabase();
  runMigrations(db);

  try {
    if (doK24) {
      await reparseKhmer24(db, limit);
    }
    if (doFB) {
      await reparseFacebook(db, limit);
    }
    if (doAI || (!doK24 && !doFB)) {
      await runGeminiEnrichment(db, limit);
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

