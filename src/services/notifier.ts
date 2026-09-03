import { Api } from 'grammy';
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

  // 4. Features line (Bedrooms, Bathrooms, Pool) - Dynamic, ONLY render if present
  const features: string[] = [];
  if (property.bedrooms === 0) {
    features.push('Studio');
  } else if (property.bedrooms !== null && property.bedrooms > 0) {
    features.push(`${property.bedrooms} BR`);
  }
  if (property.bathrooms !== null && property.bathrooms > 0) {
    features.push(`${property.bathrooms} Bath`);
  }
  if (property.has_pool) {
    features.push('🏊 Pool');
  }
  const featuresLine = features.length > 0 ? `\n🛏 ${features.join(' · ')}` : '';

  // 5. Description (strictly capped to ensure total caption stays under 1000 chars)
  const descLine = property.description
    ? `\n\n${escapeHtml(truncate(property.description, 220))}`
    : '';

  // 6. Processing timestamp (placed right above contact section)
  const timestampText = `\n\n${formatListingTimestamp(property.created_at || property.parsed_at)}`;

  // 7. Direct contact details (formatted with standardized phone mask)
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
): Promise<void> {
  const caption = formatListingCard(property);
  const keyboard = listingActionKeyboard(property);

  // If photos exist, prioritize sendPhoto / sendMediaGroup
  if (property.photos.length > 0 && property.photos[0]) {
    try {
      await api.sendPhoto(telegramId, property.photos[0], {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    } catch (err: unknown) {
      console.warn(`[Notifier] sendPhoto failed for user ${telegramId}, falling back to sendMessage:`, err);
    }
  }

  // Text message fallback (or if photo failed to load)
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
