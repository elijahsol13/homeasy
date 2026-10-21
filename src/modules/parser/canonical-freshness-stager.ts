import type { DatabaseSync } from 'node:sqlite';
import { FreshnessScheduler } from './freshness-scheduler';
import type { FreshnessPlanItem, FreshnessSchedulerConfig } from './freshness-scheduler';
import { safeKhmer24Url } from './canonical-freshness-executor';

interface SourceRow {
  listing_id: number;
  is_current: number;
  source_entity_key: string;
  last_seen_at: string;
  next_check_at: string | null;
  listing_status: string;
  availability_status: string | null;
  source_type: string;
  occurrence_url: string | null;
  canonical_url: string | null;
  source_url: string | null;
}

export interface FreshnessStageResult {
  mode: 'DRY_RUN' | 'STAGED';
  /** Number of zero-cost Khmer24 proposals considered, bounded by limit. */
  considered: number;
  /** Additional zero-cost proposals deferred by the per-invocation limit. */
  deferred: number;
  eligible: FreshnessPlanItem[];
  skipped: Array<{ listingId: number; reason: string }>;
  stagedIds: number[];
}

function skipReason(db: DatabaseSync, item: FreshnessPlanItem, now: Date): string | null {
  if (item.provider !== 'KHMER24' || item.checkType !== 'SOURCE_RECHECK' ||
    item.estimatedBrightDataRecords !== 0 || item.sourceOccurrenceId === null) {
    return 'unsupported or paid freshness proposal';
  }
  const row = db.prepare(`SELECT o.listing_id,o.is_current,o.source_entity_key,o.last_seen_at,o.next_check_at,
      l.status AS listing_status,l.availability_status,r.source_type,
      o.source_url AS occurrence_url,s.canonical_url,s.source_url
    FROM canonical_listing_source_occurrences o
    JOIN canonical_listings l ON l.id=o.listing_id
    JOIN source_registry r ON r.id=o.source_registry_id
    LEFT JOIN source_items s ON s.id=o.source_item_id
    WHERE o.id=? AND o.listing_id=?`).get(item.sourceOccurrenceId, item.listingId) as SourceRow | undefined;
  if (!row || row.is_current !== 1 || row.source_entity_key !== 'canonical-dedupe-v1' ||
    row.source_type !== 'KHMER24' || row.listing_status !== 'active' ||
    ['removed', 'rented'].includes(row.availability_status ?? '')) return 'source no longer current or eligible';
  const seen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(seen) || seen > now.getTime()) return 'invalid or future natural source observation';
  if (row.next_check_at && (!Number.isFinite(Date.parse(row.next_check_at)) ||
    Date.parse(row.next_check_at) > now.getTime())) return 'source confirmation not yet due';
  if (!safeKhmer24Url(row.occurrence_url ?? row.canonical_url ?? row.source_url)) {
    return 'missing or untrusted Khmer24 URL';
  }
  const existing = db.prepare(`SELECT 1 FROM freshness_jobs WHERE listing_id=?
    AND status IN ('QUEUED','RUNNING') LIMIT 1`).get(item.listingId);
  return existing ? 'another provider already has an active job' : null;
}

/**
 * Turn demand-gated proposals into *free* Khmer24 jobs, with no network I/O.
 * Preview is the default. The explicit staging path serializes planning and
 * inserts in one BEGIN IMMEDIATE transaction to guard against stale proposals.
 */
export function stageCanonicalKhmer24Freshness(
  db: DatabaseSync,
  config: FreshnessSchedulerConfig,
  options: { apply?: boolean; limit?: number } = {},
): FreshnessStageResult {
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error('limit must be 1-25');
  const now = config.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid staging clock');
  if (options.apply && db.isTransaction) throw new Error('Staging requires its own transaction');
  if (options.apply) db.exec('BEGIN IMMEDIATE');
  try {
    const proposals = new FreshnessScheduler(db, { ...config, now }).plan().proposed
      .filter((item) => item.provider === 'KHMER24' && item.checkType === 'SOURCE_RECHECK' &&
        item.estimatedBrightDataRecords === 0);
    const considered = proposals.slice(0, limit);
    const eligible: FreshnessPlanItem[] = [];
    const skipped: FreshnessStageResult['skipped'] = [];
    const stagedIds: number[] = [];
    for (const item of considered) {
      const reason = skipReason(db, item, now);
      if (reason) { skipped.push({ listingId: item.listingId, reason }); continue; }
      eligible.push(item);
      if (options.apply) {
        const result = db.prepare(`INSERT INTO freshness_jobs
          (listing_id,source_occurrence_id,check_type,provider,priority,reason,
            scheduled_at,status,estimated_cost,estimated_records)
          VALUES (?,?,'SOURCE_RECHECK','KHMER24',?,?,?,'QUEUED',0,0)`)
          .run(item.listingId, item.sourceOccurrenceId, item.priority, JSON.stringify(item.reason), now.toISOString());
        stagedIds.push(Number(result.lastInsertRowid));
      }
    }
    if (options.apply) db.exec('COMMIT');
    return { mode: options.apply ? 'STAGED' : 'DRY_RUN', considered: considered.length,
      deferred: proposals.length - considered.length, eligible, skipped, stagedIds };
  } catch (error) {
    if (options.apply && db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
