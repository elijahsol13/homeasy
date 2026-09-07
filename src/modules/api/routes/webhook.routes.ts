import crypto from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { createBot } from '../../bot/bot';
import { env } from '../../../config/env';

/**
 * Validates the secret token header using timing-safe comparison to protect against timing attacks.
 */
export function verifyWebhookSecretToken(
  incomingToken: string | undefined | string[],
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    // If no secret token is configured in environment, allow through (development fallback)
    return true;
  }
  if (!incomingToken || typeof incomingToken !== 'string') {
    return false;
  }

  const incomingBuf = Buffer.from(incomingToken);
  const expectedBuf = Buffer.from(expectedToken);

  if (incomingBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(incomingBuf, expectedBuf);
}

export const webhookRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (
  app,
  { container },
) => {
  const bot = createBot(container);

  // Initialize bot API with alert & notifier services
  container.notifierService.setApi(bot.api);
  container.alertService.setApi(bot.api);

  /**
   * Main Telegram Webhook ingestion endpoint.
   * - Rate limiting is disabled for this route so Telegram batch updates are never throttled.
   * - Validates X-Telegram-Bot-Api-Secret-Token before touching payload or bot logic.
   */
  app.post(
    '/api/v1/telegram/webhook',
    {
      config: {
        rateLimit: false, // Do not rate limit Telegram servers
      },
    },
    async (request, reply) => {
      const incomingSecret = request.headers['x-telegram-bot-api-secret-token'];
      const isAuthorized = verifyWebhookSecretToken(incomingSecret, env.TELEGRAM_WEBHOOK_SECRET);

      if (!isAuthorized) {
        request.log.warn(
          {
            ip: request.ip,
            hasHeader: Boolean(incomingSecret),
          },
          '🚫 [Webhook Security] Rejected unauthorized Telegram webhook request: missing or invalid secret_token',
        );
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid or missing X-Telegram-Bot-Api-Secret-Token header',
        });
      }

      try {
        const update = request.body as Parameters<typeof bot.handleUpdate>[0];
        if (update && typeof update === 'object') {
          await bot.handleUpdate(update);
        }
        return reply.status(200).send({ ok: true });
      } catch (err: unknown) {
        request.log.error(err, '❌ Error processing Telegram update via webhook');
        // Return 200 to Telegram so Telegram does not get stuck in a retry loop for bad updates
        return reply.status(200).send({ ok: true });
      }
    },
  );

  /**
   * Diagnostic Webhook Status endpoint (GET /api/v1/telegram/webhook/status).
   */
  app.get(
    '/api/v1/telegram/webhook/status',
    async (_request, reply) => {
      try {
        const info = await bot.api.getWebhookInfo();
        return reply.send({
          status: 'ok',
          webhook: {
            url: info.url || '(none - polling mode)',
            hasCustomCertificate: info.has_custom_certificate,
            pendingUpdateCount: info.pending_update_count,
            lastErrorDate: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
            lastErrorMessage: info.last_error_message || null,
            maxConnections: info.max_connections,
            ipAddress: info.ip_address || null,
          },
          security: {
            secretTokenConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
            expectedHeader: 'X-Telegram-Bot-Api-Secret-Token',
          },
        });
      } catch (err: unknown) {
        return reply.status(500).send({
          status: 'error',
          message: (err as Error).message,
        });
      }
    },
  );
};
