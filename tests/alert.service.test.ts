import { AlertService } from '../src/services/alert.service';
import { createContainer } from '../src/container';
import type { Api } from 'grammy';
import type { FastifyBaseLogger } from 'fastify';
import { notifyIngestionFailure } from '../src/modules/api/routes/internal-ingest-helpers';

describe('AlertService', () => {
  let consoleInfoSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('info() logs to console.info and broadcasts to admins with prefix', async () => {
    const sendMessageMock = jest.fn().mockResolvedValue({});
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;
    const adminIds = [12345, 67890];

    const alertService = new AlertService(mockApi, adminIds);
    await alertService.info('Database backup completed successfully');

    expect(consoleInfoSpy).toHaveBeenCalledWith('ℹ️ [INFO] Database backup completed successfully');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      1,
      12345,
      'ℹ️ [INFO] Database backup completed successfully',
      { parse_mode: 'HTML' },
    );
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      2,
      67890,
      'ℹ️ [INFO] Database backup completed successfully',
      { parse_mode: 'HTML' },
    );
  });

  test('warn() logs to console.warn and broadcasts to admins with prefix', async () => {
    const sendMessageMock = jest.fn().mockResolvedValue({});
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;
    const adminIds = [999];

    const alertService = new AlertService(mockApi, adminIds);
    await alertService.warn('<b>Zero Yield:</b> FB Scraper completed with 0 listings found.');

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '⚠️ [WARN] <b>Zero Yield:</b> FB Scraper completed with 0 listings found.',
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      999,
      '⚠️ [WARN] <b>Zero Yield:</b> FB Scraper completed with 0 listings found.',
      { parse_mode: 'HTML' },
    );
  });

  test('critical() logs to console.error and broadcasts to admins with prefix', async () => {
    const sendMessageMock = jest.fn().mockResolvedValue({});
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;
    const adminIds = [999];

    const alertService = new AlertService(mockApi, adminIds);
    await alertService.critical('<b>Facebook Checkpoint!</b> Scraper halted.');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '🚨 [CRITICAL] <b>Facebook Checkpoint!</b> Scraper halted.',
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      999,
      '🚨 [CRITICAL] <b>Facebook Checkpoint!</b> Scraper halted.',
      { parse_mode: 'HTML' },
    );
  });

  test('Telegram API failure does not crash or throw', async () => {
    const sendMessageMock = jest.fn().mockRejectedValue(new Error('https://api.telegram.org/botFAKE_PRIVATE_TOKEN/sendMessage failed'));
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;
    const adminIds = [12345];

    const alertService = new AlertService(mockApi, adminIds);

    // Must resolve without throwing
    await expect(alertService.critical('Fatal error')).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('🚨 [CRITICAL] Fatal error');
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to deliver alert to admin 12345'));
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('FAKE_PRIVATE_TOKEN');
  });

  test('ingestion alert retries after Telegram delivery fails instead of suppressing the next incident', async () => {
    const sendMessageMock = jest.fn()
      .mockRejectedValueOnce(new Error('https://api.telegram.org/botFAKE_PRIVATE_TOKEN/sendMessage failed'))
      .mockResolvedValue({});
    const alertService = new AlertService({ sendMessage: sendMessageMock } as unknown as Api, [12345]);
    const logger = { warn: jest.fn() } as unknown as Pick<FastifyBaseLogger, 'warn'>;

    await notifyIngestionFailure(logger, alertService, 'facebook');
    await notifyIngestionFailure(logger, alertService, 'facebook');

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'ingestion_alert_delivery_failed', source: 'facebook' },
      'Ingestion alert failed',
    );
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('FAKE_PRIVATE_TOKEN');
  });

  test('ingestion warning is considered delivered when one of multiple admins receives it', async () => {
    const sendMessageMock = jest.fn()
      .mockRejectedValueOnce(new Error('delivery failed'))
      .mockResolvedValue({});
    const alertService = new AlertService({ sendMessage: sendMessageMock } as unknown as Api, [12345, 67890]);
    const logger = { warn: jest.fn() } as unknown as Pick<FastifyBaseLogger, 'warn'>;

    await notifyIngestionFailure(logger, alertService, 'khmer24');
    await notifyIngestionFailure(logger, alertService, 'khmer24');

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('missing Telegram administrators leaves ingestion warnings retryable', async () => {
    const sendMessageMock = jest.fn();
    const alertService = new AlertService({ sendMessage: sendMessageMock } as unknown as Api, []);
    const logger = { warn: jest.fn() } as unknown as Pick<FastifyBaseLogger, 'warn'>;

    await notifyIngestionFailure(logger, alertService, 'facebook');
    await notifyIngestionFailure(logger, alertService, 'facebook');

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('concurrent ingestion failures share one in-flight delivery attempt', async () => {
    let finishDelivery: (() => void) | undefined;
    const sendMessageMock = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      finishDelivery = resolve;
    }));
    const alertService = new AlertService({ sendMessage: sendMessageMock } as unknown as Api, [12345]);
    const logger = { warn: jest.fn() } as unknown as Pick<FastifyBaseLogger, 'warn'>;

    const first = notifyIngestionFailure(logger, alertService, 'facebook');
    const second = notifyIngestionFailure(logger, alertService, 'facebook');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    finishDelivery?.();
    await Promise.all([first, second]);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('handles empty admin list gracefully without calling sendMessage', async () => {
    const sendMessageMock = jest.fn();
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;

    const alertService = new AlertService(mockApi, []);
    await alertService.info('No admins configured');

    expect(consoleInfoSpy).toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('setApi updates the active grammY API instance', async () => {
    const alertService = new AlertService(undefined, [111]);
    const sendMessageMock = jest.fn().mockResolvedValue({});
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;

    alertService.setApi(mockApi);
    await alertService.warn('Late wired alert');

    expect(sendMessageMock).toHaveBeenCalledWith(111, '⚠️ [WARN] Late wired alert', { parse_mode: 'HTML' });
  });

  test('is integrated in AppContainer via createContainer', () => {
    const container = createContainer({ dbPath: ':memory:' });
    expect(container.alertService).toBeDefined();
    expect(container.alertService).toBeInstanceOf(AlertService);
  });
});

