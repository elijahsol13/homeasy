import type React from 'react';

type TelegramBridgeDetails = {
  openTelegramLink?: (url: string) => void;
};

function telegramBridge(): TelegramBridgeDetails | undefined {
  return typeof window === 'undefined'
    ? undefined
    : window.Telegram?.WebApp as TelegramBridgeDetails | undefined;
}

/** Open a Telegram destination through the Mini App API, with HTTPS fallback outside Telegram. */
export function openTelegramContact(
  tmeUrl: string | null | undefined,
  event?: React.SyntheticEvent,
): void {
  if (!tmeUrl) return;
  event?.preventDefault();
  event?.stopPropagation();

  const tg = telegramBridge();
  if (tg?.openTelegramLink) {
    try {
      tg.openTelegramLink(tmeUrl);
      return;
    } catch (error) {
      console.warn('[Telegram] openTelegramLink failed:', error);
    }
  }

  const opened = window.open(tmeUrl, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign(tmeUrl);
}

/** Accept only a telephone URI produced by the API's E.164 normalizer. */
export function phoneActionHref(phoneLink: string | null | undefined): string | null {
  if (!phoneLink) return null;
  const target = phoneLink.trim();
  return /^tel:\+\d{7,15}$/.test(target) ? target : null;
}

/**
 * Normalize phone values from older API DTOs to E.164.
 * Bare national numbers are treated as Cambodian only when they have a
 * Cambodian local prefix or the subscriber length used by our source data.
 */
export function normalizePhoneToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const compact = raw.trim().replace(/^tel:/i, '').replace(/[\s().-]/g, '');
  if (!compact || !/^(?:\+\d+|\d+)$/.test(compact)) return null;

  const digits = compact.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (compact.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) {
    const internationalDigits = digits.slice(2);
    return internationalDigits.length >= 7 && internationalDigits.length <= 15
      ? `+${internationalDigits}`
      : null;
  }
  if (digits.startsWith('855')) return `+${digits}`;
  if (digits.startsWith('0')) return `+855${digits.slice(1)}`;
  if (digits.length === 8 || digits.length === 9) return `+855${digits}`;
  return null;
}

function firstPhoneValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.split(/[;,/|\n]+/).map((part) => part.trim()).find(Boolean) ?? null;
}

/** Adapt legacy or current API contact fields to the strict tel:E.164 contract. */
export function phoneActionHrefFromDto(
  phoneLink: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  const e164 = normalizePhoneToE164(phoneLink) ?? normalizePhoneToE164(firstPhoneValue(phone));
  return phoneActionHref(e164 ? `tel:${e164}` : null);
}

/**
 * Build the observed Cambodian compatibility form for Telegram resolution.
 * It intentionally differs from the dialable E.164 value used by tel: links.
 */
export function formatCambodianTelegramPhone(raw: string | null | undefined): string | null {
  const value = firstPhoneValue(raw);
  if (!value) return null;

  const compact = value.trim().replace(/^tel:/i, '').replace(/[\s().-]/g, '');
  if (!/^(?:\+\d+|\d+)$/.test(compact)) return null;

  const digits = compact.replace(/\D/g, '');
  const nsn = digits.startsWith('855')
    ? digits.slice(3)
    : digits.startsWith('0')
      ? digits.slice(1)
      : digits;

  if (!/^\d{8,9}$/.test(nsn)) return null;
  return nsn.length === 8 ? `+8550${nsn}` : `+855${nsn}`;
}

function telegramUrlFromPhone(raw: string | null | undefined): string | null {
  const cambodianPhone = formatCambodianTelegramPhone(raw);
  if (cambodianPhone) return `https://t.me/${cambodianPhone}`;

  const e164 = normalizePhoneToE164(firstPhoneValue(raw));
  return e164 ? `https://t.me/${e164}` : null;
}

/** Resolve a Telegram username link or derive a phone resolver link from its original contact value. */
export function telegramActionHrefFromDto(
  telegramLink: string | null | undefined,
  phone: string | null | undefined,
  telegram?: string | null,
): string | null {
  if (telegramLink) {
    try {
      const parsed = new URL(telegramLink.trim());
      const allowedHosts = ['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'];
      const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
      if (['https:', 'http:'].includes(parsed.protocol) && allowedHosts.includes(parsed.hostname.toLowerCase()) && path) {
        if (path.startsWith('+') || /^\d+$/.test(path)) {
          // A numeric Telegram field is a phone supplied by the listing, even
          // when the API has already generated an E.164 t.me link from it.
          // Preserve a t.me URL supplied directly by the listing.
          const sourcePhoneUrl = telegramUrlFromPhone(telegram);
          if (sourcePhoneUrl) return sourcePhoneUrl;
          if (telegram) return `https://t.me/${path}${parsed.search}${parsed.hash}`;
          return telegramUrlFromPhone(phone) ?? `https://t.me/${path}${parsed.search}${parsed.hash}`;
        }
        return `https://t.me/${path}${parsed.search}${parsed.hash}`;
      }
    } catch {
      // Fall back to the phone value below.
    }
  }

  return telegramUrlFromPhone(telegram) ?? telegramUrlFromPhone(phone);
}

/** Preserve a phone anchor's native default action while keeping card handlers isolated. */
export function onPhoneActionClick(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
