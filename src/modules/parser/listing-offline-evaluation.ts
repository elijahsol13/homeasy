import { createHash } from 'node:crypto';
import { sanitizeListingFacts } from './listing-extraction';
import { sourceRoomCounts } from './source-room-counts';
import { toLegacyListingExtraction } from './canonical-listing-adapter';

export interface ReviewedListing {
  id: number;
  source: 'Facebook' | 'Khmer24';
  sourceSha256: string;
  bedrooms: number | null; // Null means source unverified, never necessarily absent.
  bathrooms: number | null;
  monthlyRentUsd?: number; // Only explicitly human-verified rent cases.
}

export interface HistoricalListingSnapshot {
  sourceType: string;
  rawText: string;
  facts: Record<string, unknown>;
  bedrooms: number | null;
  bathrooms: number | null;
  priceCents: number | null;
  description: string;
}

interface FieldTrace {
  expected: number | null;
  detected: number | null;
  storedFacts: number | null;
  storedCard: number | null;
  replaySanitized: number | null;
  replayAdapter: number | null;
}

export interface OfflineListingTrace {
  id: number;
  source: ReviewedListing['source'];
  bedrooms: FieldTrace;
  bathrooms: FieldTrace;
  monthlyRent?: Omit<FieldTrace, 'detected'>;
  descriptionExactRaw: boolean;
  // This is deliberately only a replay through current deterministic code.
  // Historical pre-validator model responses, dedupe decisions and API payloads
  // are unavailable and cannot be reconstructed from a saved facts blob.
}

const asNumber = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Compare reviewed primary source with historical stored facts and hypothetical
 * replay of today's sanitizer/adapter. No model call and no database mutation. */
export function evaluateOfflineListing(gold: ReviewedListing, stored: HistoricalListingSnapshot): OfflineListingTrace {
  if (stored.sourceType !== (gold.source === 'Facebook' ? 'FACEBOOK_GROUP' : 'KHMER24')) {
    throw new Error(`source type mismatch for ${gold.id}`);
  }
  if (createHash('sha256').update(stored.rawText).digest('hex') !== gold.sourceSha256) {
    throw new Error(`source snapshot mismatch for ${gold.id}`);
  }
  const detected = sourceRoomCounts(stored.rawText);
  const sanitized = sanitizeListingFacts(stored.facts, stored.rawText);
  const adapter = sanitized ? toLegacyListingExtraction(sanitized) : null;
  const trace = (field: 'bedrooms' | 'bathrooms'): FieldTrace => ({
    expected: gold[field], detected: detected[field],
    storedFacts: asNumber(stored.facts[field]), storedCard: stored[field],
    replaySanitized: sanitized?.[field] ?? null, replayAdapter: adapter?.[field] ?? null,
  });
  const result: OfflineListingTrace = {
    id: gold.id, source: gold.source,
    bedrooms: trace('bedrooms'), bathrooms: trace('bathrooms'),
    descriptionExactRaw: stored.description.trim() === stored.rawText.trim(),
  };
  if (gold.monthlyRentUsd !== undefined) {
    result.monthlyRent = {
      expected: gold.monthlyRentUsd,
      storedFacts: asNumber(stored.facts.price),
      storedCard: stored.priceCents === null ? null : stored.priceCents / 100,
      replaySanitized: sanitized?.price ?? null,
      replayAdapter: adapter?.price ?? null,
    };
  }
  return result;
}

export interface FieldCounts {
  corroborated: number;
  correct: number;
  missed: number;
  contradicted: number;
  unverified: number; // Present but not source-corroborated; do not attribute to Gemini.
  unknownPreserved: number;
}

const emptyCounts = (): FieldCounts => ({ corroborated: 0, correct: 0, missed: 0,
  contradicted: 0, unverified: 0, unknownPreserved: 0 });

function countField(counts: FieldCounts, expected: number | null, actual: number | null): void {
  if (expected === null) {
    if (actual === null) counts.unknownPreserved++;
    else counts.unverified++;
    return;
  }
  counts.corroborated++;
  if (actual === null) counts.missed++;
  else if (actual === expected) counts.correct++;
  else counts.contradicted++;
}

type RoomCounts = { card: FieldCounts; facts: FieldCounts; detected: FieldCounts;
  replaySanitized: FieldCounts; replayAdapter: FieldCounts };
type RentCounts = { storedFacts: FieldCounts; storedCard: FieldCounts;
  replaySanitized: FieldCounts; replayAdapter: FieldCounts };

export interface SourceCounts {
  reviewed: number;
  bedrooms: RoomCounts;
  bathrooms: RoomCounts;
  monthlyRent: RentCounts;
  descriptionExactRaw: number;
}

const emptySource = (): SourceCounts => ({
  reviewed: 0,
  bedrooms: { card: emptyCounts(), facts: emptyCounts(), detected: emptyCounts(),
    replaySanitized: emptyCounts(), replayAdapter: emptyCounts() },
  bathrooms: { card: emptyCounts(), facts: emptyCounts(), detected: emptyCounts(),
    replaySanitized: emptyCounts(), replayAdapter: emptyCounts() },
  monthlyRent: { storedFacts: emptyCounts(), storedCard: emptyCounts(),
    replaySanitized: emptyCounts(), replayAdapter: emptyCounts() },
  descriptionExactRaw: 0,
});

export function summarizeOfflineListings(rows: OfflineListingTrace[]): Record<'Facebook' | 'Khmer24', SourceCounts> {
  const sources = { Facebook: emptySource(), Khmer24: emptySource() };
  for (const row of rows) {
    const s = sources[row.source];
    s.reviewed++;
    if (row.descriptionExactRaw) s.descriptionExactRaw++;
    for (const field of ['bedrooms', 'bathrooms'] as const) {
      const trace = row[field];
      const counts = s[field];
      countField(counts.card, trace.expected, trace.storedCard);
      countField(counts.facts, trace.expected, trace.storedFacts);
      countField(counts.detected, trace.expected, trace.detected);
      countField(counts.replaySanitized, trace.expected, trace.replaySanitized);
      countField(counts.replayAdapter, trace.expected, trace.replayAdapter);
    }
    if (row.monthlyRent) {
      for (const field of ['storedFacts', 'storedCard', 'replaySanitized', 'replayAdapter'] as const) {
        countField(s.monthlyRent[field], row.monthlyRent.expected, row.monthlyRent[field]);
      }
    }
  }
  return sources;
}
