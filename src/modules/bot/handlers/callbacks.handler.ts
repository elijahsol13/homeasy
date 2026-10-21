import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { startFilterWizard, showUserFilters, handleFilterCallback } from './filters.handler';
import {
  showFavorites,
  handleSaveProperty,
  handleViewFavorite,
  handleRemoveFavorite,
  handleFavoritesPage,
  handleSaveCanonicalProperty,
  handleViewCanonicalFavorite,
  handleRemoveCanonicalFavorite,
} from './favorites.handler';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import { env } from '../../../config/env';
import { listingReadPathForUser } from '../../api/listing-read-path';

const PUBLIC_REF_PATTERN = /^lst_[a-f0-9]{32}$/;

function positiveInteger(raw: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function pageNumber(raw: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function createCallbacksHandler(_container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  handler.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    try {
      const handled = await route(ctx, data);
      if (!handled) {
        return next();
      }
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

async function route(ctx: MyContext, data: string): Promise<boolean> {

  // ── Main menu ──────────────────────────────────────────────────────────────

  if (data === 'cb:menu:main') {
    const from = ctx.from;
    const user = from ? ctx.container.usersRepo.upsertUser(from.id, from.username ?? null) : null;
    const isAdmin = from ? (env.ADMIN_IDS.includes(from.id) || user?.role === 'admin') : false;
    await ctx.editMessageText('📋 <b>Main Menu</b>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard({ alertsPaused: user?.alerts_paused === 1, isAdmin }),
    });
    await safeAnswer(ctx);
    return true;
  }

  if (data === 'cb:alerts:pause') {
    const from = ctx.from;
    const user = from ? ctx.container.usersRepo.findByTelegramId(from.id) : null;
    const isAdmin = from ? (env.ADMIN_IDS.includes(from.id) || user?.role === 'admin') : false;
    if (from) ctx.container.usersRepo.setAlertsPaused(from.id, true);
    await ctx.editMessageText('📋 <b>Main Menu</b>\n\n⏸ <i>Alerts are paused. You will not receive notifications.</i>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard({ alertsPaused: true, isAdmin }),
    });
    await safeAnswer(ctx, '⏸ Alerts paused');
    return true;
  }

  if (data === 'cb:alerts:resume') {
    const from = ctx.from;
    const user = from ? ctx.container.usersRepo.findByTelegramId(from.id) : null;
    const isAdmin = from ? (env.ADMIN_IDS.includes(from.id) || user?.role === 'admin') : false;
    if (from) ctx.container.usersRepo.setAlertsPaused(from.id, false);
    await ctx.editMessageText('📋 <b>Main Menu</b>\n\n▶️ <i>Alerts are active! You will receive notifications for new matches.</i>', {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard({ alertsPaused: false, isAdmin }),
    });
    await safeAnswer(ctx, '▶️ Alerts resumed');
    return true;
  }

  if (data === 'cb:menu:search') {
    const webUrl = env.WEBAPP_URL;
    const kb = new InlineKeyboard()
      .text('🛠 Step-by-Step Wizard', 'cb:filter:wizard:start')
      .row();
    if (webUrl && (webUrl.startsWith('https://') || webUrl.startsWith('http://'))) {
      if (webUrl.startsWith('https://')) {
        kb.webApp('📱 Open Map & Catalog', webUrl).row();
      } else {
        kb.url('📱 Open Map & Catalog', webUrl).row();
      }
    }
    kb.text('🔙 Main Menu', 'cb:menu:main');

    await ctx.editMessageText(
      '🔍 <b>Find Properties & Create Alerts</b>\n\n' +
        'HomEasy offers two ways to find listings and set alerts:\n\n' +
        '🎙️ <b>AI Voice & Text Search (Instant):</b>\n' +
        'Simply send a <b>voice message</b> (up to 30s) or type in chat what you need (e.g. <i>"1BR apartment in Wat Bo under $350"</i> or <i>"2-bedroom villa with private pool in Siem Reap under $800"</i>). Gemini AI will parse your criteria instantly!\n\n' +
        '🛠 <b>Manual Step-by-Step Wizard:</b>\n' +
        'Tap below to configure criteria manually step by step.',
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
    await safeAnswer(ctx);
    return true;
  }

  if (data === 'cb:filter:wizard:start') {
    await startFilterWizard(ctx);
    await safeAnswer(ctx);
    return true;
  }

  if (data === 'cb:menu:favorites') {
    await showFavorites(ctx);
    await safeAnswer(ctx);
    return true;
  }

  if (data === 'cb:menu:filters' || data === 'cb:menu:new_filter') {
    await showUserFilters(ctx);
    await safeAnswer(ctx);
    return true;
  }

  // ── Filter wizard callbacks ────────────────────────────────────────────────
  if (data.startsWith('cb:filter:')) {
    await handleFilterCallback(ctx, data);
    return true;
  }

  // ── Property actions ───────────────────────────────────────────────────────

  // Telegram keyboards persist in old messages across rollout. Once the user
  // moves to canonical listings, legacy numeric buttons must not modify the
  // rollback favorites or report a different legacy listing with the same ID.
  if ((data.startsWith('cb:prop:') || data.startsWith('cb:fav:'))
    && listingReadPathForUser(ctx.from?.id) === 'canonical') {
    await safeAnswer(ctx, '⚠️ Old button. Open the current catalog or favorites.');
    return true;
  }

  // Opaque canonical references are never parsed as legacy integer IDs.
  if (data.startsWith('cb:cl:') || data.startsWith('cb:clfav:')) {
    const match = /^cb:(cl|clfav):(save|hide|report|view|remove|page):(.+)$/.exec(data);
    if (!match) {
      await safeAnswer(ctx, '⚠️ Invalid action');
      return true;
    }
    const [, scope, action, value] = match;
    if (scope === 'clfav' && action === 'page') {
      const page = pageNumber(value!);
      if (page !== undefined) await handleFavoritesPage(ctx, page, 'canonical');
      else await safeAnswer(ctx, '⚠️ Invalid page');
      return true;
    }
    if (!PUBLIC_REF_PATTERN.test(value!)) {
      await safeAnswer(ctx, '⚠️ Invalid listing');
      return true;
    }
    if (listingReadPathForUser(ctx.from?.id) !== 'canonical') {
      await safeAnswer(ctx, '⚠️ Action no longer available');
      return true;
    }
    if (scope === 'cl' && action === 'save') await handleSaveCanonicalProperty(ctx, value!);
    else if (scope === 'clfav' && action === 'view') await handleViewCanonicalFavorite(ctx, value!);
    else if (scope === 'clfav' && action === 'remove') await handleRemoveCanonicalFavorite(ctx, value!);
    else if (scope === 'cl' && action === 'hide') {
      const identity = ctx.container.listingIdentityRepo.resolvePublicRef(value!);
      if (!identity) await safeAnswer(ctx, '❌ Listing no longer available');
      else {
        try { await ctx.deleteMessage(); } catch { /* Already deleted. */ }
        await safeAnswer(ctx, '🙈 Listing hidden');
      }
    } else if (scope === 'cl' && action === 'report') {
      const user = ctx.from && ctx.container.usersRepo.findByTelegramId(ctx.from.id);
      const identity = ctx.container.listingIdentityRepo.resolvePublicRef(value!);
      if (!user) await safeAnswer(ctx, '❌ Please /start the bot first');
      else if (!identity || !ctx.container.canonicalListingRepo.getPropertyById(identity.listingId)) {
        await safeAnswer(ctx, '❌ Listing no longer available');
      } else {
        const { added, total } = ctx.container.canonicalReportsRepo.report(identity.listingId, user.id);
        if (added) {
          ctx.container.analyticsRepo.trackEvent({
            userId: user.id, telegramId: ctx.from?.id,
            eventType: 'listing_reported', metadata: { publicRef: identity.publicRef },
          });
          // Reports require moderator review. A complaint never changes a
          // canonical listing's status or a colliding legacy record.
          if (total === 1) {
            await ctx.container.alertService.warn(`Canonical listing ${identity.publicRef} received a report; manual review required.`);
          }
        }
        await safeAnswer(ctx, added ? '🚩 Thank you. Sent for review.' : '🚩 You already reported this listing.');
      }
    } else await safeAnswer(ctx, '⚠️ Invalid action');
    return true;
  }

  if (data.startsWith('cb:prop:save:')) {
    const id = positiveInteger(data.slice('cb:prop:save:'.length));
    if (id !== undefined) await handleSaveProperty(ctx, id);
    else await safeAnswer(ctx, '⚠️ Invalid property');
    return true;
  }

  if (data.startsWith('cb:prop:hide:')) {
    if (positiveInteger(data.slice('cb:prop:hide:'.length)) === undefined) {
      await safeAnswer(ctx, '⚠️ Invalid property');
      return true;
    }
    try {
      await ctx.deleteMessage();
    } catch {
      // Message may already be gone; silently ignore
    }
    await safeAnswer(ctx, '🙈 Listing hidden');
    return true;
  }

  if (data.startsWith('cb:prop:report:')) {
    const id = positiveInteger(data.slice('cb:prop:report:'.length));
    if (id !== undefined && ctx.container.propertiesRepo.getPropertyById(id)) {
      const { is_active } = ctx.container.propertiesRepo.reportProperty(id);
      if (!is_active) {
        await ctx.container.alertService.warn('Listing #' + id + ' hidden due to complaint threshold reached.');
      }
      ctx.container.analyticsRepo.trackEvent({
        userId: ctx.from ? ctx.container.usersRepo.findByTelegramId(ctx.from.id)?.id : null,
        telegramId: ctx.from?.id,
        eventType: 'listing_reported',
        metadata: { propertyId: id },
      });
      await safeAnswer(ctx, '🚩 Thanks for helping the community! This listing has been reported.');
    } else {
      await safeAnswer(ctx, '⚠️ Invalid property');
    }
    return true;
  }

  // ── Favorites ──────────────────────────────────────────────────────────────

  if (data.startsWith('cb:fav:view:')) {
    const id = positiveInteger(data.slice('cb:fav:view:'.length));
    if (id !== undefined) await handleViewFavorite(ctx, id);
    else await safeAnswer(ctx, '⚠️ Invalid property');
    return true;
  }

  if (data.startsWith('cb:fav:remove:')) {
    const id = positiveInteger(data.slice('cb:fav:remove:'.length));
    if (id !== undefined) await handleRemoveFavorite(ctx, id);
    else await safeAnswer(ctx, '⚠️ Invalid property');
    return true;
  }

  if (data.startsWith('cb:fav:page:')) {
    const page = pageNumber(data.slice('cb:fav:page:'.length));
    if (page !== undefined) await handleFavoritesPage(ctx, page);
    else await safeAnswer(ctx, '⚠️ Invalid page');
    return true;
  }

  // Unhandled by this router — let downstream middleware handle it
  return false;
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
