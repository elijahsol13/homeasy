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

const PUBLIC_REF_PATTERN = /^lst_[a-f0-9]{32}$/;

/** Canonical Telegram actions must never serialize the overlapping numeric ID. */
function actionIdentity(property: Property): { prefix: string; id: string } {
  if (property.public_listing_ref !== undefined) {
    if (!PUBLIC_REF_PATTERN.test(property.public_listing_ref)) {
      throw new Error('Canonical listing has an invalid public reference');
    }
    return { prefix: 'cb:cl', id: property.public_listing_ref };
  }
  return { prefix: 'cb:prop', id: String(property.id) };
}

export function listingActionKeyboard(property: Property): InlineKeyboard {
  const kb = new InlineKeyboard();
  const { prefix, id } = actionIdentity(property);

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

  kb.text('⭐ Save', `${prefix}:save:${id}`).text(
    '🙈 Hide',
    `${prefix}:hide:${id}`,
  );

  let origUrl = property.original_url;
  if (origUrl && origUrl.includes('web.facebook.com')) {
    origUrl = origUrl.replace('web.facebook.com', 'www.facebook.com');
  }

  if (origUrl && (origUrl.startsWith('http://') || origUrl.startsWith('https://'))) {
    kb.row().url('🔗 View Original Listing', origUrl);
  }

  kb.row().text('🚩 Report (Rented/Fake)', `${prefix}:report:${id}`);

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
    const identity = actionIdentity(prop);
    const priceLabel =
      prop.price > 0 ? `$${(prop.price / 100).toLocaleString('en-US')}` : 'price on request';
    const label = `🏠 ${prop.title.slice(0, 28)} — ${priceLabel}`;
    kb.text(label, identity.prefix === 'cb:cl' ? `cb:clfav:view:${identity.id}` : `cb:fav:view:${identity.id}`).row();
  });

  // Pagination
  const hasNext = start + PAGE_SIZE < properties.length;
  const hasPrev = page > 0;

  if (hasPrev || hasNext) {
    const pagePrefix = properties.some((prop) => prop.public_listing_ref !== undefined) ? 'cb:clfav' : 'cb:fav';
    if (hasPrev) kb.text('⬅️ Prev', `${pagePrefix}:page:${page - 1}`);
    if (hasNext) kb.text('Next ➡️', `${pagePrefix}:page:${page + 1}`);
    kb.row();
  }

  kb.text('🔙 Main Menu', 'cb:menu:main');
  return kb;
}

// ─── Single favorite detail ───────────────────────────────────────────────────

export function favoriteDetailKeyboard(propertyId: number | string): InlineKeyboard {
  if (typeof propertyId === 'string' && !PUBLIC_REF_PATTERN.test(propertyId)) {
    throw new Error('Invalid canonical favorite reference');
  }
  return new InlineKeyboard()
    .text('🗑 Remove Favorite', typeof propertyId === 'string'
      ? `cb:clfav:remove:${propertyId}` : `cb:fav:remove:${propertyId}`)
    .row()
    .text('🔙 Back to Favorites', 'cb:menu:favorites');
}
