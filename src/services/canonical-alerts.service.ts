import { RATE_LIMIT } from '../config/settings';
import { listingReadPathForUser } from '../modules/api/listing-read-path';
import type { CanonicalAlertsRepository } from '../database/repositories/canonical-alerts.repo';
import type { CanonicalListingRepository } from '../database/repositories/canonical-listing.repo';
import type { MatcherService } from '../modules/matcher/matcher';
import type { NotifierService } from './notifier';

/** Runs only inside the chosen Telegram process (bot in polling, API in webhook). */
export class CanonicalAlertsService {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private readonly lastAttemptAt = new Map<number, number>();

  constructor(
    private readonly repo: CanonicalAlertsRepository,
    private readonly listings: CanonicalListingRepository,
    private readonly matcher: MatcherService,
    private readonly notifier: NotifierService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.repo.activate();
    const interrupted = this.repo.markInterruptedUncertain();
    if (interrupted) console.warn(`[CanonicalAlerts] ${interrupted} interrupted attempt(s) marked uncertain`);
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => console.error('[CanonicalAlerts] Worker tick failed:', err));
    }, RATE_LIMIT.QUEUE_TICK_MS);
    this.timer.unref();
    void this.tick().catch((err: unknown) => console.error('[CanonicalAlerts] Startup tick failed:', err));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Public for deterministic tests with a fake Telegram API. */
  tick(): Promise<void> {
    if (this.current) return this.current;
    this.current = this.processOne().finally(() => { this.current = null; });
    return this.current;
  }

  private async processOne(): Promise<void> {
    this.repo.markInterruptedUncertain();
    this.repo.materializeNext((listingId) => {
      const property = this.listings.getPropertyById(listingId);
      if (!property) return [];
      return this.matcher.matchProperty(property)
        .filter(({ telegramId }) => listingReadPathForUser(telegramId) === 'canonical')
        .map(({ telegramId }) => telegramId);
    });

    const now = Date.now();
    for (const [id, time] of this.lastAttemptAt) {
      if (now - time > 60_000) this.lastAttemptAt.delete(id);
    }
    const blocked = [...this.lastAttemptAt].filter(([, time]) =>
      now - time < RATE_LIMIT.PER_USER_INTERVAL_MS).map(([id]) => id);
    const claim = this.repo.claimNext(blocked);
    if (!claim) return;
    this.lastAttemptAt.set(claim.telegramId, Date.now());

    try {
      // Preferences, moderation and source availability may change between
      // materialization and sending. Re-evaluate every one before Telegram.
      const property = this.listings.getPropertyById(claim.listingId);
      const stillEligible = property
        && listingReadPathForUser(claim.telegramId) === 'canonical'
        && this.matcher.matchProperty(property).some((u) => u.telegramId === claim.telegramId);
      if (!property || !stillEligible) {
        this.repo.finish(claim.id, 'cancelled', 'Listing unavailable, filter changed or alerts paused');
        return;
      }
      // Exactly one Telegram API request for this claim. No photo/media-group
      // fallback: a timeout after successful acceptance must not create a duplicate.
      await this.notifier.sendCanonicalAlert(claim.telegramId, property);
      this.repo.finish(claim.id, 'sent');
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.repo.finish(claim.id, 'uncertain', reason);
      console.warn(`[CanonicalAlerts] Delivery ${claim.id} uncertain: ${reason}`);
    }
  }
}
