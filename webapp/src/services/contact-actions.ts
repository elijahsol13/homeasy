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

/** Preserve a phone anchor's native default action while keeping card handlers isolated. */
export function onPhoneActionClick(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/** Copy the displayed phone number; this is the fallback when desktop has no dialer. */
export async function copyPhoneNumber(
  phone: string | null | undefined,
  event?: React.SyntheticEvent,
): Promise<boolean> {
  event?.preventDefault();
  event?.stopPropagation();
  const value = phone?.trim();
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  }
}
