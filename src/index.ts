import 'dotenv/config';
import { createContainer } from './container';
import { createBot } from './modules/bot/bot';
import { runMigrations } from './database/migrate';
import { startScheduler, stopScheduler } from './services/scheduler';
import { closeDatabase } from './database/db';
import { env } from './config/env';

async function main(): Promise<void> {
  console.log('');
  console.log('🏡 HomEasy Bot');
  console.log(`📍 Environment : ${env.NODE_ENV}`);
  console.log(`🗄  Database    : ${env.DATABASE_PATH}`);
  console.log('');

  // 1. Initialize DI Container & run DB migrations (idempotent, safe on every restart)
  const container = createContainer();
  runMigrations(container.db);

  // 2. Create the grammY bot instance with injected container
  const bot = createBot(container);

  // 3. Give the notification service the active bot API instance
  container.notifierService.setApi(bot.api);

  // 4. Start automated recurring background scrapers (every 20 mins: Khmer24 + Facebook)
  startScheduler(container, '*/20 * * * *');

  // 5. Register bot command hints in Telegram's UI (/ menu)
  await bot.api.setMyCommands([
    { command: 'start', description: 'Start HomEasy & open main menu' },
    { command: 'menu', description: 'Open main menu' },
    { command: 'myfilters', description: 'View & manage your search alerts' },
    { command: 'favorites', description: 'View saved listings' },
    { command: 'stop', description: 'Pause notifications' },
    { command: 'ingest_json', description: '[Admin] Import a listing from JSON' },
    { command: 'stats', description: '[Admin] View bot statistics' },
  ]);

  // 6. Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (signal: string) => {
    console.log(`\n⚡ Received ${signal} — shutting down gracefully...`);
    stopScheduler();
    bot.stop();
    closeDatabase(container.db);
    console.log('✅ Bye!');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 7. Start long-polling
  console.log('🤖 Starting bot in polling mode...');
  await bot.start({
    onStart: (info) => {
      console.log(`✅ Bot @${info.username} is running`);
      console.log('   Press Ctrl+C to stop.\n');
    },
  });
}

main().catch((err: unknown) => {
  console.error('💥 Fatal startup error:', err);
  process.exit(1);
});
