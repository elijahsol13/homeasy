import type { DatabaseSync } from 'node:sqlite';

export interface CanonicalReviewAlertDelivery {
  id: number;
  listingId: number;
  telegramId: number;
}

/** Durable per-administrator outbox. Telegram cannot guarantee exactly-once delivery. */
export class CanonicalReviewAlertsRepository {
  constructor(private readonly db: DatabaseSync) {}

  activate(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rollout = this.db.prepare('SELECT activated_at FROM canonical_review_alert_rollout WHERE id=1')
        .get() as { activated_at: string | null } | undefined;
      if (!rollout) throw new Error('Canonical review alert migration is missing');
      if (!rollout.activated_at) {
        this.db.exec(`UPDATE canonical_review_alert_rollout SET
          listing_high_water=(SELECT COALESCE(MAX(id),0) FROM canonical_listings),
          source_item_high_water=(SELECT COALESCE(MAX(id),0) FROM source_items),
          activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Called by canonical persistence inside its SAVEPOINT, after legacy status reconciliation. */
  recordNewPending(): number {
    return Number(this.db.prepare(`INSERT OR IGNORE INTO canonical_review_alert_events(listing_id)
      SELECT DISTINCT l.id FROM canonical_listings l
      JOIN canonical_listing_moderation m ON m.listing_id=l.id AND m.review_status='pending'
      JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id AND o.is_current=1
      JOIN source_items s ON s.id=o.source_item_id AND s.classification='HOUSING_SUPPLY'
      JOIN processing_runs pr ON pr.id=s.processing_run_id AND pr.run_type='DISCOVERY'
      JOIN canonical_review_alert_rollout r ON r.id=1
      WHERE r.activated_at IS NOT NULL
        AND l.id > r.listing_high_water AND s.id > r.source_item_high_water
        AND julianday(s.created_at)>=julianday(strftime('%Y-%m-%dT%H:%M:%SZ',r.activated_at))
        AND julianday(s.first_seen_at)>=julianday(strftime('%Y-%m-%dT%H:%M:%SZ',r.activated_at))
        AND julianday(pr.started_at)>=julianday(strftime('%Y-%m-%dT%H:%M:%SZ',r.activated_at))
        AND l.status='active'
        AND COALESCE(l.availability_status,'unknown') NOT IN ('removed','rented')`).run().changes);
  }

  markInterruptedUncertain(): number {
    return Number(this.db.prepare(`UPDATE canonical_review_alert_deliveries
      SET status='uncertain',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        last_error='Process stopped before Telegram acknowledgement'
      WHERE status='sending' AND julianday(claimed_at) < julianday('now','-5 minutes')`).run().changes);
  }

  /** An empty recipient list does not consume a pending event. */
  materializeNext(recipients: number[]): number | undefined {
    const ids = [...new Set(recipients)];
    if (!ids.length) return undefined;
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid admin Telegram ID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.db.prepare(`SELECT id,listing_id AS listingId
        FROM canonical_review_alert_events WHERE processed_at IS NULL ORDER BY id LIMIT 1`)
        .get() as { id: number; listingId: number } | undefined;
      if (event) {
        if (this.isPending(event.listingId)) {
          const insert = this.db.prepare(`INSERT OR IGNORE INTO canonical_review_alert_deliveries(event_id,telegram_id)
            VALUES(?,?)`);
          for (const id of ids) insert.run(event.id, id);
        }
        this.db.prepare(`UPDATE canonical_review_alert_events
          SET processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(event.id);
      }
      this.db.exec('COMMIT');
      return event?.id;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  isPending(listingId: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM canonical_listings l
      JOIN canonical_listing_moderation m ON m.listing_id=l.id
      WHERE l.id=? AND m.review_status='pending' AND l.status='active'
        AND COALESCE(l.availability_status,'unknown') NOT IN ('removed','rented')`).get(listingId));
  }

  claimNext(excludeTelegramIds: number[] = []): CanonicalReviewAlertDelivery | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exclude = excludeTelegramIds.length
        ? `AND d.telegram_id NOT IN (${excludeTelegramIds.map(() => '?').join(',')})` : '';
      const next = this.db.prepare(`SELECT d.id FROM canonical_review_alert_deliveries d
        WHERE d.status='pending' ${exclude} ORDER BY d.id LIMIT 1`)
        .get(...excludeTelegramIds) as { id: number } | undefined;
      const claim = next ? this.db.prepare(`UPDATE canonical_review_alert_deliveries
        SET status='sending',claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='pending' RETURNING id,telegram_id AS telegramId,event_id AS eventId`)
        .get(next.id) as { id: number; telegramId: number; eventId: number } | undefined : undefined;
      const result = claim ? this.db.prepare('SELECT listing_id AS listingId FROM canonical_review_alert_events WHERE id=?')
        .get(claim.eventId) as { listingId: number } : undefined;
      this.db.exec('COMMIT');
      return claim && result ? { id: claim.id, telegramId: claim.telegramId, listingId: result.listingId } : undefined;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listingSummary(listingId: number): { title: string; publicRef: string } | undefined {
    return this.db.prepare('SELECT title,public_ref AS publicRef FROM canonical_listings WHERE id=?')
      .get(listingId) as { title: string; publicRef: string } | undefined;
  }

  finish(id: number, status: 'sent' | 'uncertain' | 'cancelled', error?: string): void {
    const done = this.db.prepare(`UPDATE canonical_review_alert_deliveries
      SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error=?
      WHERE id=? AND status='sending'`).run(status, error?.slice(0, 500) ?? null, id);
    if (!done.changes) throw new Error(`Canonical review delivery ${id} is no longer claimed`);
  }
}
