import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { favoriteDetailKeyboard, favoritesListKeyboard } from '../keyboards/listing.keyboard';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import { formatListingCard } from '../../../services/notifier';
import { MAX_FAVORITES_PER_USER } from '../../../config/settings';

// ─── Favorites list ───────────────────────────────────────────────────────────

export async function showFavorites(ctx: MyContext, page = 0): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) return;

  const favorites = ctx.container.favoritesRepo.getUserFavorites(user.id);

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
  await ctx.answerCallbackQuery(added ? '⭐ Saved to favorites!' : '❌ Could not save');
}

// ─── View single favorite ─────────────────────────────────────────────────────

export async function handleViewFavorite(ctx: MyContext, propertyId: number): Promise<void> {
  const property = ctx.container.propertiesRepo.getPropertyById(propertyId);
  if (!property) {
    await ctx.answerCallbackQuery('❌ Listing no longer exists');
    return;
  }

  const card = formatListingCard(property);

  if (property.photos.length > 0) {
    await ctx.replyWithPhoto(property.photos[0]!, {
      caption: card,
      parse_mode: 'HTML',
      reply_markup: favoriteDetailKeyboard(property.id),
    });
  } else {
    await ctx.reply(card, {
      parse_mode: 'HTML',
      reply_markup: favoriteDetailKeyboard(property.id),
    });
  }

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

// ─── Paginate favorites ───────────────────────────────────────────────────────

export async function handleFavoritesPage(ctx: MyContext, page: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) return;

  const favorites = ctx.container.favoritesRepo.getUserFavorites(user.id);
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
