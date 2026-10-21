import { env } from '../config/env';
import { RATE_LIMIT } from '../config/settings';
import type { CanonicalReviewAlertsRepository } from '../database/repositories/canonical-review-alerts.repo';
import type { AlertService } from './alert.service';

/** Only the chosen Telegram process runs this sender, never the scraper. */
export class CanonicalReviewAlertsService {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private readonly lastAttemptAt = new Map<number, number>();

  constructor(
    private readonly repo: CanonicalReviewAlertsRepository,
    private readonly alert: AlertService,
    private readonly adminIds: number[] = env.ADMIN_IDS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.repo.activate();
    const interrupted = this.repo.markInterruptedUncertain();
    if (interrupted) console.warn(`[CanonicalReviewAlerts] ${interrupted} interrupted send(s) uncertain`);
    if (this.adminIds.length === 0) console.warn('[CanonicalReviewAlerts] No ADMIN_IDS configured');
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => console.error('[CanonicalReviewAlerts] Worker tick failed:', err));
    }, RATE_LIMIT.QUEUE_TICK_MS);
    this.timer.unref();
    void this.tick().catch((err: unknown) => console.error('[CanonicalReviewAlerts] Startup tick failed:', err));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  tick(): Promise<void> {
    if (this.current) return this.current;
    this.current = this.processOne().finally(() => { this.current = null; });
    return this.current;
  }

  private async processOne(): Promise<void> {
    this.repo.markInterruptedUncertain();
    this.repo.materializeNext(this.adminIds);
    const now = Date.now();
    for (const [id, time] of this.lastAttemptAt) {
      if (now - time > 60_000) this.lastAttemptAt.delete(id);
    }
    const blocked = [...this.lastAttemptAt].filter(([, time]) =>
      now - time < RATE_LIMIT.PER_USER_INTERVAL_MS).map(([id]) => id);
    const claim = this.repo.claimNext(blocked);
    if (!claim) return;
    this.lastAttemptAt.set(claim.telegramId, Date.now());
    const summary = this.repo.listingSummary(claim.listingId);
    if (!summary || !this.repo.isPending(claim.listingId)) {
      this.repo.finish(claim.id, 'cancelled', 'Listing no longer awaits moderation');
      return;
    }
    try {
      await this.alert.sendCanonicalPending(claim.telegramId, summary.title, summary.publicRef);
      this.repo.finish(claim.id, 'sent');
    } catch (err: unknown) {
      // A timeout may mean Telegram accepted the message. Never resend
      // automatically after a request with an ambiguous outcome.
      const reason = err instanceof Error ? err.message : String(err);
      this.repo.finish(claim.id, 'uncertain', reason);
      console.warn(`[CanonicalReviewAlerts] Delivery ${claim.id} uncertain: ${reason}`);
    }
  }
}
