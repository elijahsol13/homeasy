import 'dotenv/config';
import { runBot } from './bot';
import { runScraper } from './scraper';
import { createContainer } from './container';
import { createBot } from './modules/bot/bot';
import { USER_COMMANDS } from './modules/bot/commands';
import { runMigrations } from './database/migrate';
import { startWorker, stopWorker } from './services/scheduler';
import { closeDatabase } from './database/db';
import { env } from './config/env';

async function main(): Promise<void> {
  const serviceType = process.env.SERVICE_TYPE?.toLowerCase();

  if (serviceType === 'bot') {
    await runBot();
    return;
  }

  if (serviceType === 'scraper') {
    await runScraper();
    return;
  }

  // Combined monolith mode (default for single-container / local development)
  console.log('');
  console.log('🏡 Starting HomEasy Monolith (Bot + Scraper Worker)');
  console.log(`📍 Environment : ${env.NODE_ENV}`);
  console.log(`🗄  Database    : ${env.DATABASE_PATH}`);
  console.log('');

  const container = createContainer();
  runMigrations(container.db);

  const bot = createBot(container);
  container.notifierService.setApi(bot.api);
  container.alertService.setApi(bot.api);

  // Start sequential worker
  startWorker(container, 12);

  await bot.api.setMyCommands([...USER_COMMANDS]);

  if (env.WEBAPP_URL && env.WEBAPP_URL.startsWith('https://')) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: '📱 Open App',
          web_app: { url: env.WEBAPP_URL },
        },
      });
      console.log(`✅ Set Telegram chat menu button to: ${env.WEBAPP_URL}`);
    } catch (err) {
      console.warn('⚠️ Could not set chat menu button:', err);
    }
  }

  const shutdown = async (signal: string) => {
    console.log(`\n⚡ Received ${signal} — shutting down gracefully...`);
    stopWorker();
    bot.stop();
    await container.analyticsRepo.shutdown();
    closeDatabase(container.db);
    console.log('✅ Bye!');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

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
