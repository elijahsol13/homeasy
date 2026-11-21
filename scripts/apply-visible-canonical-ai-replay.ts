/**
 * Guarded application of validated, SHA-bound Gemini preview records.
 * Dry-run by default. --apply is for a QUIESCED database, after a verified backup
 * and a successful rehearsal against a detached writable copy.
 *
 *   npx ts-node scripts/apply-visible-canonical-ai-replay.ts
 *   npx ts-node scripts/apply-visible-canonical-ai-replay.ts --db=/tmp/snapshot.db --apply --expected-public=203
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { CANONICAL_FACTS_RESPONSE_SCHEMA } from '../src/modules/parser/canonical-listing-extractor';
import { detectContacts, geographyStatus, type ListingFacts } from '../src/modules/parser/listing-extraction';
import { sourceRoomCounts } from '../src/modules/parser/source-room-counts';

const opt = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const dbPath = resolve(opt('db') ?? 'data/homeasy.db');
const inputPath = resolve(opt('input') ?? 'reports/homeasy-visible-canonical-ai-replay-20261023.jsonl');
const isApply = process.argv.includes('--apply');
const expectedPublic = opt('expected-public') === undefined ? null : Number(opt('expected-public'));
if (expectedPublic !== null && (!Number.isSafeInteger(expectedPublic) || expectedPublic < 1)) throw Error('Invalid --expected-public');
if (isApply && expectedPublic === null) throw Error('--apply requires --expected-public from rehearsed preflight');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, unknown>;
type SourceRow = {
  id: number; source_item_id: number; raw_text: string; title: string; description: string;
  price: number | null; currency: string | null; bedrooms: number | null; bathrooms: number | null;
  listing_facts_json: string | null;
};
type Replay = {
  id: number; sourceItemId: number; sourceSha256: string; typedValid: boolean;
  before?: Json; after?: Json; reviewReasons?: string[];
};
type Prepared = { id: number; facts: ListingFacts; row: SourceRow; contacts: ReturnType<typeof detectContacts> };
const factsSchema: z.ZodTypeAny = CANONICAL_FACTS_RESPONSE_SCHEMA;
function jsonObj(s: string | null): Json {
  try { const v: unknown = JSON.parse(s ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}; }
  catch { return {}; }
}
function prior(row: SourceRow): Json {
  return { title: row.title, description: row.description, priceUsdCents: row.price, currency: row.currency,
    bedrooms: row.bedrooms, bathrooms: row.bathrooms, facts: jsonObj(row.listing_facts_json) };
}
function reasonFor(row: SourceRow, p: Replay | undefined): string | null {
  if (!p?.typedValid || !p.after || !p.before) return 'missing_or_invalid';
  if (p.sourceItemId !== row.source_item_id || p.sourceSha256 !== sha(row.raw_text)) return 'source_changed';
  if (JSON.stringify(p.before) !== JSON.stringify(prior(row))) return 'card_changed_since_preview';
  const parsed = factsSchema.safeParse(p.after);
  if (!parsed.success) return `schema_invalid:${parsed.error.issues[0]?.path.join('.')}`;
  const f = parsed.data as ListingFacts;
  if (f.is_supported_listing !== true || geographyStatus(f.city) === 'out_of_area') return 'support_or_city_uncertain';
  if (!f.title_en.trim() || !f.description_en.trim() || f.title_en.length > 180) return 'editorial_unusable';
  if (p.reviewReasons?.some((r) => r === 'editorial_unusable' || r === 'support_or_city_uncertain')) return 'flagged_unsupported';
  const author = sourceRoomCounts(row.raw_text);
  if (author.conflictingBedrooms || author.conflictingBathrooms) {
    // A contradiction should not create a concrete room count.
    if ((author.conflictingBedrooms && f.bedrooms !== null) || (author.conflictingBathrooms && f.bathrooms !== null)) return 'conflicting_source_rooms';
  }
  if ((author.bedrooms !== null && f.bedrooms !== author.bedrooms) ||
    (author.bathrooms !== null && f.bathrooms !== author.bathrooms)) return 'source_room_mismatch';
  if (f.price !== null && (f.currency !== 'USD' && f.currency !== 'KHR')) return 'price_currency_invalid';
  // KHR rent cannot be represented faithfully by the canonical USD-cent column
  // without a verified exchange rate. Do not silently misprice it.
  if (f.currency === 'KHR') return 'unsupported_currency_for_usd_cents';
  return null;
}
function prepare(db: DatabaseSync) {
  const ids = new CanonicalListingRepository(db).listPublicListingIds({city:'siem_reap',type:'rent'});
  if (expectedPublic !== null && ids.length !== expectedPublic) throw Error(`Cohort drift: expected ${expectedPublic}, now ${ids.length}`);
  const q = db.prepare(`SELECT l.id,l.title,l.description,l.price,l.currency,l.bedrooms,l.bathrooms,l.listing_facts_json,
    s.id AS source_item_id,s.raw_text FROM canonical_listings l
    JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
    JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?`);
  const latest = new Map<number, Replay>();
  for (const line of readFileSync(inputPath, 'utf8').trim().split('\n')) {
    const p = JSON.parse(line) as Replay;
    if (!Number.isSafeInteger(p.id)) throw Error('Invalid preview ID');
    latest.set(p.id, p);
  }
  const ready: Prepared[] = [];
  const skipped: Record<string, number[]> = {};
  for (const id of ids) {
    const row = q.get(id) as SourceRow | undefined;
    if (!row?.raw_text) throw Error(`Missing primary source for ${id}`);
    const p = latest.get(id);
    const reason = reasonFor(row, p);
    if (reason) (skipped[reason] ??= []).push(id);
    else ready.push({ id, row, facts: p!.after as unknown as ListingFacts, contacts: detectContacts(row.raw_text) });
  }
  return { ids, ready, skipped };
}
function execute(db: DatabaseSync, prepared: Prepared[]): void {
  const update = db.prepare(`UPDATE canonical_listings SET
    title=?, description=?, price=?, currency=?, property_type=?, category=?, bedrooms=?, bathrooms=?,
    min_lease_months=?, lease_term_text=?, deposit_amount=?, deposit_months=?, pet_friendly=?,
    amenities=?, restrictions=?, electricity_type=?, electricity_rate=?, water_type=?, water_rate=?,
    city=?, sangkat=?, explicit_location=?, listing_facts_json=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`);
  for (const p of prepared) {
    const f = p.facts;
    const previous = jsonObj(p.row.listing_facts_json);
    const updated = { ...previous, ...f, ...p.contacts };
    // Preserve non-extraction context (offer_type, verified coordinates, source
    // provenance) while replacing every extraction field, including explicit nulls.
    const cents = f.price === null ? null : Math.round(f.price * 100);
    const city = f.city?.toLowerCase().replace(/[_\s-]+/g, ' ').includes('siem reap') ? 'siem_reap' : null;
    const result = update.run(f.title_en, f.description_en, cents, cents === null ? null : f.currency,
      f.property_type, f.category, f.bedrooms, f.bathrooms, f.min_lease_months, f.lease_term_text,
      f.deposit_amount, f.deposit_months, f.pet_friendly === null ? null : Number(f.pet_friendly),
      JSON.stringify(f.discovered_amenities), JSON.stringify(f.restrictions), f.electricity_type,
      f.electricity_rate, f.water_type, f.water_rate, city, f.sangkat, f.explicit_location,
      JSON.stringify(updated), p.id);
    if (result.changes !== 1) throw Error(`Unexpected update count for ${p.id}: ${result.changes}`);
  }
}
function main() {
  const db = new DatabaseSync(dbPath, { readOnly: !isApply });
  try {
    if (!isApply) db.exec('PRAGMA query_only=ON');
    else db.exec('PRAGMA busy_timeout=10000');
    const {ids,ready,skipped} = prepare(db);
    const report = {phase:isApply?'apply':'dry-run',database:dbPath,publicTotal:ids.length,
      applyCandidates:ready.length, skipped, updated:0, publicAfter:ids.length};
    if (isApply) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // The same cohort and pre-state checks must still hold under the write lock.
        const underLock = prepare(db);
        if (underLock.ready.map((r) => r.id).join(',') !== ready.map((r) => r.id).join(',')) throw Error('Cohort changed before write');
        execute(db, underLock.ready);
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Foreign-key violation after apply');
        report.publicAfter = new CanonicalListingRepository(db).listPublicListingIds({city:'siem_reap',type:'rent'}).length;
        if (report.publicAfter < ids.length - 3) throw Error(`Unexpected public catalog shrink: ${ids.length} -> ${report.publicAfter}`);
        db.exec('COMMIT');
        report.updated = ready.length;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    console.log(JSON.stringify(report,null,2));
  } finally { db.close(); }
}
main();
