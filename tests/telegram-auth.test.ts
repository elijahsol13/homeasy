import fs from 'fs';
import path from 'path';
import { TelegramAuthService, FB_SESSION_PATH } from '../src/services/telegram-auth.service';
import type { AppContainer } from '../src/container';

describe('TelegramAuthService', () => {
  let service: TelegramAuthService;
  let mockContainer: Partial<AppContainer>;
  let originalSession: string | null = null;

  beforeAll(() => {
    if (fs.existsSync(FB_SESSION_PATH)) {
      originalSession = fs.readFileSync(FB_SESSION_PATH, 'utf8');
    }
  });

  afterAll(() => {
    if (originalSession !== null) {
      fs.writeFileSync(FB_SESSION_PATH, originalSession, 'utf8');
    }
  });

  beforeEach(() => {
    mockContainer = {
      notifierService: {
        notifyAdmins: jest.fn().mockResolvedValue(undefined),
      } as any,
    };
    service = new TelegramAuthService(mockContainer as AppContainer);
  });

  describe('Session State Management', () => {
    test('reports false for non-existent session', () => {
      expect(service.hasSession(12345)).toBe(false);
      expect(service.getWaitingForInput(12345)).toBeUndefined();
    });

    test('throws descriptive error when interacting without active session', async () => {
      await expect(service.enterLogin(12345, 'test@example.com')).rejects.toThrow(
        'No active authorization session found',
      );
      await expect(service.enterPassword(12345, 'secret')).rejects.toThrow(
        'No active authorization session found',
      );
      await expect(service.submitForm(12345)).rejects.toThrow(
        'No active authorization session found',
      );
      await expect(service.enter2FACode(12345, '123456')).rejects.toThrow(
        'No active authorization session found',
      );
    });
  });

  describe('Session Import Functionality', () => {
    const testSessionDir = path.join(process.cwd(), 'data');

    test('imports valid Playwright storageState format', () => {
      const validStorageState = JSON.stringify({
        cookies: [
          { name: 'c_user', value: '1000999888', domain: '.facebook.com' },
          { name: 'xs', value: '12345%3Aabcde', domain: '.facebook.com' },
          { name: 'datr', value: 'xyz123', domain: '.facebook.com' },
        ],
        origins: [],
      });

      const result = service.importSessionJson(validStorageState);
      expect(result.success).toBe(true);
      expect(result.c_user).toBe('1000999888');
      expect(fs.existsSync(FB_SESSION_PATH)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(FB_SESSION_PATH, 'utf8'));
      expect(saved.cookies).toHaveLength(3);
    });

    test('imports raw cookie array format', () => {
      const rawCookies = JSON.stringify([
        { name: 'c_user', value: '61594146746595', domain: '.facebook.com' },
        { name: 'xs', value: '99999%3Asecret', domain: '.facebook.com' },
      ]);

      const result = service.importSessionJson(rawCookies);
      expect(result.success).toBe(true);
      expect(result.c_user).toBe('61594146746595');
    });

    test('rejects JSON missing c_user or xs cookies', () => {
      const invalidCookies = JSON.stringify({
        cookies: [{ name: 'datr', value: 'xyz' }],
      });

      const result = service.importSessionJson(invalidCookies);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing essential Facebook cookies');
    });

    test('rejects invalid JSON string', () => {
      const result = service.importSessionJson('not-valid-json{');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse JSON');
    });
  });
});
