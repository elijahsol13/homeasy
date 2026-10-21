import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { favoriteDetailKeyboard, favoritesListKeyboard } from '../keyboards/listing.keyboard';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import { sendListingCard } from '../../../services/notifier';
import { MAX_FAVORITES_PER_USER } from '../../../config/settings';
import { listingReadPathForUser, type ListingReadPath } from '../../api/listing-read-path';

function canonicalUser(ctx: MyContext): boolean {
  return ctx.from !== undefined && listingReadPathForUser(ctx.from.id) === 'canonical';
}

function canonicalListing(ctx: MyContext, publicRef: string) {
  if (!canonicalUser(ctx)) return undefined;
  const identity = ctx.container.listingIdentityRepo.resolvePublicRef(publicRef);
  if (!identity) return undefined;
  const property = ctx.container.canonicalListingRepo.getPropertyById(identity.listingId);
  return property ? { identity, property } : undefined;
}

// ─── Favorites list ───────────────────────────────────────────────────────────

export async function showFavorites(ctx: MyContext, page = 0): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) return;

  const favorites = canonicalUser(ctx)
    ? ctx.container.favoritesRepo.getCanonicalFavorites(user.id, ctx.container.canonicalListingRepo)
    : ctx.container.favoritesRepo.getUserFavorites(user.id);

  const text =
    favorites.length === 0
      ? '⭐ <b>My Favorites</b>\n\nNo saved listings yet.\n\nTap <b>⭐ Save</b> on any notification to add listings here.'
      : `⭐ <b>My Favorites</b> (${favorites.length} listing${favorites.length !== 1 ? 's' : ''})\n\nSelect a listing to view details:`;

  const keyboard =
    favorites.length === 0 ? mainMenuKeyboard() : favoritesListKeyboard(favorites, page);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// ─── Save property ────────────────────────────────────────────────────────────

export async function handleSaveProperty(ctx: MyContext, propertyId: number): Promise<void> {
  const from = ctx.from;
  if (!from) {
    await ctx.answerCallbackQuery('❌ Please /start the bot first');
    return;
  }

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) {
    await ctx.answerCallbackQuery('❌ Please /start the bot first');
    return;
  }

  if (ctx.container.favoritesRepo.isFavorite(user.id, propertyId)) {
    await ctx.answerCallbackQuery('⭐ Already in favorites!');
    return;
  }

  const count = ctx.container.favoritesRepo.getFavoriteCount(user.id);
  if (count >= MAX_FAVORITES_PER_USER) {
    await ctx.answerCallbackQuery({
      text: `❌ Favorites limit reached (${MAX_FAVORITES_PER_USER}). Remove some to add more.`,
      show_alert: true,
    });
    return;
  }

  const added = ctx.container.favoritesRepo.addFavorite(user.id, propertyId);
  if (added) {
    ctx.container.analyticsRepo.trackEvent({
      userId: user.id,
      telegramId: from.id,
      eventType: 'listing_saved',
      metadata: { propertyId },
    });
  }
  await ctx.answerCallbackQuery(added ? '⭐ Saved to favorites!' : '❌ Could not save');
}

export async function handleSaveCanonicalProperty(ctx: MyContext, publicRef: string): Promise<void> {
  const from = ctx.from;
  if (!from || !canonicalUser(ctx)) {
    await ctx.answerCallbackQuery('⚠️ Action no longer available');
    return;
  }
  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) {
    await ctx.answerCallbackQuery('❌ Please /start the bot first');
    return;
  }
  const resolved = canonicalListing(ctx, publicRef);
  if (!resolved) {
    await ctx.answerCallbackQuery('❌ Listing no longer available');
    return;
  }
  const { listingId } = resolved.identity;
  if (ctx.container.favoritesRepo.isCanonicalFavorite(user.id, listingId)) {
    await ctx.answerCallbackQuery('⭐ Already in favorites!');
    return;
  }
  if (ctx.container.favoritesRepo.getCanonicalFavorites(user.id, ctx.container.canonicalListingRepo).length >= MAX_FAVORITES_PER_USER) {
    await ctx.answerCallbackQuery({ text: `❌ Favorites limit reached (${MAX_FAVORITES_PER_USER}).`, show_alert: true });
    return;
  }
  ctx.container.favoritesRepo.toggleCanonicalFavorite(user.id, listingId);
  ctx.container.analyticsRepo.trackEvent({
    userId: user.id, telegramId: from.id, eventType: 'listing_saved', metadata: { publicRef },
  });
  await ctx.answerCallbackQuery('⭐ Saved to favorites!');
}

// ─── View single favorite ─────────────────────────────────────────────────────

export async function handleViewFavorite(ctx: MyContext, propertyId: number): Promise<void> {
  const from = ctx.from;
  const user = from && ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user || !ctx.container.favoritesRepo.isFavorite(user.id, propertyId)) {
    await ctx.answerCallbackQuery('❌ Favorite no longer available');
    return;
  }
  const property = ctx.container.propertiesRepo.getPropertyById(propertyId);
  if (!property) {
    await ctx.answerCallbackQuery('❌ Listing no longer exists');
    return;
  }

  await sendListingCard(from.id, property, ctx.api, favoriteDetailKeyboard(property.id));
  await ctx.answerCallbackQuery();
}

export async function handleViewCanonicalFavorite(ctx: MyContext, publicRef: string): Promise<void> {
  const from = ctx.from;
  const user = from && ctx.container.usersRepo.findByTelegramId(from.id);
  const resolved = canonicalListing(ctx, publicRef);
  if (!from || !user || !resolved || !ctx.container.favoritesRepo.isCanonicalFavorite(user.id, resolved.identity.listingId)) {
    await ctx.answerCallbackQuery('❌ Favorite no longer available');
    return;
  }
  await sendListingCard(from.id, resolved.property, ctx.api, favoriteDetailKeyboard(publicRef));
  await ctx.answerCallbackQuery();
}

// ─── Remove favorite ──────────────────────────────────────────────────────────

export async function handleRemoveFavorite(ctx: MyContext, propertyId: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) return;

  const removed = ctx.container.favoritesRepo.removeFavorite(user.id, propertyId);

  if (removed) {
    await ctx.editMessageText('🗑 Removed from your favorites.', {
      reply_markup: mainMenuKeyboard(),
    });
    await ctx.answerCallbackQuery('🗑 Removed');
  } else {
    await ctx.answerCallbackQuery('❌ Not found in favorites');
  }
}

export async function handleRemoveCanonicalFavorite(ctx: MyContext, publicRef: string): Promise<void> {
  const from = ctx.from;
  const user = from && ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user || !canonicalUser(ctx)) {
    await ctx.answerCallbackQuery('⚠️ Action no longer available');
    return;
  }
  // Removal stays possible when a saved listing has since become unavailable.
  const identity = ctx.container.listingIdentityRepo.resolvePublicRef(publicRef);
  if (!identity || !ctx.container.favoritesRepo.isCanonicalFavorite(user.id, identity.listingId)) {
    await ctx.answerCallbackQuery('❌ Not found in favorites');
    return;
  }
  ctx.container.favoritesRepo.toggleCanonicalFavorite(user.id, identity.listingId);
  await ctx.editMessageText('🗑 Removed from your favorites.', { reply_markup: mainMenuKeyboard() });
  await ctx.answerCallbackQuery('🗑 Removed');
}

// ─── Paginate favorites ───────────────────────────────────────────────────────

export async function handleFavoritesPage(ctx: MyContext, page: number, path: ListingReadPath = 'legacy'): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) return;

  if (path === 'canonical' && !canonicalUser(ctx)) {
    await ctx.answerCallbackQuery('⚠️ Action no longer available');
    return;
  }
  const favorites = path === 'canonical'
    ? ctx.container.favoritesRepo.getCanonicalFavorites(user.id, ctx.container.canonicalListingRepo)
    : ctx.container.favoritesRepo.getUserFavorites(user.id);
  await ctx.editMessageReplyMarkup({ reply_markup: favoritesListKeyboard(favorites, page) });
  await ctx.answerCallbackQuery();
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createFavoritesHandler(_container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  handler.command('favorites', async (ctx) => {
    await showFavorites(ctx);
  });

  return handler;
}
