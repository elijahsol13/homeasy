import type { DatabaseSync } from 'node:sqlite';

export interface FreshnessSchedulerConfig {
  monthlyBrightDataRecordBudget: number;
  freshnessBudgetPercent: number;
  reservePercent: number;
  staleAfterDays?: number;
  topNPerRequest?: number;
  now?: Date;
}

export interface FreshnessPlanItem {
  listingId: number;
  priority: number;
  provider: 'AGENT' | 'KHMER24' | 'BRIGHTDATA';
  checkType: 'AGENT_CONFIRMATION' | 'SOURCE_RECHECK';
  sourceOccurrenceId: number | null;
  reason: string[];
  estimatedBrightDataRecords: number;
}

export interface FreshnessDryRunReport {
  mode: 'DRY_RUN';
  paidExecutionEnabled: false;
  canonicalActiveListings: number;
  currentlyFresh: number;
  stale: number;
  wouldCheck: number;
  wouldSkip: number;
  skipReasons: Record<string, number>;
  providerPlanned: Record<string, number>;
  monthlyBrightDataRecordBudget: number;
  freshnessBudgetRecords: number;
  reserveRecords: number;
  alreadySpentRecords: number;
  queuedOrReservedRecords: number;
  availableFreshnessRecords: number;
  estimatedBrightDataRecords: number;
  proposed: FreshnessPlanItem[];
  top20PaidChecks: FreshnessPlanItem[];
}

interface ListingRow {
  id: number; status: string; availability_status: string | null; city: string | null;
  category: string | null; price: number | null; bedrooms: number | null;
  last_seen_at: string; availability_last_confirmed_at: string | null;
  next_check_at: string | null; occurrence_id: number | null; source_type: string | null; sangkat?: string | null;
}

interface ActiveFilter {
  id: number; type: string; min_price: number | null; max_price: number | null;
  bedrooms: number | null; locations: string; city: string;
}

function daysSince(value: string | null, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 86_400_000) : Number.POSITIVE_INFINITY;
}

function matchesFilter(row: ListingRow, filter: ActiveFilter): boolean {
  if (row.city !== filter.city) return false;
  if (filter.type && filter.type !== 'rent' && filter.type !== 'sale') return false;
  if (filter.min_price !== null && (row.price ?? 0) < filter.min_price) return false;
  if (filter.max_price !== null && (row.price ?? Number.MAX_SAFE_INTEGER) > filter.max_price) return false;
  if (filter.bedrooms !== null && row.bedrooms !== filter.bedrooms) return false;
  let locations: unknown;
  try { locations = JSON.parse(filter.locations); } catch { locations = []; }
  if (Array.isArray(locations) && locations.length) {
    const area = (row as ListingRow & { sangkat?: string | null }).sangkat?.toLowerCase() ?? '';
    if (!locations.some((location) => typeof location === 'string' && area.includes(location.toLowerCase()))) return false;
  }
  return true;
}

function providerFor(sourceType: string | null): FreshnessPlanItem['provider'] {
  if (sourceType === 'AGENT' || sourceType === 'LANDLORD') return 'AGENT';
  if (sourceType === 'KHMER24') return 'KHMER24';
  return 'BRIGHTDATA';
}

function providerCost(provider: FreshnessPlanItem['provider']): number {
  return provider === 'BRIGHTDATA' ? 1 : 0;
}

/** Builds a read-only freshness plan. It never inserts jobs or contacts a source. */
export class FreshnessScheduler {
  constructor(private readonly db: DatabaseSync, private readonly config: FreshnessSchedulerConfig) {
    for (const [name, value] of Object.entries({
      monthlyBrightDataRecordBudget: config.monthlyBrightDataRecordBudget,
      freshnessBudgetPercent: config.freshnessBudgetPercent,
      reservePercent: config.reservePercent,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
    }
    if (config.freshnessBudgetPercent > 100 || config.reservePercent > 100) throw new Error('Budget percentages cannot exceed 100');
  }

  plan(): FreshnessDryRunReport {
    const now = this.config.now ?? new Date();
    const staleAfterDays = this.config.staleAfterDays ?? 7;
    const topN = this.config.topNPerRequest ?? 5;
    const rows = this.db.prepare(`
      SELECT l.id,l.status,l.availability_status,l.city,l.category,l.price,l.bedrooms,l.sangkat,
        l.last_seen_at,l.availability_last_confirmed_at,
        (SELECT MIN(oo.next_check_at) FROM canonical_listing_source_occurrences oo WHERE oo.listing_id=l.id AND oo.source_entity_key='canonical-dedupe-v1' AND oo.is_current=1) AS next_check_at,
        (SELECT oo.id FROM canonical_listing_source_occurrences oo
          JOIN source_registry rr ON rr.id=oo.source_registry_id
          WHERE oo.listing_id=l.id AND oo.source_entity_key='canonical-dedupe-v1' AND oo.is_current=1 ORDER BY
            CASE rr.source_type WHEN 'AGENT' THEN 0 WHEN 'LANDLORD' THEN 0 WHEN 'KHMER24' THEN 1 ELSE 2 END,
            oo.last_seen_at DESC LIMIT 1) AS occurrence_id,
        (SELECT r.source_type FROM canonical_listing_source_occurrences oo
          JOIN source_registry r ON r.id=oo.source_registry_id
          WHERE oo.listing_id=l.id AND oo.is_current=1 ORDER BY
            CASE r.source_type WHEN 'AGENT' THEN 0 WHEN 'LANDLORD' THEN 0 WHEN 'KHMER24' THEN 1 ELSE 2 END,
            oo.last_seen_at DESC LIMIT 1) AS source_type
      FROM canonical_listings l
      WHERE l.status='active' AND COALESCE(l.availability_status,'unknown') NOT IN ('rented','removed')
      ORDER BY l.id
    `).all() as unknown as Array<ListingRow>;
    const filters = this.db.prepare(`SELECT f.id,f.type,f.min_price,f.max_price,f.bedrooms,f.locations,f.city
      FROM search_filters f JOIN users u ON u.id=f.user_id
      WHERE f.is_active=1 AND u.is_active=1`).all() as unknown as ActiveFilter[];
    const topDemand = new Map<number, Set<number>>();
    for (const filter of filters) {
      const matched = rows.filter((row) => matchesFilter(row, filter))
        .sort((a, b) => {
          const targetA = filter.max_price ?? filter.min_price;
          const targetB = filter.max_price ?? filter.min_price;
          return (targetA === null ? 0 : Math.abs((a.price ?? targetA) - targetA))
            - (targetB === null ? 0 : Math.abs((b.price ?? targetB) - targetB)) || a.id - b.id;
        }).slice(0, topN);
      for (const row of matched) {
        const filterIds = topDemand.get(row.id) ?? new Set<number>();
        filterIds.add(filter.id); topDemand.set(row.id, filterIds);
      }
    }

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const spent = this.db.prepare(`SELECT COALESCE(SUM(records),0) AS n FROM external_provider_usage
      WHERE lower(provider) LIKE '%brightdata%' AND created_at>=?`).get(monthStart) as { n: number };
    const reserved = this.db.prepare(`SELECT COALESCE(SUM(estimated_records),0) AS n FROM freshness_jobs
      WHERE provider='BRIGHTDATA' AND status IN ('QUEUED','RUNNING')`).get() as { n: number };
    const budget = Math.floor(this.config.monthlyBrightDataRecordBudget * this.config.freshnessBudgetPercent / 100);
    const reserve = Math.ceil(this.config.monthlyBrightDataRecordBudget * this.config.reservePercent / 100);
    const spentRecords = Number(spent.n) || 0;
    const reservedRecords = Math.ceil(Number(reserved.n) || 0);
    const available = Math.max(0, budget - reserve - spentRecords - reservedRecords);
    const skipReasons: Record<string, number> = {};
    const countSkip = (reason: string) => { skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; };
    let currentlyFresh = 0;
    let stale = 0;
    const proposed: FreshnessPlanItem[] = [];
    for (const row of rows) {
      const latestEvidence = [row.last_seen_at, row.availability_last_confirmed_at]
        .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
      const age = daysSince(latestEvidence, now);
      if (age <= staleAfterDays) { currentlyFresh++; countSkip('recently observed or confirmed'); continue; }
      stale++;
      if (!topDemand.has(row.id)) { countSkip('no active demand in top-N'); continue; }
      if (row.next_check_at && Date.parse(row.next_check_at) > now.getTime()) { countSkip('next_check_at is in the future'); continue; }
      const provider = providerFor(row.source_type);
      const cost = providerCost(provider);
      const reasons = [`active request top-${topN} match (${topDemand.get(row.id)!.size} request(s))`, `last evidence ${Math.floor(age)} day(s) ago`, `cheapest available source: ${provider}`];
      proposed.push({ listingId: row.id, priority: Math.min(100, 70 + Math.floor(age) + topDemand.get(row.id)!.size * 5),
        provider, checkType: provider === 'AGENT' ? 'AGENT_CONFIRMATION' : 'SOURCE_RECHECK',
        sourceOccurrenceId: row.occurrence_id, reason: reasons, estimatedBrightDataRecords: cost });
    }
    proposed.sort((a, b) => b.priority - a.priority || a.listingId - b.listingId);
    let remaining = available;
    const approved = proposed.filter((item) => {
      if (item.estimatedBrightDataRecords > remaining) { countSkip('freshness budget exhausted or reserved'); return false; }
      remaining -= item.estimatedBrightDataRecords; return true;
    });
    const providerPlanned: Record<string, number> = {};
    for (const item of approved) providerPlanned[item.provider] = (providerPlanned[item.provider] ?? 0) + 1;
    return {
      mode: 'DRY_RUN', paidExecutionEnabled: false, canonicalActiveListings: rows.length,
      currentlyFresh, stale, wouldCheck: approved.length, wouldSkip: rows.length - approved.length,
      skipReasons, providerPlanned, monthlyBrightDataRecordBudget: this.config.monthlyBrightDataRecordBudget,
      freshnessBudgetRecords: budget, reserveRecords: reserve, alreadySpentRecords: spentRecords,
      queuedOrReservedRecords: reservedRecords, availableFreshnessRecords: available,
      estimatedBrightDataRecords: approved.reduce((sum, item) => sum + item.estimatedBrightDataRecords, 0),
      proposed: approved, top20PaidChecks: approved.filter((item) => item.provider === 'BRIGHTDATA').slice(0, 20),
    };
  }
}

/** Worker preflight for a future executor; a natural signal invalidates the queued job. */
export function freshnessJobSkipReason(db: DatabaseSync, listingId: number, queuedAt: string, naturalSignalAfterQueue: boolean): string | null {
  if (naturalSignalAfterQueue) return 'naturally rediscovered or agent-confirmed after queueing';
  const completed = db.prepare(`SELECT 1 FROM availability_checks WHERE listing_id=? AND checked_at>? LIMIT 1`).get(listingId, queuedAt);
  return completed ? 'another check completed after queueing' : null;
}

/** Atomically reserves Bright Data records; BEGIN IMMEDIATE serializes competing schedulers. */
export function reserveBrightDataRecords(db: DatabaseSync, input: {
  listingId: number; sourceOccurrenceId?: number | null; estimatedRecords: number;
  monthlyBudget: number; freshnessBudgetPercent: number; reservePercent: number; now?: Date;
}): boolean {
  if (!Number.isInteger(input.estimatedRecords) || input.estimatedRecords < 1) return false;
  const now = input.now ?? new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const spent = db.prepare(`SELECT COALESCE(SUM(records),0) n FROM external_provider_usage
      WHERE lower(provider) LIKE '%brightdata%' AND created_at>=?`).get(monthStart) as { n: number };
    const reserved = db.prepare(`SELECT COALESCE(SUM(estimated_records),0) n FROM freshness_jobs
      WHERE provider='BRIGHTDATA' AND status IN ('QUEUED','RUNNING')`).get() as { n: number };
    const cap = Math.floor(input.monthlyBudget * input.freshnessBudgetPercent / 100)
      - Math.ceil(input.monthlyBudget * input.reservePercent / 100);
    if (Number(spent.n) + Number(reserved.n) + input.estimatedRecords > cap) {
      db.exec('ROLLBACK'); return false;
    }
    db.prepare(`INSERT INTO freshness_jobs(listing_id,source_occurrence_id,check_type,provider,priority,reason,scheduled_at,status,estimated_records)
      VALUES(?,?,'SOURCE_RECHECK','BRIGHTDATA',0,'atomic freshness reservation',?,'QUEUED',?)`)
      .run(input.listingId, input.sourceOccurrenceId ?? null, now.toISOString(), input.estimatedRecords);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    if (error instanceof Error && /busy|locked|constraint/i.test(error.message)) return false;
    throw error;
  }
}

/** Cancels queued paid work after natural rediscovery, recording zero actual spend. */
export function cancelFreshnessJobAfterRediscovery(db: DatabaseSync, jobId: number, observedAt: string): boolean {
  const result = db.prepare(`UPDATE freshness_jobs SET status='CANCELLED',finished_at=?,actual_cost=0,
      result='naturally rediscovered before execution',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id=? AND status='QUEUED' AND listing_id IN
      (SELECT id FROM canonical_listings WHERE last_seen_at>freshness_jobs.scheduled_at)`)
    .run(observedAt, jobId);
  return result.changes === 1;
}
