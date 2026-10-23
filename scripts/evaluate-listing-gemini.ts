/** Read-only Gemini benchmark against the Stage 4 SHA-verified source sample.
 * Usage: npx ts-node scripts/evaluate-listing-gemini.ts           (local preflight)
 *        npx ts-node scripts/evaluate-listing-gemini.ts --send-to-gemini
 * The explicit network mode sends original advertisement text (potential contacts)
 * to Google Gemini. Obtain appropriate runtime authorization before using it.
 * Single provider/model, repeatable requests per item, no ingestion or DB writes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GeminiProvider } from '../src/modules/ai/gemini.provider';
import { validateCanonicalListingBatch } from '../src/modules/parser/canonical-listing-extractor';
import { LISTING_EXTRACTION_PROMPT, sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { prepareLlmInput } from '../src/modules/parser/extractor';

const MODEL = 'gemini-3.5-flash-lite';
const IDS = [9, 20, 110, 339, 70, 155, 2067, 5714];
const arg = (name: string): string | undefined => process.argv.find((v) => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const OUTPUT = resolve(arg('output') ?? 'reports/homeasy-ai-extraction-stage6-repeatability-20261023.json');
const repeats = Number(arg('repeats') ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be between 1 and 10');
const requestedIds = arg('ids') ? arg('ids')!.split(',').map(Number) : IDS;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const REDACT = (s: string): string => s
  .replace(/(?:\+?855[\s.-]?|\b0)\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g, '[phone]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
  .replace(/(?:https?:\/\/|www\.)\S+/gi, '[link]')
  .replace(/\b(?:t\.me|wa\.me|fb\.me|facebook\.com)\/\S+/gi, '[contact]')
  .replace(/@[A-Za-z][A-Za-z0-9_]{2,}/g, '[handle]');

interface Gold { id: number; source: 'Facebook' | 'Khmer24'; sourceSha256: string;
  bedrooms: number | null; bathrooms: number | null; monthlyRentUsd?: number }

/** Exact agreement describes repeatability, not truth. Null gold counts are not annotated facts. */
function benchmarkMetrics(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const successful = rows.filter((r) => r.typedValidation === true).length;
  let correctGold = 0;
  let checkedGold = 0;
  const byId = new Map<number, Array<Record<string, unknown>>>();
  const fields = ['price', 'currency', 'property_type', 'bedrooms', 'bathrooms', 'min_lease_months',
    'deposit_amount', 'deposit_months', 'electricity_type', 'electricity_rate', 'water_type',
    'water_rate', 'discovered_amenities'];
  for (const row of rows) {
    const series = byId.get(Number(row.id)) ?? [];
    series.push(row);
    byId.set(Number(row.id), series);
    const g = row.gold as { bedrooms: number | null; bathrooms: number | null; monthlyRentUsd: number | null };
    const facts = row.sanitized as Record<string, unknown> | null;
    if (!facts || !g) continue;
    for (const [field, expected] of [['bedrooms', g.bedrooms], ['bathrooms', g.bathrooms], ['price', g.monthlyRentUsd]] as const) {
      if (expected === null) continue; // null gold = unverified, NOT ground-truth absence
      checkedGold++;
      if (facts[field] === expected) correctGold++;
    }
  }
  let pairs = 0;
  let agreeingFields = 0;
  let checkedFields = 0;
  let identicalDescriptions = 0;
  for (const series of byId.values()) {
    for (let a = 0; a < series.length; a++) for (let b = a + 1; b < series.length; b++) {
      const x = series[a]!.sanitized as Record<string, unknown> | null;
      const y = series[b]!.sanitized as Record<string, unknown> | null;
      if (!x || !y) continue;
      pairs++;
      if (x.description_en === y.description_en) identicalDescriptions++;
      for (const field of fields) {
        checkedFields++;
        if (JSON.stringify(x[field]) === JSON.stringify(y[field])) agreeingFields++;
      }
    }
  }
  const rate = (n: number, d: number) => d ? Number((100 * n / d).toFixed(1)) : null;
  return {
    attempts: rows.length, typedValid: successful, typedValidPct: rate(successful, rows.length),
    annotatedGoldFactsCorrect: correctGold, annotatedGoldFactsChecked: checkedGold,
    annotatedGoldAccuracyPct: rate(correctGold, checkedGold),
    repeatedListingPairs: pairs, exactFieldAgreements: agreeingFields, exactFieldComparisons: checkedFields,
    exactFieldAgreementPct: rate(agreeingFields, checkedFields),
    identicalDescriptions, identicalDescriptionsPct: rate(identicalDescriptions, pairs),
    note: 'Gold null is unverified. Repeat agreement is not factual accuracy; qualitative editorial checks still needed.',
  };
}

async function main(): Promise<void> {
  const provider = new GeminiProvider();
  if (!provider.isAvailable()) throw new Error('Gemini key unavailable; no requests sent');
  const goldFile: { pairs: Gold[] } = JSON.parse(
    readFileSync(resolve('reports/homeasy-ai-extraction-stage4-gold-20261023.json'), 'utf8'),
  );
  const gold = goldFile.pairs;
  const lookup = new Map(gold.map((g) => [g.id, g]));
  const chosenIds = requestedIds;
  if (!chosenIds.length || chosenIds.some((v) => !Number.isInteger(v) || !lookup.has(v)) ||
      new Set(chosenIds).size !== chosenIds.length) {
    throw new Error('ids must be distinct listing IDs in the manually reviewed Stage 4 gold set');
  }
  // Read the exact Khmer24 source-specific hint used in normal ingestion.
  const scraperSource = readFileSync(resolve('src/modules/parser/khmer24.scraper.ts'), 'utf8');
  const sourceNotes = scraperSource.match(/const KHMER24_EXTRACTION_HINTS = `([^`]+)`;/)?.[1];
  if (!sourceNotes) throw new Error('Could not locate production Khmer24 source notes');

  const db = new DatabaseSync(resolve('data/homeasy.db'), { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  const query = db.prepare(`SELECT s.source_type, s.raw_text
    FROM canonical_listings l
    JOIN canonical_listing_source_occurrences o ON o.id = l.primary_source_occurrence_id
    JOIN source_items s ON s.id = o.source_item_id WHERE l.id = ?`);
  const samples = chosenIds.map((id) => {
    const g = lookup.get(id);
    if (!g) throw new Error(`Unreviewed ID ${id}`);
    const row = query.get(id) as { source_type: string; raw_text: string } | undefined;
    if (!row || row.source_type !== (g.source === 'Facebook' ? 'FACEBOOK_GROUP' : 'KHMER24')) {
      throw new Error(`Missing/mismatched source ${id}`);
    }
    if (sha(row.raw_text) !== g.sourceSha256) {
      throw new Error(`SHA mismatch for saved raw source ${id}`);
    }
    return { ...g, text: prepareLlmInput(row.raw_text), originalLength: row.raw_text.length };
  });
  db.close();

  if (!process.argv.includes('--send-to-gemini')) {
    console.log(JSON.stringify({ mode: 'preflight-only', model: MODEL, networkRequests: 0, repeats,
      plannedRequests: samples.length * repeats, promptSha256: sha(LISTING_EXTRACTION_PROMPT),
      sourceHashesVerified: samples.length,
      items: samples.map((s) => ({ id: s.id, source: s.source, rawChars: s.originalLength })),
      note: 'External execution must be separately permitted by the runtime; input may contain contacts.' }, null, 2));
    return;
  }

  const results: Array<Record<string, unknown>> = [];
  outer: for (const sample of samples) {
    const prompt = sample.source === 'Khmer24'
      ? `${LISTING_EXTRACTION_PROMPT}\n\nSOURCE-SPECIFIC NOTES:\n${sourceNotes}`
      : LISTING_EXTRACTION_PROMPT;
    const userPrompt = JSON.stringify([{ id: String(sample.id), text: sample.text }]);
    for (let run = 1; run <= repeats; run++) try {
      const { data, metric } = await provider.generateJson<{ items: Array<{ id: string; result: unknown }> }>({
        model: MODEL, systemPrompt: prompt, userPrompt, maxOutputTokens: 2048,
      });
      const validated = validateCanonicalListingBatch(data, new Map([[String(sample.id), sample.text]]));
      const raw = data?.items?.find((item) => item.id === String(sample.id))?.result;
      const sanitized = raw ? sanitizeListingFacts(raw, sample.text) : null;
      const facts = raw as Record<string, unknown> | undefined;
      const summary = (values: Record<string, unknown> | null | undefined) => values && ({
        title_en: REDACT(String(values.title_en ?? '')),
        description_en: REDACT(String(values.description_en ?? '')),
        is_supported_listing: values.is_supported_listing ?? null,
        rejection_reason: values.rejection_reason ?? null,
        property_type: values.property_type ?? null,
        category: values.category ?? null,
        bedrooms: values.bedrooms ?? null,
        bathrooms: values.bathrooms ?? null,
        price: values.price ?? null,
        currency: values.currency ?? null,
        city: values.city ?? null,
        sangkat: values.sangkat ?? null,
        explicit_location: values.explicit_location ?? null,
        min_lease_months: values.min_lease_months ?? null,
        deposit_amount: values.deposit_amount ?? null,
        deposit_months: values.deposit_months ?? null,
        electricity_type: values.electricity_type ?? null,
        electricity_rate: values.electricity_rate ?? null,
        water_type: values.water_type ?? null,
        water_rate: values.water_rate ?? null,
        restrictions: values.restrictions ?? [],
        discovered_amenities: values.discovered_amenities ?? [],
      });
      results.push({ id: sample.id, run, source: sample.source, sha256: sample.sourceSha256,
        promptSha256: sha(prompt),
        rawChars: sample.originalLength, model: metric.model, inputTokens: metric.inputTokens,
        outputTokens: metric.outputTokens, latencyMs: metric.latencyMs,
        typedValidation: validated, gold: { bedrooms: sample.bedrooms,
          bathrooms: sample.bathrooms, monthlyRentUsd: sample.monthlyRentUsd ?? null },
        rawModel: summary(facts), sanitized: summary(sanitized as unknown as Record<string, unknown>),
      });
      console.log(JSON.stringify({ id: sample.id, run, source: sample.source, valid: validated === true,
        model: metric.model, inputTokens: metric.inputTokens, outputTokens: metric.outputTokens }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ id: sample.id, run, source: sample.source, sha256: sample.sourceSha256,
        rawChars: sample.originalLength, error: REDACT(message) });
      console.warn(JSON.stringify({ id: sample.id, error: REDACT(message).slice(0, 220) }));
      // Invalid/unavailable model or blocked network is systemic; avoid repeating calls.
      if (/404|not found|not supported|403|permission|fetch failed|ENOTFOUND|ECONN/i.test(message)) break outer;
    }
  }
  const metrics = benchmarkMetrics(results);
  writeFileSync(OUTPUT, JSON.stringify({ model: MODEL, repeats, selectedIds: chosenIds,
    note: 'Raw listing text and contacts omitted; no Khmer24 platform forms passed because historical payload provenance is uncertain.', metrics, results },
    (_key, value: unknown) => typeof value === 'string' ? REDACT(value) : value, 2) + '\n');
  console.log(JSON.stringify({ output: OUTPUT, metrics }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
