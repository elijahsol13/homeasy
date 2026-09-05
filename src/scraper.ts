import 'dotenv/config';
import { createContainer } from './container';
import { runMigrations } from './database/migrate';
import { startWorker, stopWorker } from './services/scheduler';
import { closeDatabase } from './database/db';
import { env } from './config/env';

export async function runScraper(): Promise<void> {
  console.log('');
  console.log('🕷️ Starting HomEasy Scraper Worker Service');
  console.log(`📍 Environment : ${env.NODE_ENV}`);
  console.log(`🗄  Database    : ${env.DATABASE_PATH}`);
  console.log('');

  // 1. Initialize DI Container & verify migrations
  const container = createContainer();
  runMigrations(container.db);

  // 2. Start sequential scraper worker (12 min cycle interval default)
  startWorker(container, 12);

  // 3. Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (signal: string) => {
    console.log(`\n⚡ Received ${signal} — stopping scraper worker gracefully...`);
    stopWorker();
    closeDatabase(container.db);
    console.log('✅ Scraper worker shut down.');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  await new Promise<void>(() => {});
}

if (require.main === module) {
  runScraper().catch((err: unknown) => {
    console.error('💥 Fatal scraper worker startup error:', err);
    process.exit(1);
  });
}

