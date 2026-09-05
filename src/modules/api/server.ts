import fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import type { AppContainer } from '../../container';
import { env } from '../../config/env';
import { healthRoutes } from './routes/health.routes';
import { propertiesRoutes } from './routes/properties.routes';
import { filtersRoutes } from './routes/filters.routes';
import { favoritesRoutes } from './routes/favorites.routes';

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

  // Register all TMA routes
  await app.register(healthRoutes, { container });
  await app.register(propertiesRoutes, { container });
  await app.register(filtersRoutes, { container });
  await app.register(favoritesRoutes, { container });

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
    return app;
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
