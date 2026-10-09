import fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppContainer } from '../../container';
import { env } from '../../config/env';
import { healthRoutes } from './routes/health.routes';
import { propertiesRoutes } from './routes/properties.routes';
import { filtersRoutes } from './routes/filters.routes';
import { favoritesRoutes } from './routes/favorites.routes';
import { meRoutes } from './routes/me.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { trackingRoutes } from './routes/tracking.routes';
import { createBot } from '../bot/bot';

export interface BuildServerOptions {
  container: AppContainer;
  logger?: boolean;
}

/**
 * Builds and configures the Fastify server instance without starting listening.
 * Useful for automated tests and server instantiation.
 */
export async function buildApiServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { container, logger = false } = options;

  const app = fastify({
    logger,
    trustProxy: true,
  });

  // Enable CORS for Telegram WebApp iframes and mobile webviews
  await app.register(cors, {
    origin: true, // Reflect request origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data', 'X-Dev-Telegram-Id'],
  });

  // Tiered Rate Limiting: Global catalog reads default to 100 req/min
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded (100 req/min). Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });

  // Track TMA API requests for usage analytics
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/v1/')) {
      try {
        const tgIdHeader = request.headers['x-dev-telegram-id'];
        const telegramId = typeof tgIdHeader === 'string' ? parseInt(tgIdHeader, 10) : undefined;
        container.analyticsRepo.trackEvent({
          telegramId: !isNaN(telegramId ?? NaN) ? telegramId : null,
          eventType: 'tma_request',
          metadata: { path: request.url.split('?')[0], method: request.method },
        });
      } catch {
        // Ignore tracking errors
      }
    }
  });

  // Register all TMA routes
  await app.register(healthRoutes, { container });
  await app.register(propertiesRoutes, { container });
  await app.register(filtersRoutes, { container });
  await app.register(favoritesRoutes, { container });
  await app.register(meRoutes, { container });
  await app.register(trackingRoutes, { container });

  // Webhook route is always registered so it exists for health/diagnostics, but
  // Telegram is only told to use it when BOT_DELIVERY_MODE=webhook.
  await app.register(webhookRoutes, { container });

  // Custom 404 handler
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  // Global error handler
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    void reply.status(statusCode).send({
      statusCode,
      error: error.name || 'Internal Server Error',
      message: error.message || 'An unexpected error occurred',
    });
  });

  return app;
}

/**
 * Starts the standalone API server.
 */
export async function startApiServer(container: AppContainer): Promise<FastifyInstance> {
  const app = await buildApiServer({ container, logger: true });

  try {
    const address = await app.listen({
      port: env.API_PORT,
      host: env.API_HOST,
    });
    console.log(`🚀 HomEasy Telegram Mini App API running at ${address}`);
    console.log(`   Health check: ${address}/health`);
    console.log(`   Catalog:      ${address}/api/v1/properties`);
    console.log(`   Delivery mode: ${env.BOT_DELIVERY_MODE}`);

    if (env.BOT_DELIVERY_MODE === 'webhook') {
      await configureTelegramWebhook();
    } else {
      console.log('   Telegram updates handled by polling bot process.');
    }

    return app;
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

async function configureTelegramWebhook(): Promise<void> {
  if (!env.TELEGRAM_WEBHOOK_URL) {
    console.error('❌ BOT_DELIVERY_MODE=webhook but TELEGRAM_WEBHOOK_URL is not set');
    process.exit(1);
  }

  // Create a lightweight bot instance just to call setWebhook.
  const bot = createBot({} as AppContainer);
  try {
    const info = await bot.api.getWebhookInfo();
    if (info.url === env.TELEGRAM_WEBHOOK_URL) {
      console.log(`✅ Telegram webhook already set to: ${info.url}`);
      return;
    }
    const other: Parameters<typeof bot.api.setWebhook>[1] = {
      allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member'],
      drop_pending_updates: false,
    };
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      other.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
    }
    await bot.api.setWebhook(env.TELEGRAM_WEBHOOK_URL, other);
    console.log(`✅ Telegram webhook set to: ${env.TELEGRAM_WEBHOOK_URL}`);
  } catch (err) {
    console.error('❌ Failed to configure Telegram webhook:', err);
    process.exit(1);
  }
}
