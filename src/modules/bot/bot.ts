import { Bot, session } from 'grammy';
import type { MyContext, SessionData } from './session';
import { initialSession } from './session';
import type { AppContainer } from '../../container';
import { createStartHandler } from './handlers/start.handler';
import { createFiltersHandler } from './handlers/filters.handler';
import { createFavoritesHandler } from './handlers/favorites.handler';
import { createAdminHandler } from './handlers/admin.handler';
import { createCallbacksHandler } from './handlers/callbacks.handler';
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
  bot.use(createFiltersHandler(container));
  bot.use(createFavoritesHandler(container));
  bot.use(createCallbacksHandler(container));

  return bot;
}
