import { ScraperWorker, startWorker, stopWorkerAndWait } from '../src/services/scheduler';
import * as khmer24 from '../src/modules/parser/khmer24.scraper';
import * as backup from '../src/database/backup';
import * as settings from '../src/services/settings';
import { runEnrichment } from '../src/database/enrich-properties';
import type { AppContainer } from '../src/container';

jest.mock('../src/database/enrich-properties', () => ({ runEnrichment: jest.fn() }));

describe('ScraperWorker Heartbeat and Statistics', () => {
  let mockContainer: Partial<AppContainer>;
  let notifyAdminsMock: jest.Mock;

  beforeEach(() => {
    notifyAdminsMock = jest.fn().mockResolvedValue(undefined);

    mockContainer = {
      db: {
        prepare: jest.fn().mockReturnValue({
          get: jest.fn().mockReturnValue({ count: 42 }),
          all: jest.fn().mockReturnValue([]),
        }),
        exec: jest.fn(),
      } as any,
      linkVerifierService: {
        verifyBatch: jest.fn(),
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

  test('shutdown waits for an in-flight scraper before the database may be closed', async () => {
    let releaseScraper: (() => void) | undefined;
    const pending = new Promise<null>((resolve) => {
      releaseScraper = () => resolve(null);
    });
    const maintenance = jest.spyOn(ScraperWorker.prototype as any, 'checkAndRunMaintenance')
      .mockResolvedValue(undefined);
    const scraper = jest.spyOn(khmer24, 'runKhmer24Scraper').mockImplementation(() => pending as any);
    try {
      startWorker(mockContainer as AppContainer, 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scraper).toHaveBeenCalledTimes(1);

      let finished = false;
      const stopped = stopWorkerAndWait().then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);

      releaseScraper?.();
      await stopped;
      expect(finished).toBe(true);
    } finally {
      releaseScraper?.();
      await stopWorkerAndWait();
      scraper.mockRestore();
      maintenance.mockRestore();
    }
  });

  test('canonical scrape cycle keeps maintenance and never invokes legacy enrichment or verification', async () => {
    const backupSpy = jest.spyOn(backup, 'createDatabaseBackup').mockReturnValue({
      success: true, filename: 'isolated-test.db', sizeBytes: 1024,
    } as ReturnType<typeof backup.createDatabaseBackup>);
    const settingsSpy = jest.spyOn(settings, 'getScraperSettings').mockReturnValue({ facebookEnabled: false });
    const scrapeSpy = jest.spyOn(khmer24, 'runKhmer24Scraper').mockResolvedValue(null as any);
    const worker = new ScraperWorker(mockContainer as AppContainer, 1);
    const sleepSpy = jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);
    const heartbeatSpy = jest.spyOn(worker as any, 'checkAndSendHeartbeat').mockImplementation(async () => {
      worker.stop();
    });

    try {
      await worker.start();

      expect(scrapeSpy).toHaveBeenCalledTimes(1);
      expect(backupSpy).toHaveBeenCalledTimes(1);
      expect(mockContainer.db!.exec).toHaveBeenCalledWith('PRAGMA optimize;');
      expect(runEnrichment).not.toHaveBeenCalled();
      expect(mockContainer.linkVerifierService!.verifyBatch).not.toHaveBeenCalled();
      expect(worker.getStatus().isRunning).toBe(false);
    } finally {
      worker.stop();
      backupSpy.mockRestore();
      settingsSpy.mockRestore();
      scrapeSpy.mockRestore();
      sleepSpy.mockRestore();
      heartbeatSpy.mockRestore();
      jest.mocked(runEnrichment).mockClear();
    }
  });

  test('bounded live-worker mode finishes two Khmer24 cycles and skips Facebook', async () => {
    const maintenance = jest.spyOn(ScraperWorker.prototype as any, 'checkAndRunMaintenance')
      .mockResolvedValue(undefined);
    // The VPS must skip Facebook even if the persisted global scraper setting enables it.
    const settingsSpy = jest.spyOn(settings, 'getScraperSettings').mockReturnValue({ facebookEnabled: true });
    const scrapeSpy = jest.spyOn(khmer24, 'runKhmer24Scraper').mockResolvedValue({
      totalScraped: 2, inserted: 0, duplicates: 2, errors: 0,
    });
    const worker = new ScraperWorker(mockContainer as AppContainer, 1, {
      khmer24: { targetIndex: 0, limitListings: 2 }, maxCycles: 2, skipFacebook: true,
    });
    const sleep = jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);

    try {
      await worker.start();

      expect(scrapeSpy).toHaveBeenCalledTimes(2);
      expect(scrapeSpy).toHaveBeenNthCalledWith(1, mockContainer, { targetIndex: 0, limitListings: 2 });
      expect(scrapeSpy).toHaveBeenNthCalledWith(2, mockContainer, { targetIndex: 0, limitListings: 2 });
      expect(worker.getHourlyStats().cyclesCompleted).toBe(2);
      expect(worker.getHourlyStats().khmer24.scraped).toBe(4);
      expect(worker.getStatus()).toEqual({ isRunning: false, isWorking: false });
      expect(settingsSpy).not.toHaveBeenCalled();
    } finally {
      worker.stop();
      maintenance.mockRestore();
      settingsSpy.mockRestore();
      scrapeSpy.mockRestore();
      sleep.mockRestore();
    }
  });
});

