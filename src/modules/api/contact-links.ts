import { normalizePhoneToE164 } from '../parser/normalizer';

function firstPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.split(/[;,/|\n]+/).map((part) => part.trim()).find(Boolean) ?? null;
}

function normalizeTelegramUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(parsed.hostname.toLowerCase())) {
      return null;
    }
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return null;
    return `https://t.me/${path}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function telegramLinkFromExplicitContact(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) return normalizeTelegramUrl(raw);

  const username = raw.startsWith('@') ? raw.slice(1) : raw;
  if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) return `https://t.me/${username}`;

  const e164 = normalizePhoneToE164(raw);
  return e164 ? `https://t.me/+${e164.slice(1)}` : null;
}

/** Explicit Telegram identity wins; a regular phone is the final resolution attempt. */
export function getTelegramContactLink(
  telegram: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  const explicit = telegramLinkFromExplicitContact(telegram);
  if (explicit) return explicit;

  const e164 = normalizePhoneToE164(firstPhone(phone));
  return e164 ? `https://t.me/+${e164.slice(1)}` : null;
}

/** Build an E.164 telephone URI from the first listed phone number. */
export function getPhoneActionLink(phone: string | null | undefined): string | null {
  const e164 = normalizePhoneToE164(firstPhone(phone));
  return e164 ? `tel:${e164}` : null;
}
