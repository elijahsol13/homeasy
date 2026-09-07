import 'dotenv/config';
import crypto from 'crypto';
import { Bot } from 'grammy';
import { env } from '../src/config/env';

async function main() {
  const action = process.argv[2] || 'info';
  const bot = new Bot(env.BOT_TOKEN);

  console.log('🤖 HomEasy Telegram Bot Webhook Manager');
  console.log(`📍 Action: ${action}\n`);

  if (action === 'info' || action === 'status') {
    const info = await bot.api.getWebhookInfo();
    console.log('📋 Current Webhook Info:');
    console.log(`  • URL:                   ${info.url || '(none - polling mode)'}`);
    console.log(`  • Custom Certificate:    ${info.has_custom_certificate}`);
    console.log(`  • Pending Updates:       ${info.pending_update_count}`);
    console.log(`  • Max Connections:       ${info.max_connections ?? 40}`);
    console.log(`  • IP Address:            ${info.ip_address || '(none)'}`);
    if (info.last_error_date) {
      console.log(`  ⚠️ Last Error Date:      ${new Date(info.last_error_date * 1000).toISOString()}`);
      console.log(`  ⚠️ Last Error Message:   ${info.last_error_message}`);
    } else {
      console.log(`  ✅ Last Error:           None (healthy)`);
    }
    return;
  }

  if (action === 'set') {
    let webhookUrl = process.argv[3] || env.TELEGRAM_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('❌ Error: TELEGRAM_WEBHOOK_URL is not provided.');
      console.error('Usage: npm run webhook:set -- <webhook_url> [secret_token]');
      process.exit(1);
    }

    if (!webhookUrl.startsWith('https://')) {
      console.error('❌ Error: Telegram Webhook URL must use HTTPS (e.g. https://domain.com/api/v1/telegram/webhook)');
      process.exit(1);
    }

    let secretToken = process.argv[4] || env.TELEGRAM_WEBHOOK_SECRET;
    if (!secretToken) {
      // Auto-generate high-entropy 32-character secret token
      secretToken = crypto.randomBytes(32).toString('base64url');
      console.log(`🔑 Generated secure random secret_token: ${secretToken}`);
      console.log(`⚠️  Add this to your .env: TELEGRAM_WEBHOOK_SECRET=${secretToken}\n`);
    }

    console.log(`🔗 Setting webhook to: ${webhookUrl}`);
    console.log(`🛡️  Enforcing secret_token verification via X-Telegram-Bot-Api-Secret-Token...`);

    await bot.api.setWebhook(webhookUrl, {
      secret_token: secretToken,
      drop_pending_updates: false,
    });

    console.log('✅ Webhook successfully registered with Telegram!');
    const info = await bot.api.getWebhookInfo();
    console.log(`📋 Verified Telegram Webhook URL: ${info.url}`);
    return;
  }

  if (action === 'delete' || action === 'clear') {
    console.log('🗑️  Deleting Telegram Webhook (switching back to long-polling mode)...');
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log('✅ Webhook deleted. Bot can now safely use long-polling (bot.start()).');
    return;
  }

  console.error(`Unknown action: ${action}. Available actions: info, set, delete.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('💥 Webhook manager error:', err);
  process.exit(1);
});
