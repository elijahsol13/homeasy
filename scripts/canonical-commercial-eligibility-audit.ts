import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';

const TERMS: Array<[string, RegExp]> = [
  ['office', /\boffice(?:\s+space)?\b/i],
  ['warehouse', /\bwarehouse\b/i],
  ['shop', /\bshop(?:house)?\b/i],
  ['retail', /\bretail\b/i],
  ['commercial', /\bcommercial\b/i],
  ['business', /\bbusiness\b/i],
  ['co-working', /\bco[ -]?working\b/i],
  ['industrial', /\bindustrial\b/i],
];

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function main(): void {
  const dbPath = path.resolve(option('db') ?? process.env.DATABASE_PATH ?? 'data/homeasy.db');
  const outPath = path.resolve(option('out') ?? 'reports/phase6b-commercial-eligibility-audit.json');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const publicIds = new CanonicalListingRepository(db).listPublicListingIds({ city: 'siem_reap', type: 'rent' });
    const placeholders = publicIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT l.id,l.public_ref,l.title,l.description,l.category,l.property_type,l.listing_facts_json,
        o.id AS occurrence_id,o.source_url,s.raw_text
      FROM canonical_listings l
      JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
      JOIN source_items s ON s.id=o.source_item_id
      WHERE l.id IN (${placeholders}) ORDER BY l.id
    `).all(...publicIds) as Array<Record<string, unknown>>;
    const candidates = rows.flatMap((row) => {
      const text = [row.title, row.description, row.raw_text, row.listing_facts_json]
        .filter((value): value is string => typeof value === 'string').join('\n');
      const signals = TERMS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
      return signals.length ? [{
        listingId: Number(row.id), publicRef: String(row.public_ref), occurrenceId: Number(row.occurrence_id),
        sourceUrl: String(row.source_url), category: row.category ?? null, propertyType: row.property_type ?? null,
        signals, title: String(row.title),
      }] : [];
    });
    const report = {
      mode: 'READ_ONLY_COMMERCIAL_ELIGIBILITY_AUDIT', generatedAt: new Date().toISOString(), dbPath,
      publicCanonicalListings: publicIds.length, scanned: rows.length, termLabels: TERMS.map(([label]) => label),
      candidates, candidateCount: candidates.length,
      note: 'Candidates are audit signals only. This script does not change publication, moderation, availability, or source data.',
    };
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ outPath, publicCanonicalListings: publicIds.length, candidateCount: candidates.length, candidates }, null, 2));
  } finally { db.close(); }
}

main();
