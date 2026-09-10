/**
 * HomEasy — Gemini Model Availability Auditor
 *
 * Google renames/retires Gemini model IDs frequently (several times a year).
 * The extraction cascade (`GEMINI_MODEL_CASCADE` in src/modules/parser/extractor.ts)
 * and the NL search fallback list (`fallbackModels` in src/services/nl-search.service.ts)
 * are both hardcoded lists that silently rot over time — a model that's shut down
 * just wastes a cascade slot (extra latency) until it falls through to a working one.
 *
 * Run this periodically (or whenever extraction quality seems to degrade) to see
 * exactly which model IDs configured in this codebase are actually still callable
 * with the GEMINI_API_KEY configured in .env, and which ones are dead.
 *
 * Usage: npm run gemini:audit
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { env } from '../src/config/env';
import { GEMINI_MODEL_CASCADE } from '../src/modules/parser/extractor';

async function main() {
  if (!env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set in .env — cannot query the Gemini API.');
    process.exit(1);
  }

  const genAI = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  console.log('🔍 Fetching live model catalog from Google Gemini API...\n');

  const liveModels = new Set<string>();
  const pager = await genAI.models.list({ config: { pageSize: 200 } });
  for await (const m of pager) {
    // API returns names like "models/gemini-2.5-flash" — strip the prefix.
    const id = (m.name ?? '').replace(/^models\//, '');
    if (id && (m.supportedActions?.includes('generateContent') ?? true)) {
      liveModels.add(id);
    }
  }

  console.log(`✅ Google reports ${liveModels.size} models supporting generateContent on this API key.\n`);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📋 Checking codebase-configured cascade against the live catalog:');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let deadCount = 0;
  for (const modelName of GEMINI_MODEL_CASCADE) {
    const isLive = liveModels.has(modelName);
    console.log(`  ${isLive ? '✅ LIVE' : '❌ DEAD/UNKNOWN'}  ${modelName}`);
    if (!isLive) deadCount++;
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (deadCount === 0) {
    console.log('✅ All configured models are live. No action needed.');
  } else {
    console.log(
      `⚠️  ${deadCount} of ${GEMINI_MODEL_CASCADE.length} configured model(s) are NOT in the live catalog.`,
    );
    console.log('   Remove or replace them in GEMINI_MODEL_CASCADE (src/modules/parser/extractor.ts)');
    console.log('   and in the fallbackModels list (src/services/nl-search.service.ts).');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('📚 Full live catalog (for reference when picking replacements):');
  Array.from(liveModels).sort().forEach((m) => console.log(`   - ${m}`));
}

main().catch((err) => {
  console.error('💥 Failed to audit Gemini models:', err instanceof Error ? err.message : err);
  process.exit(1);
});
