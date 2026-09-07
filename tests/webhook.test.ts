import { verifyWebhookSecretToken } from '../src/modules/api/routes/webhook.routes';
import { buildApiServer } from '../src/modules/api/server';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { env } from '../src/config/env';

describe('Telegram Webhook Security & Secret Token Invariant', () => {
  describe('verifyWebhookSecretToken unit validation', () => {
    test('returns true when no expected token is configured (dev mode)', () => {
      expect(verifyWebhookSecretToken(undefined, undefined)).toBe(true);
      expect(verifyWebhookSecretToken('any_token', undefined)).toBe(true);
    });

    test('returns false when expected token is set but incoming is missing', () => {
      expect(verifyWebhookSecretToken(undefined, 'secret_12345')).toBe(false);
      expect(verifyWebhookSecretToken('', 'secret_12345')).toBe(false);
    });

    test('returns false when tokens differ in length or content', () => {
      expect(verifyWebhookSecretToken('secret_1234', 'secret_12345')).toBe(false);
      expect(verifyWebhookSecretToken('secret_99999', 'secret_12345')).toBe(false);
    });

    test('returns true when incoming matches expected secret token exactly', () => {
      expect(verifyWebhookSecretToken('my_secure_secret_token_abc_123', 'my_secure_secret_token_abc_123')).toBe(true);
    });
  });

  describe('Fastify Webhook Endpoint Protection', () => {
    const originalSecret = env.TELEGRAM_WEBHOOK_SECRET;
    const testSecret = 'test_webhook_secret_key_abcdef123456';
    let app: Awaited<ReturnType<typeof buildApiServer>>;

    beforeAll(async () => {
      (env as { TELEGRAM_WEBHOOK_SECRET?: string }).TELEGRAM_WEBHOOK_SECRET = testSecret;
      const container = createContainer({ dbPath: ':memory:' });
      runMigrations(container.db);
      app = await buildApiServer({ container, logger: false });
    });

    afterAll(async () => {
      (env as { TELEGRAM_WEBHOOK_SECRET?: string }).TELEGRAM_WEBHOOK_SECRET = originalSecret;
      await app.close();
    });

    test('rejects POST /api/v1/telegram/webhook without secret token header with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/telegram/webhook',
        payload: {
          update_id: 10001,
          message: { text: 'fake malicious payload' },
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toContain('X-Telegram-Bot-Api-Secret-Token');
    });

    test('rejects POST /api/v1/telegram/webhook with invalid secret token header with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/telegram/webhook',
        headers: {
          'x-telegram-bot-api-secret-token': 'wrong_secret_attacker',
        },
        payload: {
          update_id: 10002,
          message: { text: 'fake malicious payload' },
        },
      });

      expect(response.statusCode).toBe(401);
    });

    test('accepts POST /api/v1/telegram/webhook with valid secret token header with 200', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/telegram/webhook',
        headers: {
          'x-telegram-bot-api-secret-token': testSecret,
        },
        payload: {
          update_id: 10003,
          message: {
            message_id: 1,
            from: { id: 9999, is_bot: false, first_name: 'Tester' },
            chat: { id: 9999, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/start',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
    });
  });
});
