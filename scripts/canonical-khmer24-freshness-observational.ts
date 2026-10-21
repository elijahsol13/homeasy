import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalKhmer24FreshnessExecutor, type CanonicalKhmer24FreshnessPlanItem } from '../src/modules/parser/canonical-khmer24-freshness';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

function requiredArg(name: string): string {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

function planItems(value: unknown): CanonicalKhmer24FreshnessPlanItem[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { proposed?: unknown }).proposed)) {
    throw new Error('Plan must contain a proposed array');
  }
  const items = (value as { proposed: unknown[] }).proposed;
  if (!items.every((item) => {
    const row = item as Partial<CanonicalKhmer24FreshnessPlanItem>;
    if (!row || typeof row !== 'object') return false;
    if (typeof row.planKey !== 'string' || typeof row.publicRef !== 'string' || typeof row.sourceUrl !== 'string') return false;
    if (!Number.isInteger(row.listingId) || !Number.isInteger(row.occurrenceId) || typeof row.lastSeenAt !== 'string') return false;
    try { return new URL(row.sourceUrl).hostname.endsWith('khmer24.com'); } catch { return false; }
  })) throw new Error('Plan contains an invalid or non-Khmer24 item');
  return items as CanonicalKhmer24FreshnessPlanItem[];
}

function legacySnapshot(db: DatabaseSync) {
  return snapshotLegacyProperties(db);
}

function itemState(db: DatabaseSync, item: CanonicalKhmer24FreshnessPlanItem): Record<string, unknown> {
  const listing = db.prepare(`
    SELECT l.id AS listingId,l.public_ref AS publicRef,l.availability_status AS availability,
      l.last_seen_at AS lastSeenAt,l.last_checked_at AS lastCheckedAt,
      o.id AS occurrenceId,o.source_url AS sourceUrl,o.last_checked_at AS occurrenceLastCheckedAt,o.last_check_result AS occurrenceLastResult
    FROM canonical_listings l JOIN canonical_listing_source_occurrences o ON o.id=? AND o.listing_id=l.id
    WHERE l.id=?
  `).get(item.occurrenceId, item.listingId) as Record<string, unknown> | undefined;
  const check = db.prepare(`
    SELECT id,result,checked_at AS checkedAt,raw_response AS rawResponse
    FROM availability_checks WHERE source_occurrence_id=? AND check_type='SOURCE_RECHECK' AND provider='KHMER24'
      AND json_extract(raw_response,'$.planKey')=? ORDER BY id DESC LIMIT 1
  `).get(item.occurrenceId, item.planKey) as Record<string, unknown> | undefined;
  return { ...listing, check: check ?? null };
}

async function main(): Promise<void> {
  const planPath = path.resolve(requiredArg('plan'));
  const maxItems = Number(requiredArg('max-items'));
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10) throw new Error('--max-items must be an integer from 1 through 10');
  const plan = planItems(JSON.parse(fs.readFileSync(planPath, 'utf8')));
  if (plan.length !== maxItems) throw new Error(`Reviewed plan has ${plan.length} item(s), but --max-items is ${maxItems}`);
  const databasePath = path.resolve(process.env.DATABASE_PATH ?? './data/homeasy.db');
  const db = new DatabaseSync(databasePath);
  try {
    const preCheckCount = Number((db.prepare('SELECT COUNT(*) count FROM availability_checks').get() as { count: number }).count);
    const preMaxCheckId = Number((db.prepare('SELECT COALESCE(MAX(id),0) id FROM availability_checks').get() as { id: number }).id);
    const preLegacy = legacySnapshot(db);
    const preVisibleCount = new CanonicalListingRepository(db).searchProperties({ city: 'siem_reap', type: 'rent', limit: 1 }).total;
    const pre = plan.map((item) => itemState(db, item));
    const execution = await new CanonicalKhmer24FreshnessExecutor(db).execute(plan, { maxItems, minDelayMs: 1_000 });
    const postLegacy = legacySnapshot(db);
    const postVisibleCount = new CanonicalListingRepository(db).searchProperties({ city: 'siem_reap', type: 'rent', limit: 1 }).total;
    const post = plan.map((item) => itemState(db, item));
    const newChecks = db.prepare('SELECT id,listing_id,source_occurrence_id,result,checked_at,raw_response FROM availability_checks WHERE id>? ORDER BY id ASC')
      .all(preMaxCheckId) as Array<{ source_occurrence_id: number }>;
    const plannedOccurrences = new Set(plan.map((item) => item.occurrenceId));
    console.log(JSON.stringify({
      mode: 'OBSERVATIONAL_BATCH',
      planPath,
      pre: { availabilityChecks: preCheckCount, legacy: preLegacy, canonicalVisibleCount: preVisibleCount, items: pre },
      execution,
      post: {
        availabilityChecks: Number((db.prepare('SELECT COUNT(*) count FROM availability_checks').get() as { count: number }).count),
        legacy: postLegacy,
        canonicalVisibleCount: postVisibleCount,
        items: post,
        newChecks,
        unexpectedOccurrenceWrites: newChecks.filter((row) => !plannedOccurrences.has(row.source_occurrence_id)),
        integrity: db.prepare('PRAGMA integrity_check').all(),
        foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
      },
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
