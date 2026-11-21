import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectFacebookOgPhoto } from '../src/modules/parser/facebook-og-media-refresh';
import { knownFacebookMediaUrls } from '../src/modules/parser/media-identity';

interface Options {
  dbPath: string;
  limit: number;
  sourceItemId: number | null;
}

function positiveInteger(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function parseArgs(args: string[]): Options {
  let dbPath = '';
  let limit = 10;
  let sourceItemId: number | null = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db': dbPath = args[++i] ?? ''; break;
      case '--limit': limit = positiveInteger(args[++i], '--limit'); break;
      case '--source-item-id': sourceItemId = positiveInteger(args[++i], '--source-item-id'); break;
      case '--dry-run': dryRun = true; break;
      default: throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if (!dbPath || !dryRun || limit > 32) {
    throw new Error('Usage: npm run media:facebook-og:dry-run -- --db <sqlite-path> --dry-run [--limit 1..32] [--source-item-id N]');
  }
  return { dbPath: path.resolve(dbPath), limit, sourceItemId };
}

interface SourceRow {
  id: number;
  external_id: string;
  group_id: string | null;
  post_url: string | null;
  raw_payload_json: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const sources = db.prepare(`SELECT DISTINCT s.id,s.external_id,s.group_id,
        COALESCE(s.canonical_url,s.source_url) AS post_url,s.raw_payload_json
      FROM source_items s
      JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1
      JOIN canonical_listing_moderation m ON m.listing_id=o.listing_id AND m.review_status='approved'
      WHERE s.source_type='FACEBOOK_GROUP' AND s.classification='HOUSING_SUPPLY'
        AND (? IS NULL OR s.id=?)
      ORDER BY s.id DESC LIMIT ?`).all(options.sourceItemId, options.sourceItemId, options.limit) as unknown as SourceRow[];

    const entries: Array<{ sourceItemId: number; status: string; knownPhotos: number }> = [];
    for (const source of sources) {
      let knownPhotos: string[] = [];
      try { knownPhotos = knownFacebookMediaUrls(JSON.parse(source.raw_payload_json)); } catch { /* old malformed payload */ }
      const groupId = source.group_id ?? '';
      const verified = source.post_url ? await inspectFacebookOgPhoto({
        postUrl: source.post_url, externalId: source.external_id, groupId, knownPhotos,
      }) : null;
      entries.push({ sourceItemId: source.id, status: verified ? 'verified-known-image' : 'unverified',
        knownPhotos: knownPhotos.length });
    }
    console.log(JSON.stringify({ mode: 'read-only-dry-run', selected: sources.length,
      verified: entries.filter((entry) => entry.status === 'verified-known-image').length,
      entries }, null, 2));
  } finally { db.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
