/** Manual Mac-side replay; does not start Camoufox or touch local SQLite. */
import 'dotenv/config';
import { assertFacebookLocalHost } from '../src/modules/parser/fb-runtime';
import { flushConfiguredFacebookOutbox } from '../src/modules/parser/facebook-outbox';

async function main(): Promise<void> {
  assertFacebookLocalHost();
  if (!process.env.FB_INGEST_URL || !process.env.FB_INGEST_TOKEN) {
    throw new Error('Set FB_INGEST_URL and FB_INGEST_TOKEN in the Mac .env first');
  }
  const result = await flushConfiguredFacebookOutbox();
  console.log(`Facebook queue delivered: ${result.newSourceItems} new, ${result.updatedSourceItems} updated, ${result.unchangedSourceItems} unchanged`);
}

void main().catch((error: unknown) => {
  console.error('Facebook queue replay failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
