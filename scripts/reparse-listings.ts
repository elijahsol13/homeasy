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
  extractElectricity,
  extractWater,
  extractPropertyType,
} from '../src/modules/parser/extractor';
import { extractCleaning, extractRestrictions } from '../src/services/notifier';
import { findLandmarksInText } from '../src/config/landmarks';
import { CANONICAL_AMENITIES } from '../src/config/amenities';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parseProxyConfig } from '../src/modules/parser/proxy';
import { env } from '../src/config/env';

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

  // Abort heavy unnecessary trackers and video
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const u = route.request().url().toLowerCase();
    if (['font', 'media'].includes(type) || u.includes('google-analytics') || u.includes('doubleclick')) {
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
        } else if (combinedPhotos.length > existingPhotos.length) {
          db.prepare(
            `UPDATE properties SET photos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
          ).run(JSON.stringify(combinedPhotos), row.id);
          console.log(`   📸 Updated ${combinedPhotos.length} photos`);
        } else {
          console.log(`   ⏭️  Listing unchanged or redirected.`);
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

// ─── Step 2: Facebook Safe Gentle Re-parser ──────────────────────────────────

async function reparseFacebook(db: any, limit?: number): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🌐 Facebook Safe Gentle Re-Parser (GraphQL + Stealth)');
  console.log('═══════════════════════════════════════════════════════════════');

  const proxyResult = parseProxyConfig(env.FB_PROXY);
  if (!proxyResult) {
    console.error('❌ Cannot run Facebook re-parser without FB_PROXY.');
    return;
  }

  if (!fs.existsSync(FB_SESSION_PATH)) {
    console.error('❌ Cannot run Facebook re-parser without active data/fb_session.json.');
    return;
  }

  const query = `
    SELECT id, source_url, original_url, title, description, photos
    FROM properties
    WHERE source_url LIKE '%facebook%'
    ORDER BY id DESC
  `;
  const rows = db.prepare(query).all() as any[];
  console.log(`📦 Found ${rows.length} total Facebook listings in database.`);

  const targets = limit ? rows.slice(0, limit) : rows;
  console.log(`🎯 Processing ${targets.length} listings safely...\n`);

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyResult.config,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    storageState: FB_SESSION_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  let count = 0;
  for (const row of targets) {
    count++;
    const targetUrl = row.original_url || row.source_url;
    console.log(`\n[${count}/${targets.length}] #${row.id}: ${row.title.slice(0, 35)}...`);

    let fullTextFromGraphQL: string | null = null;
    const interceptedPhotos: string[] = [];

    // Intercept Relay Comet GraphQL responses for this post
    const responseHandler = async (res: any) => {
      if (res.url().includes('/api/graphql/')) {
        try {
          const text = await res.text();
          // Extract message text from Relay node
          const matches = text.match(/"text":"((?:\\"|[^"])+)"/g);
          if (matches) {
            for (const m of matches) {
              const unescaped = JSON.parse(`{${m}}`).text;
              if (unescaped.length > 50 && (!fullTextFromGraphQL || unescaped.length > fullTextFromGraphQL.length)) {
                fullTextFromGraphQL = unescaped;
              }
            }
          }
          // Extract all high-res photos
          const photoMatches = text.match(/https:\/\/[^"'\\]+fbcdn\.net[^"'\\]+/g);
          if (photoMatches) {
            for (const p of photoMatches) {
              const clean = p.replace(/\\\//g, '/');
              if (!clean.includes('emoji') && !clean.includes('profile') && !interceptedPhotos.includes(clean)) {
                interceptedPhotos.push(clean);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    };

    page.on('response', responseHandler);

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await sleep(4000);

      // Try expanding "See more" / "Ещё" if present in DOM
      try {
        const seeMore = page.locator('div[role="button"]:has-text("Ещё"), div[role="button"]:has-text("See more")').first();
        if ((await seeMore.count()) > 0) {
          await seeMore.click().catch(() => {});
          await sleep(1500);
        }
      } catch {
        // ignore
      }

      // Check for security checkpoint
      const currentUrl = page.url();
      if (currentUrl.includes('checkpoint') || currentUrl.includes('login')) {
        console.error('🚨 Facebook checkpoint encountered! Stopping Facebook re-parser to protect account.');
        break;
      }

      // Fallback: extract from DOM if GraphQL interception didn't catch larger string
      const domText = await page.evaluate(() => {
        const messageEl = document.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [dir="auto"]');
        return messageEl ? (messageEl as HTMLElement).innerText.trim() : '';
      });

      const bestText = (fullTextFromGraphQL && fullTextFromGraphQL.length > domText.length) ? fullTextFromGraphQL : domText;

      let existingPhotos: string[] = [];
      try {
        existingPhotos = JSON.parse(row.photos || '[]');
      } catch {
        existingPhotos = [];
      }
      const combinedPhotos = Array.from(new Set([...existingPhotos, ...interceptedPhotos]));

      if (bestText && bestText.length > row.description.length && !bestText.endsWith('... Ещё')) {
        db.prepare(
          `UPDATE properties SET description = ?, photos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
        ).run(bestText, JSON.stringify(combinedPhotos), row.id);
        console.log(`   🎉 Recovered full description (${bestText.length} chars) & ${combinedPhotos.length} total photos!`);
      } else {
        console.log(`   ℹ️  No larger text extracted (current len: ${row.description.length}).`);
      }
    } catch (err) {
      console.warn(`   ⚠️ Error visiting Facebook post:`, err instanceof Error ? err.message : String(err));
    } finally {
      page.off('response', responseHandler);
    }

    // Cooldown pause: 3 minutes every 10 posts
    if (count % 10 === 0 && count < targets.length) {
      console.log('☕ [Safety Cooldown] Pausing for 3 minutes to preserve Facebook account reputation...');
      await sleep(180000);
    } else {
      // 30–60 second jitter between individual posts
      const jitter = Math.floor(Math.random() * 30000) + 30000;
      console.log(`⏳ Waiting ${Math.round(jitter / 1000)}s before next post...`);
      await sleep(jitter);
    }
  }

  await browser.close();
  console.log('✅ Facebook gentle re-parsing step finished.\n');
}

const DISCOVERED_REPORT_PATH = path.join(process.cwd(), 'data', 'discovered_features_report.json');

const COMPREHENSIVE_AGGREGATOR_INSTRUCTION = `You are a world-class real estate and hotel intelligence extraction engine (operating at the level of Airbnb Plus, Booking.com, and Zillow).
Translate all Khmer and foreign text to English.
Analyze the listing text with extreme attention to detail. Extract standard property data AND actively discover all amenities, repeating features, and lease conditions.

Return a JSON object matching this schema:
{
  "is_real_estate": boolean,
  "title": string,
  "price": number | null,
  "currency": "USD" | "KHR",
  "category": "apartment" | "house" | "room" | "hotel" | "land",
  "property_type": "Flat House" | "Private Villa" | "Private House" | "Condo" | "Apartment" | "Hotel Room" | "Room" | null,
  "bedrooms": number | null,
  "bathrooms": number | null,
  "deposit_months": number | null,
  "min_lease_months": number | null,
  "has_pool": boolean,
  "electricity": "Included" | "EDC (State Rate) ~$0.20/kWh" | string | null,
  "water": "Included" | "State Rate (~1000៛/m³)" | string | null,
  "cleaning": "1x/week Free" | "2x/week Included" | string | null,
  "pet_friendly": boolean | null,
  "restrictions": string[],
  "landmarks": string[],
  "location": string | null,
  "description_en": string,
  "discovered_amenities": string[]
}

GUIDELINES FOR discovered_amenities:
Inspect for and extract ALL features mentioned in the text. Normalize them to clean English names, such as:
- Utilities & Building: "Backup Generator", "Elevator", "24/7 Security Guard", "CCTV", "Gated Community (Borey)", "Free WiFi", "Free Garbage Collection", "Keycard Access"
- Comfort & Appliances: "Washing Machine", "Clothes Dryer", "Hot Water Heater", "Bathtub", "Western Kitchen", "Gas Stove", "Oven", "Microwave", "Refrigerator", "Smart TV", "Air Conditioning", "Ceiling Fan", "Work Desk"
- Outdoor & Views: "Balcony", "Private Terrace", "Rooftop Access", "Garden", "River View", "Pool View", "City View", "BBQ Area"
- Parking: "Car Parking", "Motorbike Parking", "Bicycle Parking"
- Services & Terms: "Cleaning Service", "Bed Linen Change", "Drinking Water Provided", "Foreigner Friendly", "Digital Nomad Friendly"
Do NOT invent features not mentioned in the text.`;

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

  const BATCH_SIZE = 6;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const batchInput = chunk.map((r) => ({
      id: r.id,
      text: `${r.title}\n\n${r.description || ''}`.trim(),
    }));

    console.log(`🚀 [Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)}] Processing listings: ${chunk.map((c) => `#${c.id}`).join(', ')}...`);

    const startTime = Date.now();
    const batchResults = await extractListingsBatchWithLLM(batchInput, COMPREHENSIVE_AGGREGATOR_INSTRUCTION);
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

      const finalLandmarks = (aiResult?.landmarks && aiResult.landmarks.length > 0)
        ? aiResult.landmarks
        : regexLandmarks.map((l) => l.canonicalName);
      if (finalLandmarks.length > 0) {
        patch.landmarks = JSON.stringify(finalLandmarks);
        if (!row.primary_landmark) patch.primary_landmark = finalLandmarks[0];
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

      // Update Database
      const fields = Object.keys(patch);
      if (fields.length > 0) {
        const setClause = fields.map((f) => `${f} = ?`).join(', ');
        const values = fields.map((f) => patch[f]);
        db.prepare(
          `UPDATE properties SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
        ).run(...values, row.id);
        console.log(`   ✨ #${row.id}: updated ${fields.join(', ')}`);
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

  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

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

