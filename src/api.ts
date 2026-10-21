import { createContainer } from './container';
import { runMigrations } from './database/migrate';
import { startApiServer } from './modules/api/server';
import { closeDatabase } from './database/db';
import { env } from './config/env';

async function main(): Promise<void> {
  const container = createContainer();

  // Ensure DB schema is up to date
  runMigrations(container.db);

  const app = await startApiServer(container);
  if (env.BOT_DELIVERY_MODE === 'webhook' && env.CANONICAL_ALERTS_ENABLED) {
    container.canonicalAlertsService.start();
  }
  if (env.BOT_DELIVERY_MODE === 'webhook' && env.ADMIN_REVIEW_ALERTS_ENABLED) {
    container.canonicalReviewAlertsService.start();
  }

  const shutdown = async (signal: string) => {
    console.log(`\n⚡ Received ${signal} — shutting down API server...`);
    await app.close();
    await container.canonicalAlertsService.stop();
    await container.canonicalReviewAlertsService.stop();
    await container.analyticsRepo.shutdown();
    closeDatabase(container.db);
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error starting HomEasy API:', err);
  process.exit(1);
});

