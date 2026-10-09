import { Api, type InlineKeyboard } from 'grammy';
import type { Property } from '../database/repositories/properties.repo';
import { CITIES, KHR_TO_USD_RATE, RATE_LIMIT } from '../config/settings';
import { listingActionKeyboard } from '../modules/bot/keyboards/listing.keyboard';
import {
  extractElectricity,
  extractWater,
  extractPropertyType,
} from '../modules/parser/extractor';
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

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  const description = property.description || '';
  const fullText = `${property.title}\n${description}`;
  const rawPropertyType = property.property_type?.trim()
    || extractPropertyType(fullText, property.category)
    || (property.category ? property.category[0]!.toUpperCase() + property.category.slice(1) : 'Property');
  const propertyType = rawPropertyType.replace(/(^|[\s/(-])([\p{L}])/gu, (_match, separator: string, letter: string) =>
    `${separator}${letter.toLocaleUpperCase()}`,
  );
  const location = property.location?.trim() || CITIES[property.city] || property.city;
  const priceUsd = Math.round(property.price / 100);
  const price = priceUsd > 0
    ? `💰 <b>$${priceUsd.toLocaleString('en-US')}</b>${property.type === 'rent' ? '/month' : ''}`
    : '💰 <i>Price on request</i>';

  const sourceUrl = property.original_url || '';
  const source = sourceUrl.includes('facebook.com') || sourceUrl.includes('fb.com')
    ? 'Facebook'
    : sourceUrl.includes('khmer24.com') ? 'Khmer24' : null;
  const timestamp = property.posted_at || property.created_at;
  let freshness: string | null = null;
  if (timestamp) {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) {
      const days = Math.floor((Date.now() - parsed) / 86_400_000);
      freshness = days <= 0 ? 'today' : days === 1 ? '1d ago' : days < 30 ? `${days}d ago`
        : `${Math.floor(days / 30)}mo ago`;
    }
  }
  const sourceMeta = [source, freshness ? `posted ${freshness}` : null].filter(Boolean).join(' · ');

  const features: string[] = [];
  if (property.bedrooms !== null) {
    features.push(`🛏 ${property.bedrooms === 0 ? 'Studio' : `${property.bedrooms} BR`}`);
  }
  if (property.bathrooms !== null) features.push(`🚿 ${property.bathrooms} Bath`);
  if (property.has_pool) features.push('🏊 Pool');

  const electricity = property.electricity ?? extractElectricity(fullText);
  const water = property.water ?? extractWater(fullText);
  const cleaning = property.cleaning ?? extractCleaning(fullText);
  if (electricity) features.push(`⚡ ${electricity.replace('Fixed Rate ', '')}`);
  if (water) features.push(`💧 ${water}`);
  if (cleaning) features.push('✨ Cleaning');

  const restrictions = property.restrictions?.length ? property.restrictions : extractRestrictions(fullText);
  if (restrictions.length > 0) features.push(restrictions[0]!);

  return [
    `<i>${escapeHtml(propertyType)}</i>`,
    `${price} · 📍 <b>${escapeHtml(location)}</b>`,
    `<b>${escapeHtml(property.title)}</b>`,
    sourceMeta ? escapeHtml(sourceMeta) : null,
    features.length > 0 ? features.map(escapeHtml).join(' · ') : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
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

  async notifyAdmins(messageText: string, keyboard?: InlineKeyboard): Promise<void> {
    let api: Api;
    try {
      api = this.getApi();
    } catch {
      console.warn(`[Notifier] Cannot send admin alert (Bot API not registered): ${messageText}`);
      return;
    }

    for (const adminId of this.adminIds) {
      try {
        await api.sendMessage(adminId, messageText, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
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
