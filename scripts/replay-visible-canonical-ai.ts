/**
 * Repeat Gemini extraction for exactly the currently public Siem Reap rental cohort.
 * Default: zero network calls and zero writes. --run makes only external AI calls,
 * recording resumable source-hashed previews; it never changes the live database.
 * Examples:
 *   npx ts-node scripts/replay-visible-canonical-ai.ts
 *   npx ts-node scripts/replay-visible-canonical-ai.ts --run --limit=5
 *   npx ts-node scripts/replay-visible-canonical-ai.ts --run
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GeminiProvider } from '../src/modules/ai/gemini.provider';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { validateCanonicalListingBatch } from '../src/modules/parser/canonical-listing-extractor';
import { LISTING_EXTRACTION_PROMPT, geographyStatus, sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { isExcessiveKhmer, prepareLlmInput } from '../src/modules/parser/extractor';

const arg = (name: string): string | undefined => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const run = process.argv.includes('--run');
const limit = Number(arg('limit') ?? 100000);
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid --limit');
const MODEL = 'gemini-3.5-flash-lite';
const OUTPUT = resolve(arg('output') ?? 'reports/homeasy-visible-canonical-ai-replay-20261023.jsonl');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type PlatformMeta = Record<string, string | number | boolean | null>;
type Row = {
  id: number; source_item_id: number; source_type: string; raw_text: string; raw_payload_json: string | null;
  public_ref: string; title: string; description: string; price: number | null; currency: string | null;
  bedrooms: number | null; bathrooms: number | null; listing_facts_json: string | null;
};
type Replay = {
  id: number; sourceItemId: number; sourceSha256: string; source: string; model: string; timestamp: string;
  typedValid: boolean; error?: string; inputTokens?: number; outputTokens?: number;
  before?: Record<string, unknown>; after?: Record<string, unknown>; reviewReasons?: string[]; attempts?: number;
};
function jsonObject(text: string | null): Record<string, unknown> {
  try {
    const p: unknown = JSON.parse(text ?? '{}');
    return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
  } catch { return {}; }
}
function optionalValue(obj: Record<string, unknown>, keys: string[]): string | number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}
function platformMetadata(row: Row): PlatformMeta | undefined {
  if (row.source_type !== 'KHMER24') return undefined;
  const raw = jsonObject(row.raw_payload_json);
  const listing = raw.listing && typeof raw.listing === 'object' && !Array.isArray(raw.listing)
    ? raw.listing as Record<string, unknown> : raw;
  // Historical payloads contain both original page fields and already-enriched
  // fields. Only source-labelled values are safe to send as secondary evidence.
  const mapping: Record<string, string[]> = {
    asking_price: ['source_price', 'asking_price'],
    asking_currency: ['source_price_currency', 'asking_currency'],
    asking_price_origin: ['source_price_origin', 'asking_price_origin'],
    platform_location: ['raw_location', 'source_location'],
    platform_category: ['source_category'],
    platform_bedrooms: ['source_bedrooms'],
    platform_bathrooms: ['source_bathrooms'],
  };
  const metadata: PlatformMeta = {};
  for (const [to, keys] of Object.entries(mapping)) {
    const value = optionalValue(listing, keys) ?? optionalValue(raw, keys);
    if (value !== null) metadata[to] = value;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}
function comparison(row: Row) {
  return {
    title: row.title, description: row.description, priceUsdCents: row.price, currency: row.currency,
    bedrooms: row.bedrooms, bathrooms: row.bathrooms,
    facts: jsonObject(row.listing_facts_json),
  };
}
function reviewReasons(row: Row, facts: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (facts.is_supported_listing !== true || geographyStatus(facts.city as string | null) === 'out_of_area') reasons.push('support_or_city_uncertain');
  if (!facts.title_en || !facts.description_en || isExcessiveKhmer(facts.description_en as string)) reasons.push('editorial_unusable');
  if (facts.price === null || facts.currency === null) reasons.push('rent_unknown');
  if (typeof row.price === 'number' && typeof facts.price === 'number' && facts.currency === 'USD' &&
      Math.abs(row.price - facts.price * 100) > 1) reasons.push('existing_price_differs');
  if (row.bedrooms !== null && facts.bedrooms !== null && row.bedrooms !== facts.bedrooms) reasons.push('existing_bedrooms_differs');
  if (row.bathrooms !== null && facts.bathrooms !== null && row.bathrooms !== facts.bathrooms) reasons.push('existing_bathrooms_differs');
  return reasons;
}
async function main(): Promise<void> {
  const db = new DatabaseSync(resolve('data/homeasy.db'), { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  const ids = new CanonicalListingRepository(db).listPublicListingIds({ city: 'siem_reap', type: 'rent' });
  const fetch = db.prepare(`SELECT l.id,l.public_ref,l.title,l.description,l.price,l.currency,l.bedrooms,l.bathrooms,
    l.listing_facts_json,s.id AS source_item_id,s.source_type,s.raw_text,s.raw_payload_json
    FROM canonical_listings l
    JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
    JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?`);
  const rows = ids.map((id) => fetch.get(id) as Row);
  const bad = rows.filter((row) => !row || !row.raw_text?.trim());
  db.close();
  if (bad.length) throw new Error(`${bad.length} public cards have no current source text`);
  const khmerHint = readFileSync(resolve('src/modules/parser/khmer24.scraper.ts'), 'utf8')
    .match(/const KHMER24_EXTRACTION_HINTS = `([^`]+)`;/)?.[1];
  if (!khmerHint) throw new Error('Missing production Khmer24 source notes');
  const done = new Map<number, Replay>();
  if (existsSync(OUTPUT)) {
    for (const line of readFileSync(OUTPUT, 'utf8').split('\n').filter(Boolean)) {
      const item = JSON.parse(line) as Replay;
      done.set(item.id, item);
    }
  }
  const remaining = rows.filter((row) => {
    const prev = done.get(row.id);
    return !prev || !prev.typedValid || prev.sourceItemId !== row.source_item_id || prev.sourceSha256 !== sha(row.raw_text);
  }).slice(0, limit);
  console.log(JSON.stringify({ phase: run ? 'gemini-replay' : 'preflight', publicTotal: rows.length,
    facebook: rows.filter((r) => r.source_type === 'FACEBOOK_GROUP').length,
    khmer24: rows.filter((r) => r.source_type === 'KHMER24').length,
    sourceMaxChars: Math.max(...rows.map((r) => r.raw_text.length)),
    alreadyValid: rows.filter((row) => {
      const p = done.get(row.id);
      return p?.typedValid && p.sourceItemId === row.source_item_id && p.sourceSha256 === sha(row.raw_text);
    }).length, scheduled: remaining.length, output: OUTPUT }));
  if (!run) return;
  const provider = new GeminiProvider();
  if (!provider.isAvailable()) throw new Error('Gemini key is unavailable; zero outbound calls');
  mkdirSync(dirname(OUTPUT), { recursive: true });
  if (!existsSync(OUTPUT)) writeFileSync(OUTPUT, '', { mode: 0o600 });
  chmodSync(OUTPUT, 0o600);
  let completed = 0;
  let valid = 0;
  let consecutiveProviderFailures = 0;
  for (const row of remaining) {
    const source = prepareLlmInput(row.raw_text);
    const meta = platformMetadata(row);
    const input = JSON.stringify([{ id: String(row.id), text: source, ...(meta ? { platform_metadata: meta } : {}) }]);
    const prompt = row.source_type === 'KHMER24'
      ? `${LISTING_EXTRACTION_PROMPT}\n\nSOURCE-SPECIFIC NOTES:\n${khmerHint}` : LISTING_EXTRACTION_PROMPT;
    const record: Replay = {
      id: row.id, sourceItemId: row.source_item_id, sourceSha256: sha(row.raw_text),
      source: row.source_type, model: MODEL, timestamp: new Date().toISOString(), typedValid: false,
      before: comparison(row),
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      record.attempts = attempt;
      try {
      const { data, metric } = await provider.generateJson<{ items: Array<{ id: string; result: unknown }> }>({
        model: MODEL, systemPrompt: prompt, userPrompt: input, maxOutputTokens: 2048,
      });
      record.inputTokens = metric.inputTokens;
      record.outputTokens = metric.outputTokens;
      const validation = validateCanonicalListingBatch(data, new Map([[String(row.id), source]]),
        new Map(meta ? [[String(row.id), meta]] : []));
      if (validation !== true) throw new Error(`Typed response invalid: ${validation}`);
      const facts = sanitizeListingFacts(data.items[0]?.result, source, meta);
      if (!facts) throw new Error('Sanitizer returned null');
      record.typedValid = true;
      // Private preview contains normalized facts. Contacts are source-derived;
      // rehydrate them from the exact hashed source only during verified apply.
      record.after = Object.fromEntries(Object.entries(facts)
        .filter(([k]) => !['phone_numbers','maps_urls','telegram_links'].includes(k)));
      record.reviewReasons = reviewReasons(row, facts as unknown as Record<string, unknown>);
      valid++;
      consecutiveProviderFailures = 0;
      record.error = undefined;
      break;
      } catch (error) {
        record.error = (error instanceof Error ? error.message : String(error)).slice(0, 220);
        // Retry malformed JSON / genuinely invalid schemas once, using the same
        // evidence. Quota/network failures stop normally; no unbounded loop.
        if (attempt === 1 && /JSON parse error|Typed response invalid/i.test(record.error)) continue;
        if (/^Gemini:|^GEMINI_API_KEY/i.test(record.error)) consecutiveProviderFailures++;
      }
    }
    appendFileSync(OUTPUT, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    completed++;
    console.log(JSON.stringify({ completed, total: remaining.length, id: row.id,
      valid: record.typedValid, reviewReasons: record.reviewReasons ?? [], error: record.error ?? null }));
    if (record.error && /quota|resource_exhausted|requests.per.day|RPD/i.test(record.error)) break;
    if (consecutiveProviderFailures >= 3) {
      console.error('Stopped after three consecutive Gemini provider failures; replay is resumable');
      break;
    }
    if (completed < remaining.length) await new Promise((r) => setTimeout(r, 4400));
  }
  console.log(JSON.stringify({ attempted: completed, typedValid: valid, output: OUTPUT }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
