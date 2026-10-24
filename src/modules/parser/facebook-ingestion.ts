import type { AppContainer } from '../../container';
import type { RawListing } from './schemas';
import type { IngestionBatchResult } from './ingestion-contracts';
import { FacebookLiveAdapter, facebookGroupEnvelope } from './live-source-adapters';

/** Same canonical ingestion path for local imports and authenticated VPS batches. */
export async function ingestFacebookGroupListings(
  container: AppContainer,
  target: { name: string; url: string },
  listings: RawListing[],
): Promise<IngestionBatchResult> {
  const adapter = new FacebookLiveAdapter(async function* () {
    for (const listing of listings) yield facebookGroupEnvelope(listing, target);
  });
  return container.ingestionService.ingestBatch(adapter, {
    runType: 'DISCOVERY', ingestionMethod: 'CAMOUFOX', parserVersion: 'facebook-canonical-v1',
  });
}
