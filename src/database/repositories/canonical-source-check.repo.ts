import type { DatabaseSync } from 'node:sqlite';

export interface CanonicalSourceCheckInput {
  occurrenceId: number;
  /** One identity per physical fetch, reused for every retry of its result. */
  observationId: string;
  checkedAt: string;
  outcome: 'ALIVE' | 'DEAD' | 'UNKNOWN';
  reason?: string;
}

export type CanonicalSourceCheckDisposition =
  | 'recorded' | 'pending_confirmation' | 'source_closed'
  | 'duplicate' | 'stale' | 'not_current';

interface OccurrenceRow {
  id: number;
  listing_id: number | null;
  source_item_id: number;
  source_type: string;
  is_current: number;
  last_seen_at: string;
  last_checked_at: string | null;
  consecutive_terminal_checks: number;
  terminal_check_last_seen_at: string | null;
  terminal_check_confirm_after_at: string | null;
  availability_status: string | null;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function timestamp(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid check timestamp: ${value}`);
  return ms;
}

/**
 * Applies an already obtained link-check result to exactly one canonical source
 * occurrence. No HTTP requests, legacy ingestion, or publication side effects.
 * Calling with an old occurrence ID cannot affect its replacement binding.
 */
export function applyCanonicalSourceCheckResult(
  db: DatabaseSync,
  input: CanonicalSourceCheckInput,
): CanonicalSourceCheckDisposition {
  if (!Number.isSafeInteger(input.occurrenceId) || input.occurrenceId <= 0) {
    throw new Error('A positive occurrenceId is required');
  }
  if (typeof input.observationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.observationId)) {
    throw new Error('A stable observationId (1-128 safe characters) is required');
  }
  if (!['ALIVE', 'DEAD', 'UNKNOWN'].includes(input.outcome)) throw new Error('Unsupported check outcome');
  const observedMs = timestamp(input.checkedAt);
  const checkedAt = new Date(observedMs).toISOString();

  // BEGIN IMMEDIATE serializes readers of the confirmation state with writers.
  // If a caller already owns a transaction, the savepoint stays inside it.
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT canonical_source_check' : 'BEGIN IMMEDIATE');
  try {
    const occurrence = db.prepare(`SELECT o.id,o.listing_id,o.source_item_id,o.is_current,
        o.last_seen_at,o.last_checked_at,o.consecutive_terminal_checks,
        o.terminal_check_last_seen_at,o.terminal_check_confirm_after_at,
        r.source_type,l.availability_status
      FROM canonical_listing_source_occurrences o
      JOIN source_registry r ON r.id=o.source_registry_id
      LEFT JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.id=?`).get(input.occurrenceId) as OccurrenceRow | undefined;

    let disposition: CanonicalSourceCheckDisposition;
    const previousObservation = db.prepare(`SELECT source_occurrence_id FROM availability_checks
      WHERE observation_id=?`).get(input.observationId) as { source_occurrence_id: number | null } | undefined;
    if (previousObservation && previousObservation.source_occurrence_id !== input.occurrenceId) {
      throw new Error('observationId already belongs to a different occurrence');
    }
    if (previousObservation) {
      disposition = 'duplicate';
    } else if (!occurrence || !occurrence.is_current || occurrence.listing_id === null) {
      disposition = 'not_current';
    } else {
      const latest = db.prepare(`SELECT checked_at FROM availability_checks
        WHERE source_occurrence_id=? AND check_type='SOURCE_RECHECK'
        ORDER BY julianday(checked_at) DESC,id DESC LIMIT 1`).get(input.occurrenceId) as { checked_at: string } | undefined;
      const lastLinkCheck = Math.max(
        occurrence.last_checked_at ? timestamp(occurrence.last_checked_at) : -Infinity,
        latest ? timestamp(latest.checked_at) : -Infinity,
      );
      const naturalSeen = timestamp(occurrence.last_seen_at);
      if (observedMs === lastLinkCheck) {
        disposition = 'duplicate';
      } else if (observedMs < lastLinkCheck || observedMs <= naturalSeen) {
        disposition = 'stale';
      } else {
        const khmer24 = occurrence.source_type === 'KHMER24';
        // Anonymous Facebook checks and other unconfirmed provider removals
        // must never be treated as proof that the listing was removed.
        const result = input.outcome === 'DEAD' && khmer24 ? 'REMOVED'
          : input.outcome === 'ALIVE' ? 'ALIVE' : 'UNKNOWN';
        const priorCount = occurrence.consecutive_terminal_checks;
        const naturalSinceFirst = priorCount > 0 && (
          !occurrence.terminal_check_last_seen_at ||
          timestamp(occurrence.terminal_check_last_seen_at) !== naturalSeen
        );
        const nextConfirmation = occurrence.terminal_check_confirm_after_at;
        const isConfirmed = result === 'REMOVED' && priorCount > 0 && !naturalSinceFirst &&
          nextConfirmation !== null && observedMs >= timestamp(nextConfirmation);
        const isPending = result === 'REMOVED' && !isConfirmed;
        const confirmAfter = isPending
          ? naturalSinceFirst || !nextConfirmation ? new Date(observedMs + SIX_HOURS_MS).toISOString() : nextConfirmation
          : null;
        const terminalCount = isConfirmed ? 2 : isPending ? 1 : 0;

        db.prepare(`UPDATE canonical_listing_source_occurrences SET
          last_checked_at=?,last_check_result=?,
          source_alive=CASE WHEN ?='ALIVE' THEN 1 WHEN ?=1 THEN 0 ELSE NULL END,
          consecutive_check_failures=CASE WHEN ?='ALIVE' THEN 0 WHEN ?='REMOVED' THEN consecutive_check_failures+1 ELSE consecutive_check_failures END,
          consecutive_terminal_checks=?,terminal_check_last_seen_at=?,terminal_check_confirm_after_at=?,
          next_check_at=CASE WHEN ?=1 THEN ? WHEN consecutive_terminal_checks>0 THEN NULL ELSE next_check_at END,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id=? AND listing_id=? AND is_current=1`)
          .run(checkedAt, result, result, isConfirmed ? 1 : 0, result, result,
            terminalCount, isPending ? occurrence.last_seen_at : null, confirmAfter,
            isPending ? 1 : 0, confirmAfter, occurrence.id, occurrence.listing_id);

        db.prepare(`INSERT INTO availability_checks
          (listing_id,source_occurrence_id,check_type,provider,previous_status,new_status,result,checked_at,raw_response,observation_id)
          VALUES(?,?,'SOURCE_RECHECK',?,?,?,?,?,?,?)`)
          .run(occurrence.listing_id, occurrence.id, khmer24 ? 'KHMER24' : occurrence.source_type,
            occurrence.availability_status, occurrence.availability_status, result, checkedAt,
            (input.reason ?? '').slice(0, 2000), input.observationId);

        if (isConfirmed) {
          db.prepare(`UPDATE canonical_listing_source_occurrences SET is_current=0,ended_at=?,next_check_at=NULL
            WHERE id=? AND listing_id=? AND source_item_id=? AND is_current=1`)
            .run(checkedAt, occurrence.id, occurrence.listing_id, occurrence.source_item_id);
          db.prepare(`UPDATE canonical_listings SET primary_source_occurrence_id=(
              SELECT o.id FROM canonical_listing_source_occurrences o
              JOIN source_items s ON s.id=o.source_item_id
              WHERE o.listing_id=? AND o.is_current=1
              ORDER BY COALESCE(julianday(o.posted_at),julianday(s.published_at)) IS NULL,
                COALESCE(julianday(o.posted_at),julianday(s.published_at)),julianday(o.first_seen_at),o.id LIMIT 1),
              status=CASE WHEN status='active' AND NOT EXISTS(
                SELECT 1 FROM canonical_listing_source_occurrences o WHERE o.listing_id=? AND o.is_current=1
              ) THEN 'inactive' ELSE status END,
              updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
            .run(occurrence.listing_id, occurrence.listing_id, occurrence.listing_id);
        }
        disposition = isConfirmed ? 'source_closed' : isPending ? 'pending_confirmation' : 'recorded';
      }
    }
    db.exec(nested ? 'RELEASE canonical_source_check' : 'COMMIT');
    return disposition;
  } catch (error) {
    if (nested) {
      db.exec('ROLLBACK TO canonical_source_check');
      db.exec('RELEASE canonical_source_check');
    } else {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
