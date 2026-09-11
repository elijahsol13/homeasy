import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import { env } from '../../../config/env';

const WELCOME_TEXT = `
🏡 <b>Welcome to HomEasy — Rent & Property Cambodia!</b>

Tired of scrolling through noisy Facebook groups, spam posts, and outdated ads? <b>HomEasy does the hard work for you:</b>

🎙️ <b>AI Voice & Text Search:</b> Just send a voice note or type what you need in chat (e.g. <i>"1BR apartment in Wat Bo under $350"</i>)!
⚡️ <b>Instant Alerts:</b> Get new listings in Telegram the moment agents post them.
🗺 <b>Interactive Map & Catalog:</b> Browse listings with photos and filters on the map.
🤖 <b>AI-Powered Quality:</b> Automatically translates Khmer text, extracts pricing & specs, and filters spam.
🎯 <b>Laser-Focused Search:</b> Filter by Sangkat, budget, bedrooms, swimming pool, and lease terms.
👥 <b>Direct Contacts:</b> Phone numbers, Telegram & WhatsApp straight from the listing.

👇 <b>Get started below:</b> Speak/type your search, open the Mini App, or set up an alert!
`.trim();

const HELP_TEXT = `
🏡 <b>HomEasy — How it works</b>

<b>Find a home:</b>
• 🎙️ Send a <b>voice note</b> (up to 30s) or just <b>type</b> what you need — e.g. <i>"1BR apartment in Wat Bo under $350"</i>. Gemini AI parses your criteria and shows instant matches.
• 🛠 Prefer manual setup? Use the <b>Step-by-Step Wizard</b> via /search.
• 📱 Browse everything on the interactive map via /app.

<b>Stay updated:</b>
• 🔔 Save any search as an <b>alert</b> — new matching listings land in your chat automatically.
• 🛠 /myfilters — view & delete your alerts.
• ⭐ /favorites — listings you saved.
• ⏸ Pause/resume alerts from the /menu.

<b>Commands:</b>
/start — main menu
/search — AI search & alert setup
/app — Mini App (map & catalog)
/myfilters — your alerts
/favorites — saved listings
/stop — unsubscribe from all notifications
/help — this message
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

  handler.command('help', async (ctx) => {
    const from = ctx.from;
    const user = from ? container.usersRepo.findByTelegramId(from.id) : null;
    const isAdmin = from ? (env.ADMIN_IDS.includes(from.id) || user?.role === 'admin') : false;
    await ctx.reply(HELP_TEXT, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard({ alertsPaused: user?.alerts_paused === 1, isAdmin }),
    });
  });

  /** Handles /stop — marks user inactive so they don't receive notifications. */
  handler.command('stop', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    container.usersRepo.setActive(from.id, false);

    await ctx.reply(
      '👋 You have been unsubscribed from all HomEasy notifications.\n\n' +
        '💡 <i>To pause search alerts temporarily instead, use the ⏸ Pause Alerts button in /menu.</i>\n\n' +
        'Send /start anytime to reactivate.',
      { parse_mode: 'HTML' },
    );
  });

  return handler;
}
