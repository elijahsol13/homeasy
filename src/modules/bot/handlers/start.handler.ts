import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import { env } from '../../../config/env';

const WELCOME_TEXT = `
🏡 <b>Welcome to HomEasy — Cambodia Real Estate Aggregator!</b>

Tired of scrolling through noisy Facebook groups, spam posts, and outdated ads? <b>HomEasy does the hard work for you:</b>

⚡️ <b>Instant Alerts:</b> Get new listings in Telegram the moment agents post them.
🤖 <b>AI-Powered Filter:</b> Automatically translates Khmer text, summarizes key features, and strips spam & fake ads.
🎯 <b>Laser-Focused Search:</b> Filter by Sangkat, budget, bedrooms, swimming pool, and lease terms.
👥 <b>Direct Contacts:</b> Verified phone numbers and Telegram usernames of agents and owners.

👇 <b>Get started below:</b> Set up your search filter or manage your alerts.
`.trim();

export function createStartHandler(container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  handler.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    // Register / update user in DB
    const user = container.usersRepo.upsertUser(from.id, from.username ?? null);

    // Auto-promote if telegram_id is in ADMIN_IDS and not yet an admin
    if (env.ADMIN_IDS.includes(from.id) && user.role !== 'admin') {
      container.usersRepo.promoteToAdmin(from.id);
      console.log(`👑 Auto-promoted user ${from.id} (@${from.username}) to admin`);
    }

    await ctx.reply(WELCOME_TEXT, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user.alerts_paused === 1),
    });
  });

  handler.command('menu', async (ctx) => {
    const from = ctx.from;
    const user = from ? container.usersRepo.upsertUser(from.id, from.username ?? null) : null;
    await ctx.reply('📋 <b>Main Menu</b>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user?.alerts_paused === 1),
    });
  });

  /** Handles /stop — marks user inactive so they don't receive notifications. */
  handler.command('stop', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    container.usersRepo.setActive(from.id, false);

    await ctx.reply(
      '👋 You have been unsubscribed from HomEasy notifications.\nSend /start anytime to reactivate.',
    );
  });

  return handler;
}
