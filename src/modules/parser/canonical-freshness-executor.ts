import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { applyCanonicalSourceCheckResult } from '../../database/repositories/canonical-source-check.repo';
import type { CanonicalSourceCheckDisposition } from '../../database/repositories/canonical-source-check.repo';
import type { LinkCheckResult, LinkVerifierService } from '../../services/link-verifier.service';
import { safeKhmer24Url } from './khmer24-url';
export { safeKhmer24Url } from './khmer24-url';

/** Explicit opt-in only. No scheduler, CLI or production process starts this worker. */
export type CanonicalFreshnessFetcher = (url: string, signal?: AbortSignal) => Promise<LinkCheckResult>;

interface PendingJob {
  id: number;
  listing_id: number;
  source_occurrence_id: number;
  status: 'QUEUED' | 'RUNNING';
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  observation_id: string | null;
  observation_checked_at: string | null;
  observation_outcome: 'ALIVE' | 'DEAD' | 'UNKNOWN' | null;
  observation_reason: string | null;
  is_current: number | null;
  source_entity_key: string | null;
  last_seen_at: string | null;
  next_check_at: string | null;
  listing_status: string | null;
  availability_status: string | null;
  source_type: string | null;
  occurrence_url: string | null;
  canonical_url: string | null;
  source_url: string | null;
}

export interface ClaimedFreshnessJob {
  id: number;
  occurrenceId: number;
  claimToken: string;
  url: string;
  /** A crash after recording this outcome must replay it, without another fetch. */
  recorded: { observationId: string; checkedAt: string; outcome: 'ALIVE' | 'DEAD' | 'UNKNOWN'; reason: string } | null;
}

export type FreshnessExecutionResult =
  | { status: 'dry_run'; jobId: number | null; url?: string }
  | { status: 'idle' }
  | { status: 'cancelled' | 'failed' | 'lost_claim'; jobId: number; reason?: string }
  | { status: 'completed'; jobId: number; disposition: CanonicalSourceCheckDisposition; replayed: boolean }
  | { status: 'retry_scheduled'; jobId: number };

function eligible(job: PendingJob, at: string): { url: string | null; reason: string | null } {
  if (job.is_current !== 1 || job.source_entity_key !== 'canonical-dedupe-v1' || job.listing_status !== 'active' ||
    ['removed', 'rented'].includes(job.availability_status ?? '')) {
    return { url: null, reason: 'canonical source no longer current or active' };
  }
  if (job.source_type !== 'KHMER24') return { url: null, reason: 'provider/source type mismatch' };
  if (job.last_seen_at && Date.parse(job.last_seen_at) > Date.parse(job.scheduled_at)) {
    return { url: null, reason: 'source naturally rediscovered after queueing' };
  }
  if (job.next_check_at && Date.parse(job.next_check_at) > Date.parse(at)) {
    return { url: null, reason: 'confirmation is not due' };
  }
  const url = safeKhmer24Url(job.occurrence_url ?? job.canonical_url ?? job.source_url);
  return url ? { url, reason: null } : { url: null, reason: 'missing or untrusted Khmer24 URL' };
}

/** Only KHMER24, free SOURCE_RECHECK jobs; paid and human confirmation must use separate gated workers. */
export class CanonicalFreshnessExecutor {
  constructor(private readonly db: DatabaseSync, private readonly options: {
    enabled?: boolean;
    fetcher?: CanonicalFreshnessFetcher;
    now?: () => Date;
    leaseMs?: number;
    /** Restrict a supervised run to explicitly staged jobs, never inherited queue entries. */
    onlyJobIds?: readonly number[];
  } = {}) {
    if (options.onlyJobIds && (options.onlyJobIds.length > 25 ||
      options.onlyJobIds.some((id) => !Number.isSafeInteger(id) || id < 1 ||
        options.onlyJobIds!.filter((value) => value === id).length !== 1))) {
      throw new Error('onlyJobIds must contain at most 25 distinct positive job IDs');
    }
  }

  private now(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }

  private select(at: string): PendingJob | undefined {
    if (this.options.onlyJobIds?.length === 0) return undefined;
    const allowed = this.options.onlyJobIds;
    const allowSql = allowed ? ` AND j.id IN (${allowed.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT j.id,j.listing_id,j.source_occurrence_id,j.status,j.attempts,j.max_attempts,
        j.scheduled_at,j.observation_id,j.observation_checked_at,j.observation_outcome,j.observation_reason,
        o.is_current,o.source_entity_key,o.last_seen_at,o.next_check_at,
        l.status AS listing_status,l.availability_status,r.source_type,
        o.source_url AS occurrence_url,s.canonical_url,s.source_url
      FROM freshness_jobs j
      LEFT JOIN canonical_listing_source_occurrences o ON o.id=j.source_occurrence_id AND o.listing_id=j.listing_id
      LEFT JOIN source_items s ON s.id=o.source_item_id
      LEFT JOIN source_registry r ON r.id=o.source_registry_id
      LEFT JOIN canonical_listings l ON l.id=j.listing_id
      WHERE j.provider='KHMER24' AND j.check_type='SOURCE_RECHECK' AND COALESCE(j.estimated_records,0)=0
        ${allowSql}
        AND j.source_occurrence_id IS NOT NULL
        AND ((j.status='QUEUED' AND julianday(COALESCE(j.retry_at,j.scheduled_at))<=julianday(?))
          OR (j.status='RUNNING' AND (j.lease_until IS NULL OR julianday(j.lease_until)<=julianday(?))))
      ORDER BY CASE WHEN j.observation_id IS NOT NULL THEN 0 ELSE 1 END,
        j.priority DESC,j.scheduled_at,j.id LIMIT 1`).get(...(allowed ?? []), at, at) as PendingJob | undefined;
  }

  /** Transactional claim and fencing token, including expired-job recovery. */
  claimNext(): ClaimedFreshnessJob | { id: number; reason: string; status: 'cancelled' | 'failed' } | null {
    const at = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.select(at);
      if (!row) { this.db.exec('COMMIT'); return null; }
      const { url, reason } = eligible(row, at);
      const recorded = Boolean(row.observation_id && row.observation_checked_at && row.observation_outcome);
      if (!recorded && (reason || row.attempts >= row.max_attempts)) {
        const status = reason ? 'CANCELLED' : 'FAILED';
        this.db.prepare(`UPDATE freshness_jobs SET status=?,finished_at=?,result=?,claim_token=NULL,lease_until=NULL,
          updated_at=? WHERE id=?`).run(status, at, reason ?? 'retry limit exceeded', at, row.id);
        this.db.exec('COMMIT');
        return { id: row.id, status: reason ? 'cancelled' : 'failed', reason: reason ?? 'retry limit exceeded' };
      }
      // A stored result remains eligible for replay even if the source was rediscovered.
      // applyCanonicalSourceCheckResult will reject a stale or replaced binding.
      const token = randomUUID();
      const leaseMs = this.options.leaseMs ?? 60_000;
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
      const expires = new Date(Date.parse(at) + leaseMs).toISOString();
      this.db.prepare(`UPDATE freshness_jobs SET status='RUNNING',started_at=COALESCE(started_at,?),
        attempts=attempts+?,claim_token=?,lease_until=?,updated_at=? WHERE id=?`)
        .run(at, recorded ? 0 : 1, token, expires, at, row.id);
      this.db.exec('COMMIT');
      return { id: row.id, occurrenceId: row.source_occurrence_id, claimToken: token,
        url: url ?? '', recorded: recorded ? { observationId: row.observation_id!, checkedAt: row.observation_checked_at!,
          outcome: row.observation_outcome!, reason: row.observation_reason ?? '' } : null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Durable observation boundary: a later replay uses exactly these immutable values. */
  recordObservation(claim: ClaimedFreshnessJob, result: LinkCheckResult, at = this.now()): boolean {
    if (!['ALIVE', 'DEAD', 'UNKNOWN'].includes(result.outcome)) throw new Error('Invalid source outcome');
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid observation timestamp');
    const observationId = randomUUID();
    const update = this.db.prepare(`UPDATE freshness_jobs SET observation_id=?,observation_checked_at=?,
      observation_outcome=?,observation_reason=?,updated_at=?
      WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_until>? AND observation_id IS NULL`)
      .run(observationId, new Date(at).toISOString(), result.outcome, (result.reason ?? '').slice(0, 2000), at,
        claim.id, claim.claimToken, at);
    return update.changes === 1;
  }

  /** Applies persisted data and finishes the job in a single transaction. */
  settle(claim: ClaimedFreshnessJob): FreshnessExecutionResult {
    const at = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT observation_id,observation_checked_at,observation_outcome,observation_reason
        FROM freshness_jobs WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_until>?`)
        .get(claim.id, claim.claimToken, at) as PendingJob | undefined;
      if (!row || !row.observation_id || !row.observation_checked_at || !row.observation_outcome) {
        this.db.exec('COMMIT'); return { status: 'lost_claim', jobId: claim.id };
      }
      const disposition = applyCanonicalSourceCheckResult(this.db, {
        occurrenceId: claim.occurrenceId, observationId: row.observation_id,
        checkedAt: row.observation_checked_at, outcome: row.observation_outcome,
        reason: row.observation_reason ?? '',
      });
      const status = ['stale', 'not_current'].includes(disposition) ? 'CANCELLED' : 'DONE';
      this.db.prepare(`UPDATE freshness_jobs SET status=?,result=?,finished_at=?,actual_cost=0,
        claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=?`)
        .run(status, disposition, at, at, claim.id, claim.claimToken);
      this.db.exec('COMMIT');
      return { status: 'completed', jobId: claim.id, disposition, replayed: claim.recorded !== null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private failFetch(claim: ClaimedFreshnessJob, error: unknown): FreshnessExecutionResult {
    const at = this.now();
    const record = this.db.prepare('SELECT attempts,max_attempts FROM freshness_jobs WHERE id=?').get(claim.id) as
      { attempts: number; max_attempts: number };
    const terminal = record.attempts >= record.max_attempts;
    const next = new Date(Date.parse(at) + 5 * 60_000 * Math.max(1, record.attempts)).toISOString();
    const result = this.db.prepare(`UPDATE freshness_jobs SET status=?,retry_at=?,finished_at=?,
      result=?,claim_token=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_until>? AND observation_id IS NULL`)
      .run(terminal ? 'FAILED' : 'QUEUED', next, terminal ? at : null,
        `fetch error: ${String(error instanceof Error ? error.message : error).slice(0, 250)}`,
        at, claim.id, claim.claimToken, at);
    return result.changes ? { status: terminal ? 'failed' : 'retry_scheduled', jobId: claim.id }
      : { status: 'lost_claim', jobId: claim.id };
  }

  async runOne(): Promise<FreshnessExecutionResult> {
    if (!this.options.enabled) {
      const row = this.select(this.now());
      return { status: 'dry_run', jobId: row?.id ?? null,
        ...(row ? { url: eligible(row, this.now()).url ?? undefined } : {}) };
    }
    if (!this.options.fetcher) throw new Error('Canonical freshness execution requires an explicit fetcher');
    const claim = this.claimNext();
    if (!claim) return { status: 'idle' };
    if ('status' in claim) return { status: claim.status, jobId: claim.id, reason: claim.reason };
    if (claim.recorded) return this.settle(claim);
    let response: LinkCheckResult;
    try { response = await this.options.fetcher(claim.url); }
    catch (error) { return this.failFetch(claim, error); }
    if (!this.recordObservation(claim, response)) return { status: 'lost_claim', jobId: claim.id };
    return this.settle(claim);
  }
}

/** Reuses the existing HTTP probe. Callers must explicitly enable execution. */
export function canonicalKhmer24Fetcher(verifier: LinkVerifierService): CanonicalFreshnessFetcher {
  return (url, signal) => verifier.checkCanonicalKhmer24(url, signal);
}
