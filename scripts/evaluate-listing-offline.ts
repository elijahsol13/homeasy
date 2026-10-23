/** Deterministic historical audit of manually reviewed primary-source listings.
 * Read-only: never calls a model, touches ingestion or updates the live database.
 * Run: npx ts-node scripts/evaluate-listing-offline.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  evaluateOfflineListing, summarizeOfflineListings,
  type ReviewedListing,
} from '../src/modules/parser/listing-offline-evaluation';

interface DbRow {
  source_type: string;
  raw_text: string;
  raw_payload_json: string | null;
  listing_facts_json: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  price: number | null;
  description: string | null;
}

type FieldEvidence = { available: number; corroborated: number; contradicted: number; unverified: number };
const blankEvidence = (): FieldEvidence => ({ available: 0, corroborated: 0, contradicted: 0, unverified: 0 });

function parseNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function main(): void {
  const gold = JSON.parse(readFileSync(resolve('reports/homeasy-ai-extraction-stage4-gold-20261023.json'), 'utf8')) as {
    pairs: ReviewedListing[];
  };
  if (!Array.isArray(gold.pairs) || gold.pairs.length !== 37 || new Set(gold.pairs.map(p => p.id)).size !== 37) {
    throw new Error('Expected exactly 37 unique human-reviewed gold IDs');
  }
  const db = new DatabaseSync(resolve('data/homeasy.db'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const get = db.prepare(`
      SELECT s.source_type, s.raw_text, s.raw_payload_json,
             l.listing_facts_json, l.bedrooms, l.bathrooms, l.price, l.description
      FROM canonical_listings l
      JOIN canonical_listing_source_occurrences o ON o.id = l.primary_source_occurrence_id
      JOIN source_items s ON s.id = o.source_item_id
      WHERE l.id = ?
    `);
    const evidence = { bedrooms: blankEvidence(), bathrooms: blankEvidence() };
    let khmer24PayloadsWithFields = 0;
    const traces = gold.pairs.map(pair => {
      const stored = get.get(pair.id) as unknown as DbRow | undefined;
      if (!stored) throw new Error(`Missing primary-source listing ${pair.id}`);
      if (typeof stored.raw_text !== 'string' || typeof stored.listing_facts_json !== 'string') {
        throw new Error(`Missing saved source or facts ${pair.id}`);
      }
      const facts = JSON.parse(stored.listing_facts_json) as Record<string, unknown>;
      const trace = evaluateOfflineListing(pair, {
        sourceType: stored.source_type, rawText: stored.raw_text, facts,
        bedrooms: stored.bedrooms, bathrooms: stored.bathrooms,
        priceCents: stored.price, description: stored.description ?? '',
      });
      if (pair.source === 'Khmer24' && stored.raw_payload_json) {
        const payload = JSON.parse(stored.raw_payload_json) as Record<string, unknown>;
        const archived = payload.listing && typeof payload.listing === 'object'
          ? payload.listing as Record<string, unknown> : payload;
        if (parseNumber(archived.bedrooms) !== null || parseNumber(archived.bathrooms) !== null) {
          khmer24PayloadsWithFields++;
        }
        for (const field of ['bedrooms', 'bathrooms'] as const) {
          const value = parseNumber(archived[field]);
          if (value === null) continue;
          const e = evidence[field];
          e.available++;
          if (pair[field] === null) e.unverified++;
          else if (value === pair[field]) e.corroborated++;
          else e.contradicted++;
        }
      }
      return trace;
    });
    const totals = summarizeOfflineListings(traces);
    // IDs and aggregate counts only: the original text and contact data are not exported.
    console.log(JSON.stringify({
      sample: { reviewed: traces.length, Facebook: totals.Facebook.reviewed, Khmer24: totals.Khmer24.reviewed },
      sources: totals,
      khmer24ArchivedPayload: {
        notes: 'Historical payload values; cannot certify they are original Khmer24 form entries',
        reviewed: totals.Khmer24.reviewed,
        withBedroomOrBathroom: khmer24PayloadsWithFields,
        fields: evidence,
      },
      deviations: traces.filter(r => ['bedrooms', 'bathrooms'].some(field => {
        const f = r[field as 'bedrooms' | 'bathrooms'];
        return f.expected !== null && (f.storedCard !== f.expected || f.storedFacts !== f.expected);
      }) || (r.monthlyRent && r.monthlyRent.storedFacts !== r.monthlyRent.expected)).map(r => r.id),
    }, null, 2));
  } finally {
    db.close();
  }
}

main();
