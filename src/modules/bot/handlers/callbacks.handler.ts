import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { startFilterWizard, showUserFilters, handleFilterCallback } from './filters.handler';
import {
  showFavorites,
  handleSaveProperty,
  handleViewFavorite,
  handleRemoveFavorite,
  handleFavoritesPage,
} from './favorites.handler';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';

export function createCallbacksHandler(_container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  handler.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    try {
      await route(ctx, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore "message is not modified" — happens when double-clicking a button
      if (msg.includes('message is not modified')) {
        await safeAnswer(ctx);
        return;
      }
      console.error(`⚠️  Callback error [${data}]:`, err);
      await safeAnswer(ctx, '❌ Something went wrong');
    }
  });

  return handler;
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function route(ctx: MyContext, data: string): Promise<void> {

  // ── Main menu ──────────────────────────────────────────────────────────────

  if (data === 'cb:menu:main') {
    const from = ctx.from;
    const user = from ? ctx.container.usersRepo.upsertUser(from.id, from.username ?? null) : null;
    await ctx.editMessageText('📋 <b>Main Menu</b>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user?.alerts_paused === 1),
    });
    await safeAnswer(ctx);
    return;
  }

  if (data === 'cb:alerts:pause') {
    const from = ctx.from;
    if (from) ctx.container.usersRepo.setAlertsPaused(from.id, true);
    await ctx.editMessageText('📋 <b>Main Menu</b>\n\n⏸ <i>Alerts are paused. You will not receive notifications.</i>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(true),
    });
    await safeAnswer(ctx, '⏸ Alerts paused');
    return;
  }

  if (data === 'cb:alerts:resume') {
    const from = ctx.from;
    if (from) ctx.container.usersRepo.setAlertsPaused(from.id, false);
    await ctx.editMessageText('📋 <b>Main Menu</b>\n\n▶️ <i>Alerts are active! You will receive notifications for new matches.</i>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(false),
    });
    await safeAnswer(ctx, '▶️ Alerts resumed');
    return;
  }

  if (data === 'cb:menu:search') {
    await startFilterWizard(ctx);
    return;
  }

  if (data === 'cb:menu:favorites') {
    await showFavorites(ctx);
    await safeAnswer(ctx);
    return;
  }

  if (data === 'cb:menu:filters') {
    await showUserFilters(ctx);
    await safeAnswer(ctx);
    return;
  }

  // ── Filter wizard callbacks ────────────────────────────────────────────────
  if (data.startsWith('cb:filter:')) {
    await handleFilterCallback(ctx, data);
    return;
  }

  // ── Property actions ───────────────────────────────────────────────────────

  if (data.startsWith('cb:prop:save:')) {
    const id = parseInt(data.replace('cb:prop:save:', ''), 10);
    if (!isNaN(id)) await handleSaveProperty(ctx, id);
    return;
  }

  if (data.startsWith('cb:prop:hide:')) {
    try {
      await ctx.deleteMessage();
    } catch {
      // Message may already be gone; silently ignore
    }
    await safeAnswer(ctx, '🙈 Listing hidden');
    return;
  }

  if (data.startsWith('cb:prop:report:')) {
    const id = parseInt(data.replace('cb:prop:report:', ''), 10);
    if (!isNaN(id)) {
      const { reports_count, is_active } = ctx.container.propertiesRepo.reportProperty(id);
      if (!is_active) {
        console.log(`🚩 Property #${id} has been deactivated (reached ${reports_count} reports)`);
      }
      await safeAnswer(ctx, '🚩 Thanks for helping the community! This listing has been reported.');
    } else {
      await safeAnswer(ctx, '⚠️ Invalid property');
    }
    return;
  }

  // ── Favorites ──────────────────────────────────────────────────────────────

  if (data.startsWith('cb:fav:view:')) {
    const id = parseInt(data.replace('cb:fav:view:', ''), 10);
    if (!isNaN(id)) await handleViewFavorite(ctx, id);
    return;
  }

  if (data.startsWith('cb:fav:remove:')) {
    const id = parseInt(data.replace('cb:fav:remove:', ''), 10);
    if (!isNaN(id)) await handleRemoveFavorite(ctx, id);
    return;
  }

  if (data.startsWith('cb:fav:page:')) {
    const page = parseInt(data.replace('cb:fav:page:', ''), 10);
    if (!isNaN(page)) await handleFavoritesPage(ctx, page);
    return;
  }

  // Fallback
  await safeAnswer(ctx, '⚠️ Unknown action');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Answers a callback query without throwing if it was already answered. */
async function safeAnswer(ctx: MyContext, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text } : {});
  } catch {
    // Query already answered — safe to ignore
  }
}
