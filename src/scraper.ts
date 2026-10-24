import 'dotenv/config';
import { createContainer } from './container';
import { runMigrations } from './database/migrate';
import { startWorker, stopWorkerAndWait, type ScraperWorkerOptions } from './services/scheduler';
import { closeDatabase } from './database/db';
import { env } from './config/env';

export async function runScraper(options: ScraperWorkerOptions = {}): Promise<void> {
  console.log('');
  console.log('🕷️ Starting HomEasy Scraper Worker Service');
  console.log(`📍 Environment : ${env.NODE_ENV}`);
  console.log(`🗄  Database    : ${env.DATABASE_PATH}`);
  console.log('');

  // 1. Initialize DI Container & verify migrations
  const container = createContainer();
  runMigrations(container.db);

  // 2. Start sequential scraper worker (configurable interval; default 110 min)
  startWorker(container, env.SCRAPER_CYCLE_PAUSE_MINUTES, options);

  // 3. Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async (signal: string) => {
    console.log(`\n⚡ Received ${signal} — stopping scraper worker gracefully...`);
    await stopWorkerAndWait();
    await container.analyticsRepo.shutdown();
    closeDatabase(container.db);
    console.log('✅ Scraper worker shut down.');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep process alive
  await new Promise<void>(() => {});
}

if (require.main === module) {
  runScraper().catch((err: unknown) => {
    console.error('💥 Fatal scraper worker startup error:', err);
    process.exit(1);
  });
}

