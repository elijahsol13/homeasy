import { Bot, session } from 'grammy';
import type { MyContext, SessionData } from './session';
import { initialSession } from './session';
import type { AppContainer } from '../../container';
import { createStartHandler } from './handlers/start.handler';
import { createFiltersHandler } from './handlers/filters.handler';
import { createFavoritesHandler } from './handlers/favorites.handler';
import { createAdminHandler } from './handlers/admin.handler';
import { createTelegramAuthHandler } from './handlers/telegram-auth.handler';
import { createCallbacksHandler } from './handlers/callbacks.handler';
import { createNLSearchHandler } from './handlers/nl-search.handler';
import { env } from '../../config/env';

export function createBot(container: AppContainer): Bot<MyContext> {
  const bot = new Bot<MyContext>(env.BOT_TOKEN);

  // ── Middleware stack ─────────────────────────────────────────────────────────

  // Inject DI container into context
  bot.use(async (ctx, next) => {
    ctx.container = container;
    await next();
  });

  // In-memory session (swap for @grammyjs/storage-file or -redis in production)
  bot.use(
    session<SessionData, MyContext>({
      initial: initialSession,
    }),
  );

  // Analytics tracking middleware
  bot.use(async (ctx, next) => {
    try {
      const fromId = ctx.from?.id;
      if (fromId) {
        if (ctx.message?.text?.startsWith('/')) {
          const command = ctx.message.text.split(' ')[0]!.toLowerCase();
          container.analyticsRepo.trackEvent({
            telegramId: fromId,
            eventType: 'bot_command',
            metadata: { command },
          });
        } else if (ctx.callbackQuery?.data) {
          const action = ctx.callbackQuery.data.split(':')[0] || 'action';
          container.analyticsRepo.trackEvent({
            telegramId: fromId,
            eventType: 'bot_callback',
            metadata: { action, data: ctx.callbackQuery.data },
          });
        }
      }
    } catch {
      // Never let analytics disruption affect user flow
    }
    await next();
  });

  // ── Global error handler ─────────────────────────────────────────────────────
  bot.catch((err) => {
    console.error('⚠️  Unhandled bot error:', err.message);
    if (env.NODE_ENV === 'development') {
      console.error(err.error);
    }
  });

  // ── Handlers (order matters — first match wins) ───────────────────────────────
  bot.use(createStartHandler(container));
  bot.use(createAdminHandler(container));
  bot.use(createTelegramAuthHandler(container));
  bot.use(createFiltersHandler(container));
  bot.use(createFavoritesHandler(container));
  bot.use(createNLSearchHandler(container));
  bot.use(createCallbacksHandler(container));

  // Global fallback for unhandled callback queries
  bot.on('callback_query:data', async (ctx) => {
    try {
      await ctx.answerCallbackQuery('⚠️ Action no longer available');
    } catch {
      // Safe to ignore if already answered
    }
  });

  return bot;
}
