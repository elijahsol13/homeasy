import type { DatabaseSync } from 'node:sqlite';
import { PostHog } from 'posthog-node';
import { env } from '../../config/env';

export interface UsageEventRecord {
  id?: number;
  user_id?: number | null;
  telegram_id?: number | null;
  event_type: string;
  metadata: string;
  created_at?: string;
}

export interface AnalyticsSummary {
  activeUsers: number;
  totalEvents: number;
  eventBreakdown: Record<string, number>;
}

export class AnalyticsRepository {
  private posthog: PostHog | null = null;

  constructor(private readonly db: DatabaseSync) {
    const apiKey = env.POSTHOG_API_KEY || process.env.POSTHOG_API_KEY;
    if (apiKey) {
      try {
        this.posthog = new PostHog(apiKey, {
          host: env.POSTHOG_HOST || process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
          flushAt: 10,
          flushInterval: 5000,
        });
      } catch (err) {
        console.warn('[Analytics] Failed to initialize PostHog client:', err);
      }
    }
  }

  /**
   * Tracks an analytical event synchronously to SQLite and asynchronously to PostHog.
   */
  trackEvent(event: {
    userId?: number | null;
    telegramId?: number | null;
    eventType: string;
    metadata?: Record<string, unknown>;
  }): void {
    const metaStr = event.metadata ? JSON.stringify(event.metadata) : '{}';

    try {
      this.db.prepare(`
        INSERT INTO usage_events (user_id, telegram_id, event_type, metadata)
        VALUES (?, ?, ?, ?)
      `).run(
        event.userId ?? null,
        event.telegramId ?? null,
        event.eventType,
        metaStr,
      );
    } catch (err) {
      console.warn('[Analytics] SQLite trackEvent error:', err);
    }

    if (this.posthog && event.telegramId) {
      try {
        this.posthog.capture({
          distinctId: String(event.telegramId),
          event: event.eventType,
          properties: {
            ...event.metadata,
            userId: event.userId,
          },
        });
      } catch (err) {
        console.warn('[Analytics] PostHog capture error:', err);
      }
    }
  }

  /**
   * Flushes pending events and gracefully shuts down the PostHog client.
   */
  async shutdown(): Promise<void> {
    if (this.posthog) {
      try {
        await this.posthog.shutdown();
      } catch (err) {
        console.warn('[Analytics] Error shutting down PostHog client:', err);
      }
    }
  }

  /**
   * Returns active users count and event breakdown for the given hours window.
   */
  getSummary(hoursBack: number): AnalyticsSummary {
    const userRow = this.db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(telegram_id, user_id)) as activeCount
      FROM usage_events
      WHERE datetime(created_at) >= datetime('now', '-' || ? || ' hours')
    `).get(hoursBack) as unknown as { activeCount: number };

    const activeUsers = Number(userRow?.activeCount ?? 0);

    const eventRows = this.db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM usage_events
      WHERE datetime(created_at) >= datetime('now', '-' || ? || ' hours')
      GROUP BY event_type
    `).all(hoursBack) as unknown as { event_type: string; count: number }[];

    const eventBreakdown: Record<string, number> = {};
    let totalEvents = 0;

    for (const r of eventRows) {
      const c = Number(r.count);
      eventBreakdown[r.event_type] = c;
      totalEvents += c;
    }

    return {
      activeUsers,
      totalEvents,
      eventBreakdown,
    };
  }

  /**
   * Gets distinct active users in the past 24 hours.
   */
  get24hActiveUsersCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(telegram_id, user_id)) as count
      FROM usage_events
      WHERE datetime(created_at) >= datetime('now', '-24 hours')
    `).get() as unknown as { count: number };

    return Number(row?.count ?? 0);
  }
}

