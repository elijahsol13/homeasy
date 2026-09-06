import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { MetricsRepository } from '../src/database/repositories/metrics.repo';
import { AnalyticsRepository } from '../src/database/repositories/analytics.repo';

describe('Metrics & Analytics Repositories', () => {
  let db: DatabaseSync;
  let metricsRepo: MetricsRepository;
  let analyticsRepo: AnalyticsRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    metricsRepo = new MetricsRepository(db);
    analyticsRepo = new AnalyticsRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('MetricsRepository', () => {
    test('records scraper runs and aggregates summary', () => {
      metricsRepo.recordScraperRun({
        service: 'khmer24',
        total_scraped: 20,
        inserted: 5,
        duplicates: 14,
        errors: 1,
        proxy_used: null,
        duration_ms: 12000,
      });

      metricsRepo.recordScraperRun({
        service: 'khmer24',
        total_scraped: 15,
        inserted: 2,
        duplicates: 13,
        errors: 0,
        duration_ms: 8000,
      });

      metricsRepo.recordScraperRun({
        service: 'facebook',
        total_scraped: 30,
        inserted: 8,
        duplicates: 22,
        errors: 0,
        proxy_used: 'http://***:***@93.190.141.105:9999',
        duration_ms: 45000,
      });

      const k24Summary = metricsRepo.getSummaryByHours('khmer24', 1);
      expect(k24Summary.runsCount).toBe(2);
      expect(k24Summary.totalScraped).toBe(35);
      expect(k24Summary.inserted).toBe(7);
      expect(k24Summary.duplicates).toBe(27);
      expect(k24Summary.errors).toBe(1);

      const allSummary = metricsRepo.getAllTimeSummary();
      expect(allSummary.runsCount).toBe(3);
      expect(allSummary.totalScraped).toBe(65);
      expect(allSummary.inserted).toBe(15);
      expect(allSummary.duplicates).toBe(49);
      expect(allSummary.errors).toBe(1);

      const recent = metricsRepo.getRecentRuns(5);
      expect(recent.length).toBe(3);
      expect(recent[0]?.service).toBe('facebook');
    });
  });

  describe('AnalyticsRepository', () => {
    test('tracks user events and generates activity summary', () => {
      analyticsRepo.trackEvent({
        telegramId: 1001,
        eventType: 'bot_command',
        metadata: { command: '/start' },
      });

      analyticsRepo.trackEvent({
        telegramId: 1001,
        eventType: 'tma_open',
      });

      analyticsRepo.trackEvent({
        telegramId: 1002,
        eventType: 'filter_update',
        metadata: { city: 'siem_reap' },
      });

      analyticsRepo.trackEvent({
        telegramId: 1002,
        eventType: 'favorite_add',
        metadata: { propertyId: 42 },
      });

      const summary = analyticsRepo.getSummary(1);
      expect(summary.activeUsers).toBe(2);
      expect(summary.totalEvents).toBe(4);
      expect(summary.eventBreakdown['bot_command']).toBe(1);
      expect(summary.eventBreakdown['tma_open']).toBe(1);
      expect(summary.eventBreakdown['filter_update']).toBe(1);
      expect(summary.eventBreakdown['favorite_add']).toBe(1);

      const active24h = analyticsRepo.get24hActiveUsersCount();
      expect(active24h).toBe(2);
    });
  });
});

