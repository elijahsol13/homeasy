import type { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../../database/repositories/canonical-listing.repo';
import type { CityKey } from '../../config/settings';
import type { PropertyFilterOptions } from '../../database/repositories/properties.repo';
import {
  classifyKhmer24PageLiveness,
  describeKhmer24FetchFailure,
  formatKhmer24FetchDiagnostic,
  type Khmer24FetchDiagnostic,
} from './khmer24-http';
import { Khmer24CamoufoxTransport, type Khmer24PageTransport, type Khmer24TransportPage } from './khmer24-camoufox-transport';
import { transitionKhmer24Freshness } from './canonical-khmer24-freshness-policy';

export interface CanonicalKhmer24FreshnessPlanItem {
  planKey: string;
  listingId: number;
  publicRef: string;
  occurrenceId: number;
  sourceUrl: string;
  lastSeenAt: string;
  priority: number;
  reasons: string[];
}

export interface CanonicalKhmer24FreshnessPlan {
  mode: 'DRY_RUN';
  publicEligibleListings: number;
  currentKhmer24Occurrences: number;
  staleEligibleListings: number;
  activeSavedFilters: number;
  activeDirectInterestRequests: number;
  wouldCheck: number;
  skipReasons: Record<string, number>;
  proposed: CanonicalKhmer24FreshnessPlanItem[];
}

export interface CanonicalKhmer24FreshnessPlannerConfig {
  /** Phase 6B.1 is intentionally scoped to the current Siem Reap catalog. */
  city?: CityKey;
  staleAfterDays?: number;
  topNPerSavedFilter?: number;
  now?: Date;
}

interface ListingRow {
  id: number;
  public_ref: string;
  last_seen_at: string;
  availability_last_confirmed_at: string | null;
  occurrence_id: number | null;
  source_url: string | null;
  next_check_at: string | null;
}

interface SavedFilterRow {
  id: number;
  type: 'rent' | 'sale';
  min_price: number | null;
  max_price: number | null;
  bedrooms: number | null;
  locations: string;
  city: CityKey;
}

interface DirectInterestRow {
  id: string;
  listing_id: number;
}

interface DemandSignal {
  savedFilterIds: Set<number>;
  directInterestRequestIds: Set<string>;
}

function daysSince(value: string | null, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, (now.getTime() - timestamp) / 86_400_000) : Number.POSITIVE_INFINITY;
}

function parseLocations(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function filterOptions(filter: SavedFilterRow, topN: number): PropertyFilterOptions {
  return {
    city: filter.city,
    type: filter.type,
    minPrice: filter.min_price ?? undefined,
    maxPrice: filter.max_price ?? undefined,
    bedrooms: filter.bedrooms === null ? undefined : [filter.bedrooms],
    locations: parseLocations(filter.locations),
    sort: 'newest',
    limit: topN,
  };
}

/**
 * Read-only planner for the first canonical-only Khmer24 freshness rollout.
 * It gets public eligibility from CanonicalListingRepository, the same source
 * used by the production read path, and never creates a freshness job.
 */
export class CanonicalKhmer24FreshnessPlanner {
  constructor(private readonly db: DatabaseSync, private readonly config: CanonicalKhmer24FreshnessPlannerConfig = {}) {}

  plan(): CanonicalKhmer24FreshnessPlan {
    const now = this.config.now ?? new Date();
    const staleAfterDays = this.config.staleAfterDays ?? 7;
    const topN = this.config.topNPerSavedFilter ?? 5;
    const catalog = new CanonicalListingRepository(this.db);
    const city = this.config.city ?? 'siem_reap';
    const publicListingIds = catalog.listPublicListingIds({ city, type: 'rent' });
    if (publicListingIds.length === 0) {
      return {
        mode: 'DRY_RUN', publicEligibleListings: 0, currentKhmer24Occurrences: 0,
        staleEligibleListings: 0, activeSavedFilters: 0, activeDirectInterestRequests: 0,
        wouldCheck: 0, skipReasons: {}, proposed: [],
      };
    }

    const placeholders = publicListingIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT l.id,l.public_ref,l.last_seen_at,l.availability_last_confirmed_at,
        (SELECT o.id FROM canonical_listing_source_occurrences o
          JOIN source_registry r ON r.id=o.source_registry_id
          WHERE o.listing_id=l.id AND o.is_current=1 AND r.source_type='KHMER24'
          ORDER BY o.last_seen_at DESC,o.id DESC LIMIT 1) AS occurrence_id,
        (SELECT o.source_url FROM canonical_listing_source_occurrences o
          JOIN source_registry r ON r.id=o.source_registry_id
          WHERE o.listing_id=l.id AND o.is_current=1 AND r.source_type='KHMER24'
          ORDER BY o.last_seen_at DESC,o.id DESC LIMIT 1) AS source_url,
        (SELECT o.next_check_at FROM canonical_listing_source_occurrences o
          JOIN source_registry r ON r.id=o.source_registry_id
          WHERE o.listing_id=l.id AND o.is_current=1 AND r.source_type='KHMER24'
          ORDER BY o.next_check_at ASC,o.id ASC LIMIT 1) AS next_check_at
      FROM canonical_listings l
      WHERE l.id IN (${placeholders})
      ORDER BY l.id ASC
    `).all(...publicListingIds) as unknown as ListingRow[];

    const filters = this.db.prepare(`
      SELECT f.id,f.type,f.min_price,f.max_price,f.bedrooms,f.locations,f.city
      FROM search_filters f JOIN users u ON u.id=f.user_id
      WHERE f.is_active=1 AND u.is_active=1
      ORDER BY f.id ASC
    `).all() as unknown as SavedFilterRow[];
    const directInterests = this.db.prepare(`
      SELECT id,listing_id FROM interest_requests WHERE status='active' ORDER BY id ASC
    `).all() as unknown as DirectInterestRow[];

    const signals = new Map<number, DemandSignal>();
    const signalFor = (listingId: number): DemandSignal => {
      const existing = signals.get(listingId);
      if (existing) return existing;
      const created: DemandSignal = { savedFilterIds: new Set(), directInterestRequestIds: new Set() };
      signals.set(listingId, created);
      return created;
    };

    for (const filter of filters) {
      const matches = catalog.searchProperties(filterOptions(filter, topN)).items;
      for (const match of matches) signalFor(match.id).savedFilterIds.add(filter.id);
    }
    const publicIds = new Set(publicListingIds);
    for (const interest of directInterests) {
      if (publicIds.has(interest.listing_id)) signalFor(interest.listing_id).directInterestRequestIds.add(interest.id);
    }

    const skipReasons: Record<string, number> = {};
    const skip = (reason: string) => { skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; };
    let staleEligibleListings = 0;
    let currentKhmer24Occurrences = 0;
    const proposed: CanonicalKhmer24FreshnessPlanItem[] = [];
    for (const row of rows) {
      if (row.occurrence_id === null || !row.source_url) {
        skip('no current Khmer24 occurrence');
        continue;
      }
      currentKhmer24Occurrences++;
      const latestEvidence = [row.last_seen_at, row.availability_last_confirmed_at]
        .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
      const age = daysSince(latestEvidence, now);
      if (age <= staleAfterDays) {
        skip('recently observed or confirmed');
        continue;
      }
      staleEligibleListings++;
      const demand = signals.get(row.id);
      if (row.next_check_at && Date.parse(row.next_check_at) > now.getTime()) {
        skip('next_check_at is in the future');
        continue;
      }
      const savedFilterCount = demand?.savedFilterIds.size ?? 0;
      const directInterestCount = demand?.directInterestRequestIds.size ?? 0;
      const reasons = [
        `last evidence ${Math.floor(age)} day(s) ago`,
        ...(directInterestCount
          ? [`exact Phase 7A interest request (${directInterestCount})`]
          : []),
        ...(savedFilterCount
          ? [`active saved-filter top-${topN} match (${savedFilterCount})`]
          : []),
      ];
      const priority = Math.min(100, 70 + Math.floor(age)
        + directInterestCount * 15 + savedFilterCount * 5);
      proposed.push({
        planKey: `k24:${row.occurrence_id}:${row.last_seen_at}`,
        listingId: row.id,
        publicRef: row.public_ref,
        occurrenceId: row.occurrence_id,
        sourceUrl: row.source_url,
        lastSeenAt: row.last_seen_at,
        priority,
        reasons,
      });
    }
    proposed.sort((a, b) => b.priority - a.priority || a.listingId - b.listingId);
    return {
      mode: 'DRY_RUN',
      publicEligibleListings: publicListingIds.length,
      currentKhmer24Occurrences,
      staleEligibleListings,
      activeSavedFilters: filters.length,
      activeDirectInterestRequests: directInterests.length,
      wouldCheck: proposed.length,
      skipReasons,
      proposed,
    };
  }
}

export type Khmer24FreshnessResult = 'ALIVE' | 'REMOVED' | 'UNKNOWN';

export interface CanonicalKhmer24FreshnessExecutionItem {
  planKey: string;
  listingId: number;
  occurrenceId: number;
  sourceUrl: string;
  result: Khmer24FreshnessResult;
  evidence: string;
  diagnostic?: Khmer24FetchDiagnostic;
  transport?: Omit<Khmer24TransportPage, 'html'>;
  applied: boolean;
  skippedReason?: string;
}

export interface CanonicalKhmer24FreshnessExecutionReport {
  disabled: boolean;
  checked: number;
  alive: number;
  removed: number;
  unknown: number;
  skipped: number;
  items: CanonicalKhmer24FreshnessExecutionItem[];
}

export interface CanonicalKhmer24FreshnessExecutorOptions {
  /** Zero is intentionally disabled. A future live caller must set an explicit cap. */
  maxItems?: number;
  minDelayMs?: number;
  now?: () => Date;
  /** Test-only override. Production rechecks use the Camoufox transport below. */
  fetchHtml?: (url: string) => Promise<string>;
  /** Allows a mocked browser transport in tests; executor owns and closes it. */
  transport?: Khmer24PageTransport;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Executes only an explicit plan. It uses a page-only guarded browser
 * transport, with no discovery, proxy, AI, or paid-provider path. A terminal
 * page is first recorded and scheduled for confirmation; only a second,
 * sufficiently separated terminal observation can end a source occurrence.
 */
export class CanonicalKhmer24FreshnessExecutor {
  constructor(private readonly db: DatabaseSync) {}

  async execute(
    plan: readonly CanonicalKhmer24FreshnessPlanItem[],
    options: CanonicalKhmer24FreshnessExecutorOptions = {},
  ): Promise<CanonicalKhmer24FreshnessExecutionReport> {
    const maxItems = options.maxItems ?? 0;
    if (!Number.isInteger(maxItems) || maxItems < 0) throw new Error('maxItems must be a non-negative integer');
    if (maxItems === 0) return { disabled: true, checked: 0, alive: 0, removed: 0, unknown: 0, skipped: 0, items: [] };
    const now = options.now ?? (() => new Date());
    const minDelayMs = Math.max(0, options.minDelayMs ?? 1_000);
    const items: CanonicalKhmer24FreshnessExecutionItem[] = [];
    // Do not use direct Node fetch here. Khmer24 consistently returns 403 to
    // that path; its historical successful transport is guarded Camoufox.
    let transport: Khmer24PageTransport | undefined;
    let transportOpenError: unknown;
    if (!options.fetchHtml) {
      try {
        transport = options.transport ?? await Khmer24CamoufoxTransport.open();
      } catch (error) {
        // A browser bootstrap failure is still a non-terminal source result.
        // Each supplied plan item is recorded as UNKNOWN rather than allowing
        // one runtime failure to abort a bounded batch.
        transportOpenError = error;
      }
    }
    const fetchHtml = options.fetchHtml ?? ((url: string) => {
      if (transportOpenError) return Promise.reject(transportOpenError);
      return transport!.fetchHtml(url);
    });
    try {
      for (const [index, item] of plan.slice(0, maxItems).entries()) {
        if (index > 0 && minDelayMs > 0) await wait(minDelayMs);
        const current = this.db.prepare(`
        SELECT o.id,o.listing_id,o.source_url,o.last_seen_at FROM canonical_listing_source_occurrences o
        JOIN source_registry r ON r.id=o.source_registry_id
        WHERE o.id=? AND o.listing_id=? AND o.is_current=1 AND r.source_type='KHMER24'
      `).get(item.occurrenceId, item.listingId) as { id: number; listing_id: number; source_url: string | null; last_seen_at: string } | undefined;
        if (!current || current.source_url !== item.sourceUrl || current.last_seen_at !== item.lastSeenAt) {
          items.push({ ...item, result: 'UNKNOWN', evidence: 'plan occurrence changed since review', applied: false, skippedReason: 'plan occurrence is no longer current' });
          continue;
        }
        if (this.alreadyApplied(item)) {
          items.push({ ...item, result: 'UNKNOWN', evidence: 'plan key already applied', applied: false, skippedReason: 'plan key already applied' });
          continue;
        }
        let result: Khmer24FreshnessResult = 'UNKNOWN';
        let evidence = 'ambiguous source document';
        let diagnostic: Khmer24FetchDiagnostic | undefined;
        let transportObservation: Omit<Khmer24TransportPage, 'html'> | undefined;
        try {
          const page = transport?.fetchPage ? await transport.fetchPage(item.sourceUrl) : undefined;
          if (page) {
            const { html: _html, ...safeObservation } = page;
            void _html;
            transportObservation = safeObservation;
          }
          const liveness = classifyKhmer24PageLiveness(page?.html ?? await fetchHtml(item.sourceUrl));
          result = liveness === 'alive' ? 'ALIVE' : liveness === 'dead' ? 'REMOVED' : 'UNKNOWN';
          evidence = transportObservation?.markers.challengeOrBlock
            ? 'Camoufox challenge/block page'
            : liveness === 'alive'
            ? 'valid Khmer24 Product JSON-LD'
            : liveness === 'dead'
              ? 'explicit Khmer24 terminal marker'
              : 'ambiguous source document';
        } catch (error) {
          diagnostic = describeKhmer24FetchFailure(error);
          // 404/410 are the only HTTP terminal semantics in this observational
          // rollout. All transport, challenge, and rate-limit outcomes remain UNKNOWN.
          if (diagnostic.http?.status === 404 || diagnostic.http?.status === 410) {
            result = 'REMOVED';
            evidence = `explicit terminal ${formatKhmer24FetchDiagnostic(diagnostic)}`;
          } else {
            evidence = `fetch failure: ${formatKhmer24FetchDiagnostic(diagnostic)}`;
          }
        }
        const applied = this.apply(item, result, now().toISOString(), diagnostic, transportObservation);
        items.push({ ...item, result, evidence, diagnostic, transport: transportObservation, applied });
      }
    } finally {
      if (transport) await transport.close().catch(() => {});
    }
    return {
      disabled: false,
      checked: items.filter((item) => item.applied).length,
      alive: items.filter((item) => item.applied && item.result === 'ALIVE').length,
      removed: items.filter((item) => item.applied && item.result === 'REMOVED').length,
      unknown: items.filter((item) => item.applied && item.result === 'UNKNOWN').length,
      skipped: items.filter((item) => !item.applied).length,
      items,
    };
  }

  private alreadyApplied(item: CanonicalKhmer24FreshnessPlanItem): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM availability_checks
      WHERE source_occurrence_id=? AND check_type='SOURCE_RECHECK' AND provider='KHMER24'
        AND json_extract(raw_response,'$.planKey')=? LIMIT 1
    `).get(item.occurrenceId, item.planKey));
  }

  private apply(
    item: CanonicalKhmer24FreshnessPlanItem,
    result: Khmer24FreshnessResult,
    checkedAt: string,
    diagnostic?: Khmer24FetchDiagnostic,
    transport?: Omit<Khmer24TransportPage, 'html'>,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(`
        SELECT l.availability_status,o.last_seen_at,o.consecutive_check_failures,
          o.consecutive_terminal_checks,o.terminal_check_last_seen_at,o.terminal_check_confirm_after_at
        FROM canonical_listings l
        JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
        JOIN source_registry r ON r.id=o.source_registry_id
        WHERE l.id=? AND o.id=? AND o.is_current=1 AND r.source_type='KHMER24'
      `).get(item.listingId, item.occurrenceId) as {
        availability_status: string | null;
        last_seen_at: string;
        consecutive_check_failures: number;
        consecutive_terminal_checks: number;
        terminal_check_last_seen_at: string | null;
        terminal_check_confirm_after_at: string | null;
      } | undefined;
      if (!current) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const prior = this.db.prepare(`
        SELECT 1 FROM availability_checks
        WHERE source_occurrence_id=? AND check_type='SOURCE_RECHECK' AND provider='KHMER24'
          AND json_extract(raw_response,'$.planKey')=? LIMIT 1
      `).get(item.occurrenceId, item.planKey);
      if (prior) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const transition = transitionKhmer24Freshness({
        lastSeenAt: current.last_seen_at,
        consecutiveCheckFailures: current.consecutive_check_failures,
        consecutiveTerminalChecks: current.consecutive_terminal_checks,
        terminalCheckLastSeenAt: current.terminal_check_last_seen_at,
        terminalCheckConfirmAfterAt: current.terminal_check_confirm_after_at,
      }, result, new Date(checkedAt));
      const nextStatus = transition.confirmsTerminalRemoval ? 'removed' : current.availability_status;
      const evidence = JSON.stringify({
        planKey: item.planKey,
        source: 'KHMER24_CAMOUFOX',
        observedResult: result,
        policy: {
          nextCheckAt: transition.nextCheckAt,
          consecutiveTerminalChecks: transition.consecutiveTerminalChecks,
          confirmationDueAt: transition.terminalCheckConfirmAfterAt,
          confirmsTerminalRemoval: transition.confirmsTerminalRemoval,
        },
        ...(diagnostic ? { diagnostic } : {}),
        ...(transport ? { transport } : {}),
      });
      this.db.prepare(`
        INSERT INTO availability_checks(listing_id,source_occurrence_id,check_type,provider,previous_status,new_status,result,checked_at,raw_response)
        VALUES(?,?,'SOURCE_RECHECK','KHMER24',?,?,?, ?,?)
      `).run(item.listingId, item.occurrenceId, current.availability_status, nextStatus, result, checkedAt, evidence);
      this.db.prepare(`
        UPDATE canonical_listing_source_occurrences SET last_checked_at=?,last_check_result=?,
          source_alive=CASE WHEN ?='ALIVE' THEN 1 ELSE source_alive END,
          next_check_at=?,consecutive_check_failures=?,consecutive_terminal_checks=?,
          terminal_check_last_seen_at=?,terminal_check_confirm_after_at=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?
      `).run(checkedAt, result, result, transition.nextCheckAt, transition.consecutiveCheckFailures,
        transition.consecutiveTerminalChecks, transition.terminalCheckLastSeenAt,
        transition.terminalCheckConfirmAfterAt, item.occurrenceId);
      if (result === 'ALIVE') {
        this.db.prepare(`
          UPDATE canonical_listings SET last_checked_at=?,availability_last_confirmed_at=?,
            availability_confirmed_by='KHMER24_TEXT_ONLY',availability_confidence=1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?
        `).run(checkedAt, checkedAt, item.listingId);
      } else if (!transition.confirmsTerminalRemoval) {
        this.db.prepare(`UPDATE canonical_listings SET last_checked_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
          .run(checkedAt, item.listingId);
      } else {
        // A source occurrence can end only after the second terminal page and
        // only if it was not naturally rediscovered in between. Keep a listing
        // visible when another current source still supports it.
        this.db.prepare(`UPDATE canonical_listing_source_occurrences SET is_current=0,ended_at=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(checkedAt, item.occurrenceId);
        const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM canonical_listing_source_occurrences
          WHERE listing_id=? AND is_current=1`).get(item.listingId) as { count: number };
        this.db.prepare(`UPDATE canonical_listings SET last_checked_at=?,availability_status=CASE WHEN ?=0 THEN 'removed' ELSE availability_status END,
          status=CASE WHEN ?=0 THEN 'inactive' ELSE status END,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
          .run(checkedAt, remaining.count, remaining.count, item.listingId);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction is already closed */ }
      throw error;
    }
  }
}
