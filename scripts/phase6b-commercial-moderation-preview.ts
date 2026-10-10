import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';

const DEFAULT_LISTING_IDS = [64, 87];
function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function main(): void {
  const dbPath = path.resolve(option('db') ?? process.env.DATABASE_PATH ?? 'data/homeasy.db');
  const outPath = path.resolve(option('out') ?? 'reports/phase6b-commercial-moderation-preview.json');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const catalog = new CanonicalListingRepository(db);
    const beforeIds = catalog.listPublicListingIds({ city: 'siem_reap', type: 'rent' });
    const candidates = db.prepare(`SELECT l.id,l.public_ref,l.title,o.source_url,s.raw_text,
      m.review_status,m.decision_origin,m.review_reason
      FROM canonical_listings l
      JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
      JOIN source_items s ON s.id=o.source_item_id
      JOIN canonical_listing_moderation m ON m.listing_id=l.id
      WHERE l.id IN (${DEFAULT_LISTING_IDS.map(() => '?').join(',')}) ORDER BY l.id`).all(...DEFAULT_LISTING_IDS);
    const eligibleIds = DEFAULT_LISTING_IDS.filter((id) => beforeIds.includes(id));
    const report = {
      mode: 'READ_ONLY_EXPLICIT_COMMERCIAL_MODERATION_PREVIEW', dbPath,
      proposedDecision: {
        listingIds: eligibleIds,
        reviewStatus: 'rejected', decisionOrigin: 'EXPLICIT_CANONICAL', decisionActor: 'HUMAN',
        reason: 'Explicit commercial listing evidence; not a broad keyword policy.',
      },
      publicCount: { before: beforeIds.length, after: beforeIds.length - eligibleIds.length, delta: -eligibleIds.length },
      candidates,
      writeSurfacesIfApproved: ['canonical_listing_moderation only'],
      note: 'This preview is read-only and makes no moderation, visibility, availability, or legacy changes.',
    };
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ outPath, ...report }, null, 2));
  } finally { db.close(); }
}

main();
