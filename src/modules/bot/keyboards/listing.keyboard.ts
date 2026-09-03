import { InlineKeyboard } from 'grammy';
import type { Property } from '../../../database/repositories/properties.repo';

// ─── Listing notification card actions ────────────────────────────────────────

export function listingActionKeyboard(property: Property): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Telegram username link (valid HTTPS URL) if present; phone numbers are displayed in message text
  if (property.direct_contact.telegram) {
    const username = property.direct_contact.telegram.replace(/^@/, '');
    if (username.length > 0) {
      kb.url('💬 Contact on Telegram', `https://t.me/${username}`).row();
    }
  }

  kb.text('⭐ Save', `cb:prop:save:${property.id}`).text(
    '🙈 Hide',
    `cb:prop:hide:${property.id}`,
  );

  if (property.original_url && (property.original_url.startsWith('http://') || property.original_url.startsWith('https://'))) {
    kb.row().url('🔗 View Original Listing', property.original_url);
  }

  kb.row().text('🚩 Report (Rented/Fake)', `cb:prop:report:${property.id}`);

  return kb;
}

// ─── Favorites list ───────────────────────────────────────────────────────────

const PAGE_SIZE = 5;

export function favoritesListKeyboard(
  properties: Property[],
  page = 0,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const start = page * PAGE_SIZE;
  const slice = properties.slice(start, start + PAGE_SIZE);

  slice.forEach((prop) => {
    const price = prop.price / 100;
    const label = `🏠 ${prop.title.slice(0, 28)} — $${price.toLocaleString('en-US')}`;
    kb.text(label, `cb:fav:view:${prop.id}`).row();
  });

  // Pagination
  const hasNext = start + PAGE_SIZE < properties.length;
  const hasPrev = page > 0;

  if (hasPrev || hasNext) {
    if (hasPrev) kb.text('⬅️ Prev', `cb:fav:page:${page - 1}`);
    if (hasNext) kb.text('Next ➡️', `cb:fav:page:${page + 1}`);
    kb.row();
  }

  kb.text('🔙 Main Menu', 'cb:menu:main');
  return kb;
}

// ─── Single favorite detail ───────────────────────────────────────────────────

export function favoriteDetailKeyboard(propertyId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗑 Remove Favorite', `cb:fav:remove:${propertyId}`)
    .row()
    .text('🔙 Back to Favorites', 'cb:menu:favorites');
}
