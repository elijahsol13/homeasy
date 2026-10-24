import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RawListing } from './schemas';
import type { AppContainer } from '../../container';
import { env } from '../../config/env';
import { ingestFacebookGroupListings } from './facebook-ingestion';

type Group = { name: string; url: string; city?: string };
type Batch = { target: Group; listings: RawListing[] };
export type BatchSummary = { newSourceItems: number; updatedSourceItems: number; unchangedSourceItems: number; errors: Array<{ message: string }> };
const MAX_BATCH_BYTES = 1024 * 1024;

const emptySummary = (): BatchSummary => ({ newSourceItems: 0, updatedSourceItems: 0, unchangedSourceItems: 0, errors: [] });
const OUTBOX_DIR = path.resolve('data/fb_outbox');

function requireSecureTransport(url: string, token: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('Facebook ingest URL must use HTTPS');
  }
  if (token.length < 32) throw new Error('FB_INGEST_TOKEN must contain at least 32 characters');
}

export async function flushFacebookOutbox(
  outboxDir: string, url: string, token: string, transport: typeof fetch = fetch,
): Promise<BatchSummary> {
  requireSecureTransport(url, token);
  if (!fs.existsSync(outboxDir)) return emptySummary();
  const combined = emptySummary();
  const files = fs.readdirSync(outboxDir).filter((file) => file.endsWith('.json')).sort();
  for (const file of files) {
    const filePath = path.join(outboxDir, file);
    const batch = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Batch;
    const response = await transport(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(batch), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Facebook batch ingest HTTP ${response.status}; ${files.length} batch(es) queued`);
    const result = await response.json() as BatchSummary;
    if (!Array.isArray(result.errors) || result.errors.length > 0 ||
        ![result.newSourceItems, result.updatedSourceItems, result.unchangedSourceItems]
          .every((n) => Number.isSafeInteger(n) && n >= 0) ||
        result.newSourceItems + result.updatedSourceItems + result.unchangedSourceItems !== batch.listings.length) {
      throw new Error('Facebook importer returned an invalid or incomplete response; batch retained');
    }
    // Remove only after a complete, acknowledged canonical DB ingestion.
    fs.unlinkSync(filePath);
    combined.newSourceItems += result.newSourceItems;
    combined.updatedSourceItems += result.updatedSourceItems;
    combined.unchangedSourceItems += result.unchangedSourceItems;
  }
  return combined;
}

export async function queueFacebookBatch(
  target: Group, listings: RawListing[], outboxDir: string, url: string, token: string,
  transport: typeof fetch = fetch,
): Promise<BatchSummary> {
  requireSecureTransport(url, token);
  if (!listings.length) return flushFacebookOutbox(outboxDir, url, token, transport);
  fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  // Validate ALL items before creating any queue files. Keep each request below
  // Fastify's 1 MiB limit and the server's 10-listing count limit.
  const chunks: RawListing[][] = [];
  let chunk: RawListing[] = [];
  for (const listing of listings) {
    if (Buffer.byteLength(JSON.stringify({ target, listings: [listing] })) > MAX_BATCH_BYTES) {
      throw new Error('Facebook listing exceeds remote ingest 1 MiB request limit');
    }
    if (chunk.length >= 10 || (chunk.length > 0 &&
        Buffer.byteLength(JSON.stringify({ target, listings: [...chunk, listing] })) > MAX_BATCH_BYTES)) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(listing);
  }
  if (chunk.length) chunks.push(chunk);
  for (const listingsChunk of chunks) {
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const tmpPath = path.join(outboxDir, `${id}.tmp`);
    const readyPath = path.join(outboxDir, `${id}.json`);
    // A complete, private on-disk outbox survives transient network outages.
    fs.writeFileSync(tmpPath, JSON.stringify({ target, listings: listingsChunk }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, readyPath);
  }
  return flushFacebookOutbox(outboxDir, url, token, transport);
}

/** Local mode stays compatible; VPS mode never writes Facebook rows to the Mac's SQLite. */
export async function submitFacebookListings(
  container: AppContainer | undefined, target: Group, listings: RawListing[],
): Promise<BatchSummary> {
  if (!env.FB_INGEST_URL) {
    if (!container) throw new Error('Local Facebook ingestion needs a database container');
    return ingestFacebookGroupListings(container, target, listings);
  }
  if (!env.FB_INGEST_TOKEN) throw new Error('FB_INGEST_URL is set but FB_INGEST_TOKEN is missing');
  return queueFacebookBatch(target, listings, OUTBOX_DIR, env.FB_INGEST_URL, env.FB_INGEST_TOKEN);
}

export async function flushConfiguredFacebookOutbox(): Promise<BatchSummary> {
  if (!env.FB_INGEST_URL) return emptySummary();
  if (!env.FB_INGEST_TOKEN) throw new Error('FB_INGEST_URL is set but FB_INGEST_TOKEN is missing');
  return flushFacebookOutbox(OUTBOX_DIR, env.FB_INGEST_URL, env.FB_INGEST_TOKEN);
}
