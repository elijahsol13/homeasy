import path from 'node:path';
import type { RawListing } from './schemas';
import { env } from '../../config/env';
import { flushFacebookOutbox, queueFacebookBatch, type BatchSummary } from './facebook-outbox';

// Reuse the existing durable JSON-batch transport; source identity is fixed by
// the VPS endpoint, not trusted from the producer's request body.
export const KHMER24_BATCH_TARGET = {
  name: 'Khmer24 Siem Reap', url: 'https://www.khmer24.com/en', city: 'siem_reap',
} as const;
export const K24_OUTBOX_DIR = path.resolve('data/k24_outbox');

function configuredEndpoint(): { url: string; token: string } {
  if (!env.K24_INGEST_URL || !env.K24_INGEST_TOKEN) {
    throw new Error('Set K24_INGEST_URL and K24_INGEST_TOKEN in the Mac .env before --remote');
  }
  return { url: env.K24_INGEST_URL, token: env.K24_INGEST_TOKEN };
}

export async function submitKhmer24Listings(listings: RawListing[]): Promise<BatchSummary> {
  const { url, token } = configuredEndpoint();
  // The VPS performs LLM calls before acknowledging each request; keep
  // Cloudflare-proxied requests small and allow slow model responses.
  return queueFacebookBatch(KHMER24_BATCH_TARGET, listings, K24_OUTBOX_DIR, url, token,
    fetch, undefined, 180_000, 'Khmer24', 5);
}

export async function flushKhmer24Outbox(): Promise<BatchSummary> {
  const { url, token } = configuredEndpoint();
  return flushFacebookOutbox(K24_OUTBOX_DIR, url, token, fetch, 180_000, 'Khmer24');
}
