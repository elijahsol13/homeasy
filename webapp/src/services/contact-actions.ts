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

  try {
    // With noopener, browsers may return null even when the new tab opens.
    window.open(tmeUrl, '_blank', 'noopener,noreferrer');
  } catch {
    window.location.assign(tmeUrl);
  }
}

/** Accept only a telephone URI produced by the API's E.164 normalizer. */
export function phoneActionHref(phoneLink: string | null | undefined): string | null {
  if (!phoneLink) return null;
  const target = phoneLink.trim();
  return /^tel:\+\d{7,15}$/.test(target) ? target : null;
}

/** Link to WhatsApp when an explicit contact exists, or offer to try a callable number. */
export function whatsappActionHref(
  whatsappLink: string | null | undefined,
  phoneLink: string | null | undefined,
): string | null {
  const explicit = whatsappLink?.trim();
  if (explicit && /^https:\/\/wa\.me\/\d{7,15}$/.test(explicit)) return explicit;

  // A phone can receive calls without having WhatsApp; the UI labels this as a try.
  const dial = phoneActionHref(phoneLink);
  return dial ? `https://wa.me/${dial.slice('tel:+'.length)}` : null;
}

/** Preserve a phone anchor's native default action while keeping card handlers isolated. */
export function onPhoneActionClick(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
