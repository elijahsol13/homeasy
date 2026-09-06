import { ScraperWorker } from '../src/services/scheduler';
import type { AppContainer } from '../src/container';

describe('ScraperWorker Heartbeat and Statistics', () => {
  let mockContainer: Partial<AppContainer>;
  let notifyAdminsMock: jest.Mock;

  beforeEach(() => {
    notifyAdminsMock = jest.fn().mockResolvedValue(undefined);

    mockContainer = {
      db: {
        prepare: jest.fn().mockReturnValue({
          get: jest.fn().mockReturnValue({ count: 42 }),
        }),
        exec: jest.fn(),
      } as any,
      notifierService: {
        notifyAdmins: notifyAdminsMock,
        flushNotificationQueue: jest.fn().mockResolvedValue(undefined),
      } as any,
      metricsRepo: {
        recordScraperRun: jest.fn(),
        getAllTimeSummary: jest.fn().mockReturnValue({ runsCount: 10, totalScraped: 500, inserted: 120 }),
      } as any,
      analyticsRepo: {
        getSummary: jest.fn().mockReturnValue({
          activeUsers: 3,
          totalEvents: 12,
          eventBreakdown: { bot_command: 5, tma_request: 7 },
        }),
        get24hActiveUsersCount: jest.fn().mockReturnValue(15),
      } as any,
    };
  });

  test('initializes with empty hourly stats', () => {
    const worker = new ScraperWorker(mockContainer as AppContainer, 60000);
    const stats = worker.getHourlyStats();

    expect(stats.cyclesCompleted).toBe(0);
    expect(stats.khmer24).toEqual({ scraped: 0, inserted: 0, duplicates: 0, errors: 0 });
    expect(stats.facebook).toEqual({ scraped: 0, inserted: 0, duplicates: 0, errors: 0 });
  });

  test('sendHeartbeat formats summary and notifies admins, then resets stats', async () => {
    const worker = new ScraperWorker(mockContainer as AppContainer, 60000);

    // Simulate some stats
    const stats = (worker as any).hourlyStats;
    stats.cyclesCompleted = 4;
    stats.khmer24 = { scraped: 25, inserted: 5, duplicates: 19, errors: 1 };
    stats.facebook = { scraped: 18, inserted: 3, duplicates: 15, errors: 0 };

    await worker.sendHeartbeat();

    expect(notifyAdminsMock).toHaveBeenCalledTimes(1);
    const sentMessage = notifyAdminsMock.mock.calls[0][0];

    expect(sentMessage).toContain('HomEasy Scraper Heartbeat');
    expect(sentMessage).toContain('Cycles in last hour:</b> 4');
    expect(sentMessage).toContain('Total active listings in DB:</b> 42');
    expect(sentMessage).toContain('Khmer24:');
    expect(sentMessage).toContain('Scraped: <b>25</b>');
    expect(sentMessage).toContain('New inserted: <b>+5</b>');
    expect(sentMessage).toContain('Facebook Groups:');
    expect(sentMessage).toContain('Scraped: <b>18</b>');
    expect(sentMessage).toContain('New inserted: <b>+3</b>');
    expect(sentMessage).toContain('Usage Analytics:');
    expect(sentMessage).toContain('Active users (1h / 24h): <b>3</b> / <b>15</b>');
    expect(sentMessage).toContain('All-Time Scraped:</b> 500');

    // Verify stats were reset
    const afterStats = worker.getHourlyStats();
    expect(afterStats.cyclesCompleted).toBe(0);
    expect(afterStats.khmer24.scraped).toBe(0);
    expect(afterStats.facebook.scraped).toBe(0);
  });
});

