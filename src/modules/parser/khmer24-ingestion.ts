import type { AppContainer } from '../../container';
import type { RawListing } from './schemas';
import type { IngestionBatchResult } from './ingestion-contracts';
import { Khmer24LiveAdapter, type LiveListingEnvelope } from './live-source-adapters';
import { classifyKhmer24Listing, enrichListingsWithLLM } from './khmer24.scraper';

/** Shared by local imports and the VPS endpoint; classification and canonical
 * reconciliation run where the destination SQLite actually lives. */
export async function ingestKhmer24Listings(
  container: AppContainer, listings: RawListing[], noEnrich = false,
): Promise<IngestionBatchResult> {
  const envelopes: LiveListingEnvelope[] = listings.map((listing) => ({
    listing, sourceName: 'Khmer24 Siem Reap', sourceId: 'siem-reap', sourceUrl: 'https://www.khmer24.com/en',
  }));
  const adapter = new Khmer24LiveAdapter(async function* () { yield* envelopes; });
  const states = envelopes.map((envelope) => {
    const normalized = adapter.normalize(envelope);
    const sourceId = container.sourceIngestionRepo.findSourceId(
      container.sourceIngestionRepo.makeSourceKey(normalized.sourceIdentity),
    );
    const existing = sourceId === undefined ? undefined :
      container.sourceIngestionRepo.findSourceItemState(sourceId, normalized.externalId);
    const changed = !existing || existing.contentHash !== (normalized.contentHash ?? null)
      || existing.classification === 'UNCLASSIFIED' || existing.classification === null;
    const classification = existing?.classification;
    const priorClass = ['HOUSING_SUPPLY', 'HOUSING_DEMAND', 'HOUSING_ADJACENT', 'IRRELEVANT', 'UNCLASSIFIED']
      .includes(classification ?? '') ? classification as LiveListingEnvelope['classification'] : undefined;
    return { contentChanged: changed, classification: priorClass };
  });
  const contentChanged = envelopes.filter((_, index) => states[index].contentChanged);

  const changedListings = noEnrich || !contentChanged.length
    ? contentChanged.map((envelope) => envelope.listing)
    : await enrichListingsWithLLM(contentChanged.map((envelope) => envelope.listing), { inclusive: true });
  // Inclusive enrichment preserves input order. Missing/shortened results require
  // a retry for the entire changed cohort rather than shifting data between posts.
  let enrichmentIndex = 0;
  const enrichmentComplete = changedListings.length === contentChanged.length;
  const processed = envelopes.map((envelope, index) => {
    const state = states[index];
    const enriched = state.contentChanged && enrichmentComplete ? changedListings[enrichmentIndex] : undefined;
    if (state.contentChanged) enrichmentIndex++;
    // The extractor can return an UNCLASSIFIED fallback after a transient AI
    // failure. Keep the raw source in SQLite, but require Mac outbox replay.
    const processingError = !noEnrich && state.contentChanged &&
      (!enriched || (enriched.is_real_estate == null && enriched.review_reason === 'LLM extraction unavailable'))
      ? 'LLM extraction unavailable' : undefined;
    const classification = state.contentChanged
      ? classifyKhmer24Listing(noEnrich ? undefined : enriched)
      : state?.classification ?? 'UNCLASSIFIED';
    return { ...envelope, classification, processingError, listing: enriched ?? envelope.listing };
  });
  return container.ingestionService.ingestBatch(new Khmer24LiveAdapter(async function* () { yield* processed; }), {
    runType: 'DISCOVERY', ingestionMethod: 'KHMER24_SCRAPER', parserVersion: 'khmer24-canonical-v1',
  });
}
