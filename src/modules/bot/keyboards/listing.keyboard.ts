import { InlineKeyboard } from 'grammy';
import type { Property } from '../../../database/repositories/properties.repo';
import { normalizePhoneNumber } from '../../parser/normalizer';

/**
 * Returns a direct Telegram link (username or international phone protocol) if available.
 */
export function getTelegramContactLink(directContact?: { phone?: string; telegram?: string; whatsapp?: string }): string | null {
  if (!directContact) return null;

  if (directContact.telegram) {
    const raw = directContact.telegram.trim();
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw;
    }
    if (raw.startsWith('@')) {
      return `https://t.me/${raw.slice(1)}`;
    }
    const digits = normalizePhoneNumber(raw);
    if (digits && digits.length >= 8) {
      return `https://t.me/+${digits}`;
    }
    const username = raw.replace(/^@/, '').trim();
    if (username.length > 0) {
      return `https://t.me/${username}`;
    }
  }

  if (directContact.phone) {
    const firstPhone = directContact.phone.split(/[/,|\n]+/)[0]?.trim();
    const digits = normalizePhoneNumber(firstPhone);
    if (digits && digits.length >= 8) {
      return `https://t.me/+${digits}`;
    }
  }

  return null;
}

// ─── Listing notification card actions ────────────────────────────────────────

export function listingActionKeyboard(property: Property): InlineKeyboard {
  const kb = new InlineKeyboard();

  // 1. Direct Message on Telegram / WhatsApp
  const tgLink = getTelegramContactLink(property.direct_contact);
  let hasDirectChat = false;
  if (tgLink) {
    kb.url('💬 DM on Telegram', tgLink);
    hasDirectChat = true;
  }
  if (property.direct_contact.whatsapp) {
    const digits = normalizePhoneNumber(property.direct_contact.whatsapp);
    if (digits) {
      kb.url('🟢 WhatsApp', `https://wa.me/${digits}`);
      hasDirectChat = true;
    }
  }
  if (hasDirectChat) {
    kb.row();
  }

  kb.text('⭐ Save', `cb:prop:save:${property.id}`).text(
    '🙈 Hide',
    `cb:prop:hide:${property.id}`,
  );

  let origUrl = property.original_url;
  if (origUrl && origUrl.includes('web.facebook.com')) {
    origUrl = origUrl.replace('web.facebook.com', 'www.facebook.com');
  }

  if (origUrl && (origUrl.startsWith('http://') || origUrl.startsWith('https://'))) {
    kb.row().url('🔗 View Original Listing', origUrl);
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
