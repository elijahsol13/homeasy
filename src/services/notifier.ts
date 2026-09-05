import { Api, InlineKeyboard } from 'grammy';
import type { Property } from '../database/repositories/properties.repo';
import { CITIES, KHR_TO_USD_RATE, RATE_LIMIT } from '../config/settings';
import { listingActionKeyboard } from '../modules/bot/keyboards/listing.keyboard';
import { formatPhoneNumber } from '../modules/parser/normalizer';
import { env } from '../config/env';

// ─── Formatters & Pure Utilities ─────────────────────────────────────────────

export function formatPrice(priceCents: number, currency: 'USD' | 'KHR'): string {
  if (currency === 'KHR') {
    const khr = Math.round((priceCents / 100) * KHR_TO_USD_RATE);
    return `${khr.toLocaleString('en-US')} ៛`;
  }
  const usd = priceCents / 100;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
}

export function formatListingTimestamp(rawDate?: string): string {
  if (!rawDate) return '🕒 Added: Recently';
  const d = new Date(rawDate);
  if (isNaN(d.getTime())) return '🕒 Added: Recently';

  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  if (isToday) {
    return `🕒 Added: Today at ${timeStr}`;
  }
  if (isYesterday) {
    return `🕒 Added: Yesterday at ${timeStr}`;
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `🕒 Added: ${yyyy}-${mm}-${dd} at ${timeStr}`;
}

export function extractCleaning(text: string): string | null {
  if (!text) return null;

  // Negative check
  if (/\b(?:no|without)\s+cleaning\b/i.test(text)) {
    return null;
  }

  // 1. Weekly frequency, e.g. "cleaning 1 time/week", "cleaning 2 times a week", "cleaning 2x/week", "cleaning 3 times/wk", "3x/week cleaning"
  const weekMatch =
    text.match(/\bcleaning\s*(?:service\s*)?(\d+)\s*(?:times?|x)?\s*(?:\/|a|per)\s*(?:week|wk)\b/i) ||
    text.match(/\b(\d+)\s*(?:times?|x)?\s*(?:\/|a|per)\s*(?:week|wk)\s*(?:of\s+)?cleaning\b/i) ||
    text.match(/\b(\d+)\s*(?:times?|x)\s*cleaning\s*(?:\/|a|per)\s*(?:week|wk)\b/i);
  if (weekMatch && weekMatch[1]) {
    return `🧹 Cleaning ${weekMatch[1]}x/week`;
  }

  // 2. Monthly frequency, e.g. "cleaning 2 times/month", "cleaning 2x a month", "2 times a month cleaning"
  const monthMatch =
    text.match(/\bcleaning\s*(?:service\s*)?(\d+)\s*(?:times?|x)?\s*(?:\/|a|per)\s*month\b/i) ||
    text.match(/\b(\d+)\s*(?:times?|x)?\s*(?:\/|a|per)\s*month\s*(?:of\s+)?cleaning\b/i) ||
    text.match(/\b(\d+)\s*(?:times?|x)\s*cleaning\s*(?:\/|a|per)\s*month\b/i);
  if (monthMatch && monthMatch[1]) {
    return `🧹 Cleaning ${monthMatch[1]}x/month`;
  }

  // 3. Daily cleaning
  if (/\b(?:daily cleaning|cleaning every day|cleaning daily)\b/i.test(text)) {
    return '🧹 Daily Cleaning';
  }

  // 4. Cleaning included / maid service / housekeeping
  if (
    /\b(?:cleaning included|free cleaning|cleaning service included|housekeeping(?: included)?|maid service(?: included)?)\b/i.test(text) ||
    /\b(?:includes?|with|free)\s+cleaning(?: service)?\b/i.test(text) ||
    /សេវាសំអាត|សំអាត/.test(text)
  ) {
    return '🧹 Cleaning Included';
  }

  return null;
}

export function extractRestrictions(text: string): string[] {
  if (!text) return [];
  const restrictions: string[] = [];

  // 1. Pets prohibited
  if (
    /\b(?:no\s+pets?|no\s+dogs?|no\s+cats?|no\s+animals?|strictly\s+no\s+pets?|pets?\s+prohibited|not\s+pet[\s-]friendly|not\s+allow(?:ed)?\s+pets?)\b/i.test(
      text,
    ) ||
    /\b(?:pets?|dogs?|cats?|animals?)(?:\s+(?:and|or|&)\s+(?:pets?|dogs?|cats?|animals?))*\s+(?:are\s+)?not\s+allowed\b/i.test(
      text,
    ) ||
    /ហាមចិញ្ចឹមសត្វ|ហាមសត្វ/.test(text)
  ) {
    restrictions.push('🚫 No Pets');
  }

  // 2. Smoking prohibited
  if (
    /\b(?:no\s+smoking|non[\s-]smoking|no\s+smoke|smoking\s+(?:is\s+)?not\s+allowed|strictly\s+no\s+smoking|smoking\s+prohibited|smoke[\s-]free)\b/i.test(
      text,
    ) ||
    /ហាមជក់បារី/.test(text)
  ) {
    restrictions.push('🚭 No Smoking');
  }

  // 3. Parties / Quiet hours / Noise
  if (
    /\b(?:no\s+part(?:y|ies)|quiet\s+hours?|no\s+loud\s+(?:music|noise)|no\s+events?|strictly\s+no\s+part(?:y|ies))\b/i.test(
      text,
    )
  ) {
    restrictions.push('🤫 No Parties / Quiet Hours');
  }

  // 4. Subleasing prohibited
  if (
    /\b(?:no\s+sublease|no\s+subletting|no\s+sub[\s-]rent|no\s+sublet|cannot\s+sublease|not\s+allow(?:ed)?\s+sublease)\b/i.test(
      text,
    )
  ) {
    restrictions.push('🔒 No Subleasing');
  }

  // 5. Cooking prohibited
  if (/\b(?:no\s+cooking|no\s+heavy\s+cooking)\b/i.test(text)) {
    restrictions.push('🍳 No Cooking');
  }

  return restrictions;
}

export function formatListingCard(property: Property): string {
  const priceStr = property.price > 0 ? formatPrice(property.price, property.currency) : null;
  const cityLabel = CITIES[property.city] ?? property.city;
  const typeEmoji = property.type === 'rent' ? '🏠' : '🏷️';
  const typeLabel = property.type === 'rent' ? 'For Rent' : 'For Sale';
  const catLabel = property.category
    ? property.category === 'apartment'
      ? '🏬 Apartment / Condo'
      : property.category === 'house'
        ? '🏡 House / Villa'
        : property.category === 'hotel'
          ? '🏨 Hotel Room'
          : '🛏️ Room'
    : null;

  // 1. Price line
  const priceLine = priceStr
    ? (property.type === 'rent' ? `💰 <b>${priceStr}/mo</b>` : `💰 <b>${priceStr}</b>`)
    : '💰 <i>Contact for Price</i>';

  // 2. Terms line (Deposit, Min Lease) - Dynamic, ONLY render if present
  const terms: string[] = [];
  if (property.deposit !== null && property.deposit > 0) {
    terms.push(`Deposit: ${formatPrice(property.deposit, property.currency)}`);
  }
  if (property.min_lease !== null && property.min_lease > 0) {
    terms.push(`Min Lease: ${property.min_lease} mos`);
  }
  const termsLine = terms.length > 0 ? ` · ${terms.join(' · ')}` : '';

  // 3. Location line with smart Google Maps search link fallback
  const hasSpecificLocation =
    property.location &&
    property.location.trim().length > 0 &&
    property.location.toLowerCase() !== property.city.toLowerCase() &&
    property.location.toLowerCase() !== 'siem reap' &&
    property.location.toLowerCase() !== 'phnom penh';

  const finalMapsUrl = property.maps_url
    ? property.maps_url
    : hasSpecificLocation
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${property.location}, ${cityLabel}, Cambodia`,
        )}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${cityLabel}, Cambodia`,
        )}`;

  const locText = hasSpecificLocation
    ? `<a href="${escapeHtml(finalMapsUrl)}">📍 <b>${escapeHtml(property.location)}</b>, ${cityLabel} ↗</a>`
    : `<a href="${escapeHtml(finalMapsUrl)}">📍 <b>${cityLabel}</b> ↗</a>`;

  // 4. Features line (Bedrooms, Bathrooms, Pool, Size, Floor, Furnishing)
  const features: string[] = [];
  if (property.bedrooms !== null && property.bedrooms >= 0) {
    const beds = property.bedrooms === 0 ? 1 : property.bedrooms;
    features.push(`${beds} BR`);
  }
  if (property.bathrooms !== null && property.bathrooms > 0) {
    features.push(`${property.bathrooms} Bath`);
  }
  if (property.has_pool) {
    features.push('🏊 Pool');
  }

  // Extract additional specs (Size, Floor, Furniture) from description if present
  const desc = property.description || '';
  const sizeMatch =
    desc.match(/(?:Size|📐 Size):\s*([0-9]+(?:\.[0-9]+)?\s*(?:m²|m2|sqm|sq\.?m\.?|[xX*]\s*[0-9]+m?))/i) ||
    desc.match(/\b([0-9]{2,4}\s*(?:m²|m2|sqm))\b/i);
  if (sizeMatch && sizeMatch[1]) {
    features.push(`📐 ${sizeMatch[1].trim()}`);
  }

  const floorMatch = desc.match(/(?:Floor|🏢 Floor):\s*([0-9a-zA-Z\s]+?)(?:·|\n|$)/i);
  if (floorMatch && floorMatch[1]) {
    features.push(`🏢 ${floorMatch[1].trim()}`);
  }

  if (
    /\b(?:fully furnished|full furniture|furnished)\b/i.test(desc) &&
    !/\bunfurnished|non-furnished\b/i.test(desc)
  ) {
    features.push('🛋️ Furnished');
  }

  const featuresLine = features.length > 0 ? `\n🛏 ${features.join(' · ')}` : '';

  // 5. Amenities row (Gym, Elevator, Balcony, Parking, Security, Cleaning, Wi-Fi, Pets)
  const amenities: string[] = [];
  if (/\b(?:gym|fitness)\b/i.test(desc)) amenities.push('🏋️ Gym');
  if (/\b(?:elevator|lift)\b/i.test(desc)) amenities.push('🛗 Elevator');
  if (/\b(?:balcony|terrace)\b/i.test(desc)) amenities.push('🌅 Balcony');
  if (/\b(?:parking|garage)\b/i.test(desc)) amenities.push('🚗 Parking');
  if (/\b(?:security|24\/7|guard)\b/i.test(desc)) amenities.push('🛡️ Security');

  const cleaning = extractCleaning(desc);
  if (cleaning) amenities.push(cleaning);

  const restrictions = extractRestrictions(desc);
  const hasPetRestriction = restrictions.includes('🚫 No Pets');
  if (!hasPetRestriction && /\b(?:pet friendly|pets allowed)\b/i.test(desc)) {
    amenities.push('🐾 Pet-friendly');
  }
  if (/\b(?:free wifi|free internet|high speed wifi|wifi included)\b/i.test(desc)) amenities.push('📶 Free Wi-Fi');

  const amenitiesLine = amenities.length > 0 ? `\n✨ ${amenities.join(' · ')}` : '';

  // 6. Restrictions row (Prominently displays any bans: pets, smoking, parties, subleasing)
  const restrictionsLine = restrictions.length > 0 ? `\n⛔ <b>Restrictions:</b> ${restrictions.join(' · ')}` : '';

  // 7. Description excerpt (cleaned of technical tags and capped under 240 chars)
  const cleanedDesc = desc
    .replace(/(?:Size|Floor|Furniture|Facing|Parking):[^\n]+/gi, '')
    .trim();
  const descLine = cleanedDesc
    ? `\n\n${escapeHtml(truncate(cleanedDesc, 240))}`
    : '';

  // 8. Processing timestamp (placed right above contact section)
  const timestampText = `\n\n${formatListingTimestamp(property.created_at || property.parsed_at)}`;

  // 9. Direct contact details (formatted with standardized phone mask)
  const contactLines: string[] = [];
  if (property.direct_contact.phone) {
    const formattedPhone =
      formatPhoneNumber(property.direct_contact.phone) ?? property.direct_contact.phone;
    contactLines.push(`📞 Phone: <code>${escapeHtml(formattedPhone)}</code>`);
  }
  if (property.direct_contact.telegram) {
    const tgUsername = property.direct_contact.telegram.replace(/^@/, '');
    contactLines.push(`💬 Telegram: <a href="https://t.me/${escapeHtml(tgUsername)}">@${escapeHtml(tgUsername)}</a>`);
  }
  const source = property.source_url || property.original_url;
  if (source && (source.startsWith('http://') || source.startsWith('https://'))) {
    contactLines.push(`🔗 Source: <a href="${escapeHtml(source)}">View Link</a>`);
  }
  const contactSection =
    contactLines.length > 0 ? `\n\n👤 <b>Contact:</b>\n${contactLines.join('\n')}` : '';

  const catLine = catLabel ? ` · <i>${catLabel}</i>` : '';

  return (
    `${typeEmoji} <b>${escapeHtml(property.title)}</b>\n` +
    `<i>${typeLabel}</i>${catLine}\n\n` +
    `${priceLine}${termsLine}\n` +
    `${locText}` +
    `${featuresLine}` +
    `${amenitiesLine}` +
    `${restrictionsLine}` +
    `${descLine}` +
    `${timestampText}` +
    `${contactSection}\n\n` +
    `🔔 <i>New match for your search alert!</i>`
  );
}

export async function sendListingCard(
  telegramId: number,
  property: Property,
  api: Api,
  customKeyboard?: InlineKeyboard,
): Promise<void> {
  const caption = formatListingCard(property);
  const keyboard = customKeyboard ?? listingActionKeyboard(property);

  const validPhotos = (property.photos || [])
    .filter((p): p is string => typeof p === 'string' && (p.startsWith('http://') || p.startsWith('https://')))
    .slice(0, 3);

  // If 2 or 3 photos: send as an album (MediaGroup) with caption on first photo, then action buttons
  if (validPhotos.length > 1) {
    try {
      const media = validPhotos.map((url, idx) => ({
        type: 'photo' as const,
        media: url,
        caption: idx === 0 ? caption : undefined,
        parse_mode: idx === 0 ? ('HTML' as const) : undefined,
      }));

      await api.sendMediaGroup(telegramId, media);
      await api.sendMessage(telegramId, '👇 <b>Listing Actions:</b>', {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    } catch (err: unknown) {
      console.warn(`[Notifier] sendMediaGroup failed for user ${telegramId}, falling back to sendPhoto:`, err);
    }
  }

  // If 1 photo (or fallback): send single photo with keyboard attached
  if (validPhotos.length > 0 && validPhotos[0]) {
    try {
      await api.sendPhoto(telegramId, validPhotos[0], {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    } catch (err: unknown) {
      console.warn(`[Notifier] sendPhoto failed for user ${telegramId}, falling back to sendMessage:`, err);
    }
  }

  // Text message fallback
  await api.sendMessage(telegramId, caption, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

// ─── Notifier Service ─────────────────────────────────────────────────────────

interface QueueItem {
  telegramId: number;
  property: Property;
}

export class NotifierService {
  private api: Api | null;
  private readonly adminIds: number[];
  private readonly queue: QueueItem[] = [];
  private readonly lastSentAt = new Map<number, number>();
  private processingTimer: NodeJS.Timeout | null = null;

  constructor(api?: Api, adminIds?: number[]) {
    this.api = api ?? (env.BOT_TOKEN ? new Api(env.BOT_TOKEN) : null);
    this.adminIds = adminIds ?? env.ADMIN_IDS;
  }

  setApi(api: Api): void {
    this.api = api;
  }

  getApi(): Api {
    if (!this.api && env.BOT_TOKEN) {
      this.api = new Api(env.BOT_TOKEN);
    }
    if (!this.api) {
      throw new Error('Bot API not registered and BOT_TOKEN is missing');
    }
    return this.api;
  }

  async notifyAdmins(messageText: string): Promise<void> {
    let api: Api;
    try {
      api = this.getApi();
    } catch {
      console.warn(`[Notifier] Cannot send admin alert (Bot API not registered): ${messageText}`);
      return;
    }

    for (const adminId of this.adminIds) {
      try {
        await api.sendMessage(adminId, messageText, { parse_mode: 'HTML' });
      } catch (err: unknown) {
        console.error(`[Notifier] Failed to send alert to admin ${adminId}:`, err);
      }
    }
  }

  dispatchNotification(telegramId: number, property: Property): void {
    const alreadyQueued = this.queue.some(
      (item) => item.telegramId === telegramId && item.property.id === property.id,
    );
    if (alreadyQueued) return;

    this.queue.push({ telegramId, property });

    // Process immediately if not running
    this.processQueue().catch((err: unknown) => console.error('Immediate queue error:', err));

    if (!this.processingTimer) {
      this.processingTimer = setInterval(() => {
        this.processQueue().catch((err: unknown) => console.error('Queue error:', err));
      }, RATE_LIMIT.QUEUE_TICK_MS);
      this.processingTimer.unref();
    }
  }

  async flushNotificationQueue(): Promise<void> {
    while (this.queue.length > 0) {
      await this.processQueue();
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT.PER_USER_INTERVAL_MS));
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      if (this.processingTimer) {
        clearInterval(this.processingTimer);
        this.processingTimer = null;
      }
      return;
    }

    let api: Api;
    try {
      api = this.getApi();
    } catch {
      return;
    }

    const now = Date.now();

    // Prune stale rate limit entries to prevent unbounded Map memory growth
    if (this.lastSentAt.size > 200) {
      const ONE_HOUR = 60 * 60 * 1000;
      for (const [id, time] of this.lastSentAt.entries()) {
        if (now - time > ONE_HOUR) {
          this.lastSentAt.delete(id);
        }
      }
    }

    const idx = this.queue.findIndex((item) => {
      const last = this.lastSentAt.get(item.telegramId) ?? 0;
      return now - last >= RATE_LIMIT.PER_USER_INTERVAL_MS;
    });

    if (idx === -1) return;

    const item = this.queue.splice(idx, 1)[0]!;
    this.lastSentAt.set(item.telegramId, Date.now());

    try {
      await sendListingCard(item.telegramId, item.property, api);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  Failed to notify user ${item.telegramId}: ${msg}`);
    }
  }

  async sendListingCard(telegramId: number, property: Property): Promise<void> {
    const api = this.getApi();
    await sendListingCard(telegramId, property, api);
  }
}
