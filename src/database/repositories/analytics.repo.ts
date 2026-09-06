import type { DatabaseSync } from 'node:sqlite';

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
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Tracks an analytical event from Telegram Bot or Mini App.
   */
  trackEvent(event: {
    userId?: number | null;
    telegramId?: number | null;
    eventType: string;
    metadata?: Record<string, unknown>;
  }): void {
    const metaStr = event.metadata ? JSON.stringify(event.metadata) : '{}';

    this.db.prepare(`
      INSERT INTO usage_events (user_id, telegram_id, event_type, metadata)
      VALUES (?, ?, ?, ?)
    `).run(
      event.userId ?? null,
      event.telegramId ?? null,
      event.eventType,
      metaStr,
    );
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

