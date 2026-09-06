import { AlertService } from '../src/services/alert.service';
import { createContainer } from '../src/container';
import type { Api } from 'grammy';

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
    await alertService.warn('<b>Zero Yield:</b> Скрапер FB отработал, но не нашел ни одного поста.');

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '⚠️ [WARN] <b>Zero Yield:</b> Скрапер FB отработал, но не нашел ни одного поста.',
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      999,
      '⚠️ [WARN] <b>Zero Yield:</b> Скрапер FB отработал, но не нашел ни одного поста.',
      { parse_mode: 'HTML' },
    );
  });

  test('critical() logs to console.error and broadcasts to admins with prefix', async () => {
    const sendMessageMock = jest.fn().mockResolvedValue({});
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;
    const adminIds = [999];

    const alertService = new AlertService(mockApi, adminIds);
    await alertService.critical('<b>Facebook Checkpoint!</b> Скрапер остановлен.');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '🚨 [CRITICAL] <b>Facebook Checkpoint!</b> Скрапер остановлен.',
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      999,
      '🚨 [CRITICAL] <b>Facebook Checkpoint!</b> Скрапер остановлен.',
      { parse_mode: 'HTML' },
    );
  });

  test('Telegram API failure does not crash or throw', async () => {
    const sendMessageMock = jest.fn().mockRejectedValue(new Error('Network timeout'));
    const mockApi = { sendMessage: sendMessageMock } as unknown as Api;
    const adminIds = [12345];

    const alertService = new AlertService(mockApi, adminIds);

    // Must resolve without throwing
    await expect(alertService.critical('Fatal error')).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('🚨 [CRITICAL] Fatal error');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[AlertService] Failed to deliver alert to admin 12345:',
      expect.any(Error),
    );
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
