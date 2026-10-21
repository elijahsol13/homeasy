import type { DatabaseSync } from 'node:sqlite';

export interface CanonicalPublicationEvent {
  id: number;
  listingId: number;
}

export interface CanonicalAlertDelivery {
  id: number;
  listingId: number;
  telegramId: number;
}

/**
 * Publication outbox and delivery claims share the application SQLite database.
 * Claiming is committed BEFORE calling Telegram. Failed/interrupted attempts
 * remain uncertain; Telegram has no exactly-once acknowledgement.
 */
export class CanonicalAlertsRepository {
  constructor(private readonly db: DatabaseSync) {}

  activate(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT activated_at FROM canonical_alert_rollout WHERE id=1')
        .get() as { activated_at: string | null } | undefined;
      if (!row) throw new Error('Canonical alert rollout migration is missing');
      if (!row.activated_at) {
        // Ignore historical approval events when alerts are first enabled.
        this.db.exec(`UPDATE canonical_alert_rollout
          SET activation_event_high_water=(SELECT COALESCE(MAX(id),0) FROM canonical_publication_events),
              activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
        this.db.exec(`UPDATE canonical_publication_events SET processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE processed_at IS NULL AND id<=(SELECT activation_event_high_water FROM canonical_alert_rollout WHERE id=1)`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Only retire claims stale for five minutes; another instance may still be sending. */
  markInterruptedUncertain(): number {
    return Number(this.db.prepare(`UPDATE canonical_alert_deliveries
      SET status='uncertain',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        last_error='Process stopped before Telegram acknowledgement'
      WHERE status='sending' AND julianday(claimed_at) < julianday('now','-5 minutes')`).run().changes);
  }

  materializeNext(resolveRecipients: (listingId: number) => number[]): CanonicalPublicationEvent | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.db.prepare(`SELECT id,listing_id AS listingId
        FROM canonical_publication_events WHERE processed_at IS NULL ORDER BY id LIMIT 1`)
        .get() as CanonicalPublicationEvent | undefined;
      if (event) {
        const add = this.db.prepare(`INSERT OR IGNORE INTO canonical_alert_deliveries(listing_id,telegram_id)
          VALUES(?,?)`);
        // Stable unique recipients. A failed recipient resolution rolls back the
        // whole materialization, allowing a later worker cycle to retry it.
        for (const telegramId of new Set(resolveRecipients(event.listingId))) {
          if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw new Error('Invalid Telegram recipient');
          add.run(event.listingId, telegramId);
        }
        this.db.prepare(`UPDATE canonical_publication_events
          SET processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(event.id);
      }
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimNext(excludeTelegramIds: number[] = []): CanonicalAlertDelivery | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exclusion = excludeTelegramIds.length
        ? `AND telegram_id NOT IN (${excludeTelegramIds.map(() => '?').join(',')})` : '';
      const next = this.db.prepare(`SELECT id FROM canonical_alert_deliveries
        WHERE status='pending' ${exclusion} ORDER BY id LIMIT 1`)
        .get(...excludeTelegramIds) as { id: number } | undefined;
      const claimed = next ? this.db.prepare(`UPDATE canonical_alert_deliveries
        SET status='sending',claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='pending' RETURNING id,listing_id AS listingId,telegram_id AS telegramId`)
        .get(next.id) as CanonicalAlertDelivery | undefined : undefined;
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(id: number, status: 'sent' | 'uncertain' | 'cancelled', error?: string): void {
    const result = this.db.prepare(`UPDATE canonical_alert_deliveries
      SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error=?
      WHERE id=? AND status='sending'`).run(status, error?.slice(0, 500) ?? null, id);
    if (!result.changes) throw new Error(`Canonical delivery ${id} is no longer claimed`);
  }
}
