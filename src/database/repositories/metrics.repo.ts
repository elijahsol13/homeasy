import type { DatabaseSync } from 'node:sqlite';

export interface ScraperMetricRecord {
  id?: number;
  service: 'khmer24' | 'facebook';
  total_scraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
  proxy_used?: string | null;
  duration_ms?: number;
  created_at?: string;
}

export interface MetricsSummary {
  runsCount: number;
  totalScraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
}

export class MetricsRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Persists a completed scraper run into the database.
   */
  recordScraperRun(metric: {
    service: 'khmer24' | 'facebook';
    total_scraped: number;
    inserted: number;
    duplicates: number;
    errors: number;
    proxy_used?: string | null;
    duration_ms?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO scraper_metrics (
        service, total_scraped, inserted, duplicates, errors, proxy_used, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      metric.service,
      metric.total_scraped,
      metric.inserted,
      metric.duplicates,
      metric.errors,
      metric.proxy_used ?? null,
      metric.duration_ms ?? 0,
    );
  }

  /**
   * Aggregates metrics for a time window in hours (e.g. past 1h, 24h).
   */
  getSummaryByHours(service: 'khmer24' | 'facebook' | 'all', hours: number): MetricsSummary {
    const sql =
      service === 'all'
        ? `SELECT 
             COUNT(*) as runsCount,
             COALESCE(SUM(total_scraped), 0) as totalScraped,
             COALESCE(SUM(inserted), 0) as inserted,
             COALESCE(SUM(duplicates), 0) as duplicates,
             COALESCE(SUM(errors), 0) as errors
           FROM scraper_metrics
           WHERE datetime(created_at) >= datetime('now', '-' || ? || ' hours')`
        : `SELECT 
             COUNT(*) as runsCount,
             COALESCE(SUM(total_scraped), 0) as totalScraped,
             COALESCE(SUM(inserted), 0) as inserted,
             COALESCE(SUM(duplicates), 0) as duplicates,
             COALESCE(SUM(errors), 0) as errors
           FROM scraper_metrics
           WHERE service = ? AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')`;

    const row =
      service === 'all'
        ? (this.db.prepare(sql).get(hours) as unknown as MetricsSummary)
        : (this.db.prepare(sql).get(service, hours) as unknown as MetricsSummary);

    return {
      runsCount: Number(row?.runsCount ?? 0),
      totalScraped: Number(row?.totalScraped ?? 0),
      inserted: Number(row?.inserted ?? 0),
      duplicates: Number(row?.duplicates ?? 0),
      errors: Number(row?.errors ?? 0),
    };
  }

  /**
   * Aggregates historical metrics for all time.
   */
  getAllTimeSummary(service?: 'khmer24' | 'facebook'): MetricsSummary {
    const sql = service
      ? `SELECT 
           COUNT(*) as runsCount,
           COALESCE(SUM(total_scraped), 0) as totalScraped,
           COALESCE(SUM(inserted), 0) as inserted,
           COALESCE(SUM(duplicates), 0) as duplicates,
           COALESCE(SUM(errors), 0) as errors
         FROM scraper_metrics
         WHERE service = ?`
      : `SELECT 
           COUNT(*) as runsCount,
           COALESCE(SUM(total_scraped), 0) as totalScraped,
           COALESCE(SUM(inserted), 0) as inserted,
           COALESCE(SUM(duplicates), 0) as duplicates,
           COALESCE(SUM(errors), 0) as errors
         FROM scraper_metrics`;

    const row = service
      ? (this.db.prepare(sql).get(service) as unknown as MetricsSummary)
      : (this.db.prepare(sql).get() as unknown as MetricsSummary);

    return {
      runsCount: Number(row?.runsCount ?? 0),
      totalScraped: Number(row?.totalScraped ?? 0),
      inserted: Number(row?.inserted ?? 0),
      duplicates: Number(row?.duplicates ?? 0),
      errors: Number(row?.errors ?? 0),
    };
  }

  /**
   * Retrieves the most recent scraper runs.
   */
  getRecentRuns(limit = 20): ScraperMetricRecord[] {
    return this.db
      .prepare('SELECT * FROM scraper_metrics ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as ScraperMetricRecord[];
  }
}
