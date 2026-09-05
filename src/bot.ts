import 'dotenv/config';
import { createContainer } from './container';
import { createBot } from './modules/bot/bot';
import { runMigrations } from './database/migrate';
import { closeDatabase } from './database/db';
import { env } from './config/env';

export async function runBot(): Promise<void> {
  console.log('');
  console.log('🤖 Starting HomEasy Telegram Bot Service');
  console.log(`📍 Environment : ${env.NODE_ENV}`);
  console.log(`🗄  Database    : ${env.DATABASE_PATH}`);
  console.log('');

  // 1. Initialize DI Container & run DB migrations (idempotent, safe on restart)
  const container = createContainer();
  runMigrations(container.db);

  // 2. Create the grammY bot instance with injected container
  const bot = createBot(container);

  // 3. Register active bot API instance with notifier service
  container.notifierService.setApi(bot.api);

  // 4. Register bot command hints in Telegram UI
  await bot.api.setMyCommands([
    { command: 'start', description: 'Start HomEasy & open main menu' },
    { command: 'menu', description: 'Open main menu' },
    { command: 'myfilters', description: 'View & manage your search alerts' },
    { command: 'favorites', description: 'View saved listings' },
    { command: 'stop', description: 'Pause notifications' },
    { command: 'ingest_json', description: '[Admin] Import a listing from JSON' },
    { command: 'stats', description: '[Admin] View bot statistics' },
  ]);

  // 5. Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (signal: string) => {
    console.log(`\n⚡ Received ${signal} — shutting down bot gracefully...`);
    bot.stop();
    closeDatabase(container.db);
    console.log('✅ Bot shut down.');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 6. Start long-polling
  console.log('🤖 Bot listening for Telegram updates in polling mode...');
  await bot.start({
    onStart: (info) => {
      console.log(`✅ Bot @${info.username} is running`);
      console.log('   Press Ctrl+C to stop.\n');
    },
  });
}

if (require.main === module) {
  runBot().catch((err: unknown) => {
    console.error('💥 Fatal bot startup error:', err);
    process.exit(1);
  });
}

