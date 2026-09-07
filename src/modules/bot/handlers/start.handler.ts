import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import { env } from '../../../config/env';

const WELCOME_TEXT = `
🏡 <b>Welcome to HomEasy — Rent & Property Cambodia!</b>

Tired of scrolling through noisy Facebook groups, spam posts, and outdated ads? <b>HomEasy does the hard work for you:</b>

⚡️ <b>Instant Alerts:</b> Get new listings in Telegram the moment agents post them.
🗺 <b>Interactive Map & Catalog:</b> Browse listings with photos and filters on the map.
🤖 <b>AI-Powered Quality:</b> Automatically translates Khmer text, extracts pricing & specs, and filters spam.
🎯 <b>Laser-Focused Search:</b> Filter by Sangkat, budget, bedrooms, swimming pool, and lease terms.
👥 <b>Direct Contacts:</b> Verified phone numbers and Telegram direct messages.

👇 <b>Get started below:</b> Open the Mini App or set up your search alert!
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

    const isAdmin = env.ADMIN_IDS.includes(from.id) || user.role === 'admin';

    await ctx.reply(WELCOME_TEXT, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard({ alertsPaused: user.alerts_paused === 1, isAdmin }),
    });
  });

  handler.command('menu', async (ctx) => {
    const from = ctx.from;
    const user = from ? container.usersRepo.upsertUser(from.id, from.username ?? null) : null;
    const isAdmin = from ? (env.ADMIN_IDS.includes(from.id) || user?.role === 'admin') : false;
    await ctx.reply('📋 <b>Main Menu</b>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard({ alertsPaused: user?.alerts_paused === 1, isAdmin }),
    });
  });

  handler.command('app', async (ctx) => {
    if (env.WEBAPP_URL && env.WEBAPP_URL.startsWith('https://')) {
      await ctx.reply(
        '📱 <b>HomEasy Interactive Map & Catalog</b>\n\nTap below to explore properties on the map, filter by Sangkat, and browse listings:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📱 Open Mini App', web_app: { url: env.WEBAPP_URL } }],
            ],
          },
        },
      );
    } else {
      const from = ctx.from;
      const user = from ? container.usersRepo.findByTelegramId(from.id) : null;
      const isAdmin = from ? (env.ADMIN_IDS.includes(from.id) || user?.role === 'admin') : false;
      await ctx.reply('📋 <b>Main Menu</b>', {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard({ alertsPaused: user?.alerts_paused === 1, isAdmin }),
      });
    }
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
