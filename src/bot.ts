import 'dotenv/config';
import { createContainer } from './container';
import { createBot } from './modules/bot/bot';
import { USER_COMMANDS } from './modules/bot/commands';
import { runMigrations } from './database/migrate';
import { closeDatabase } from './database/db';
import { env } from './config/env';

const DELIVERY_MODE = env.BOT_DELIVERY_MODE;

export async function runBot(): Promise<void> {
  console.log('');
  console.log('🤖 Starting HomEasy Telegram Bot Service');
  console.log(`📍 Environment : ${env.NODE_ENV}`);
  console.log(`🗄  Database    : ${env.DATABASE_PATH}`);
  console.log(`📡 Delivery mode: ${DELIVERY_MODE}`);
  console.log('');

  if (DELIVERY_MODE === 'webhook') {
    console.log('ℹ️  Bot service is configured for webhook mode. Polling is disabled.');
    console.log('   Telegram updates will be delivered to the API webhook endpoint.');
    // Keep the process alive so Docker does not restart the container in webhook mode.
    // eslint-disable-next-line no-promise-executor-return
    await new Promise(() => {});
    return;
  }

  // 1. Initialize DI Container & run DB migrations (idempotent, safe on restart)
  const container = createContainer();
  runMigrations(container.db);

  // 2. Create the grammY bot instance with injected container
  const bot = createBot(container);

  // 3. Register active bot API instance with notifier and alert services
  container.notifierService.setApi(bot.api);
  container.alertService.setApi(bot.api);

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

  // 5. Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async (signal: string) => {
    console.log(`\n⚡ Received ${signal} — shutting down bot gracefully...`);
    bot.stop();
    await container.analyticsRepo.shutdown();
    closeDatabase(container.db);
    console.log('✅ Bot shut down.');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // 6. Polling mode: explicitly ensure no webhook is registered.
  //    This is the intended behavior for BOT_DELIVERY_MODE=polling and is logged loudly.
  try {
    const webhookInfo = await bot.api.getWebhookInfo();
    if (webhookInfo.url) {
      console.warn('');
      console.warn('╔════════════════════════════════════════════════════════════════════╗');
      console.warn('║  BOT_DELIVERY_MODE=polling but a Telegram webhook is still set:    ║');
      console.warn(`║  ${webhookInfo.url.padEnd(64, ' ').slice(0, 64)}   ║`);
      console.warn('║  Deleting it now so polling can take over...                       ║');
      console.warn('╚════════════════════════════════════════════════════════════════════╝');
      console.warn('');
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      console.log('✅ Webhook deleted; switching to long polling.');
    } else {
      console.log('✅ No active Telegram webhook — polling mode confirmed.');
    }
  } catch (err) {
    console.warn('⚠️ Could not check/clear webhook before polling:', err);
  }

  // 7. Start long-polling
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

