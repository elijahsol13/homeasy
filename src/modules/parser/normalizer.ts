import { KHR_TO_USD_RATE } from '../../config/settings';

// ─── Text normalization ───────────────────────────────────────────────────────

/** Strips HTML tags and decodes common entities. */
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

/** Collapses multiple whitespace characters into a single space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Full text normalisation: strip HTML → collapse whitespace. */
export function normalizeText(text: string): string {
  return collapseWhitespace(stripHtml(text));
}

// ─── Price normalization ──────────────────────────────────────────────────────

/** Strips commas, currency symbols, and whitespace from a price string. */
export function normalizePriceString(priceStr: string): string {
  return priceStr.replace(/[,\s$¥€£฿]/g, '').trim();
}

/** Converts a KHR amount to USD cents. */
export function khrToUsdCents(khr: number, rate = KHR_TO_USD_RATE): number {
  return Math.round((khr / rate) * 100);
}

/** Converts a USD dollar amount to USD cents. */
export function usdToUsdCents(usd: number): number {
  return Math.round(usd * 100);
}

// ─── Location normalization ───────────────────────────────────────────────────

/**
 * Lowercases and collapses non-alphanumeric chars to spaces.
 * Used for fuzzy matching of district names.
 */
export function normalizeLocationString(loc: string): string {
  return loc
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Phone normalization & formatting ─────────────────────────────────────────

/**
 * Normalizes Cambodian phone numbers to a uniform international format digits string
 * e.g. "+855 12 345 678" -> "85512345678"
 *      "012-345-678"     -> "85512345678"
 */
export function normalizePhoneNumber(phone: string | undefined | null): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 7) return null;

  // Local format starting with 0 (e.g. 012345678 -> 85512345678)
  if (digits.startsWith('0')) {
    return `855${digits.slice(1)}`;
  }

  // Already starts with 855
  if (digits.startsWith('855')) {
    return digits;
  }

  // Without leading 0 or 855 (e.g. 12345678 -> 85512345678)
  if (digits.length <= 9) {
    return `855${digits}`;
  }

  return digits;
}

/**
 * Extracts Cambodia subscriber digits (without leading 0 and without country code 855).
 * E.g. "+855 12 345 678" -> "12345678"
 *      "089 899 084"     -> "89899084"
 *      "096 934 3456"    -> "969343456"
 */
export function getCambodiaSubscriberDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 7) return null;

  if (digits.startsWith('855')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits.length >= 7 ? digits : null;
}

/**
 * Formats a single Cambodian phone number into domestic format with leading 0:
 * 9 digits total:  0XX XXX XXX  (e.g. 089 899 084)
 * 10 digits total: 0XX XXX XXXX (e.g. 096 934 3456)
 */
export function formatDomesticSinglePhone(phone: string): string | null {
  const sub = getCambodiaSubscriberDigits(phone);
  if (!sub) return null;

  if (sub.length === 8) {
    // 8 subscriber digits -> 9 digits with 0: 0XX XXX XXX
    return `0${sub.slice(0, 2)} ${sub.slice(2, 5)} ${sub.slice(5)}`;
  }
  if (sub.length === 9) {
    // 9 subscriber digits -> 10 digits with 0: 0XX XXX XXXX
    return `0${sub.slice(0, 2)} ${sub.slice(2, 5)} ${sub.slice(5)}`;
  }
  if (sub.length === 7) {
    return `0${sub.slice(0, 2)} ${sub.slice(2, 5)} ${sub.slice(5)}`;
  }
  return `0${sub}`;
}

/**
 * Formats a single Cambodian phone number into international format:
 * 9 digits total:  +855 XX XXX XXX  (e.g. +855 89 899 084)
 * 10 digits total: +855 XX XXX XXXX (e.g. +855 96 934 3456)
 */
export function formatInternationalSinglePhone(phone: string): string | null {
  const sub = getCambodiaSubscriberDigits(phone);
  if (!sub) return null;

  if (sub.length === 8) {
    return `+855 ${sub.slice(0, 2)} ${sub.slice(2, 5)} ${sub.slice(5)}`;
  }
  if (sub.length === 9) {
    return `+855 ${sub.slice(0, 2)} ${sub.slice(2, 5)} ${sub.slice(5)}`;
  }
  if (sub.length === 7) {
    return `+855 ${sub.slice(0, 2)} ${sub.slice(2, 5)} ${sub.slice(5)}`;
  }
  return `+855 ${sub}`;
}

/**
 * Formats Cambodian phone numbers into domestic format (e.g. 089 899 084 / 096 934 3456).
 * Strictly preserves the leading 0 for 9- and 10-digit Cambodian numbers.
 */
export function formatDomesticPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const parts = phone.split(/[/,|\n]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const list = parts.map(formatDomesticSinglePhone).filter((p): p is string => Boolean(p));
    return list.length > 0 ? list.join(' / ') : null;
  }
  return formatDomesticSinglePhone(phone);
}

/**
 * Formats Cambodian phone numbers into international format (e.g. +855 89 899 084 / +855 96 934 3456).
 */
export function formatInternationalPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const parts = phone.split(/[/,|\n]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const list = parts.map(formatInternationalSinglePhone).filter((p): p is string => Boolean(p));
    return list.length > 0 ? list.join(' / ') : null;
  }
  return formatInternationalSinglePhone(phone);
}

/**
 * Formats a Cambodian phone number into a standardized mask:
 * - 'domestic' (default): 0XX XXX XXX or 0XX XXX XXXX
 * - 'international': +855 XX XXX XXX or +855 XX XXX XXXX
 * - 'both': 0XX XXX XXX (+855 XX XXX XXX)
 */
export function formatPhoneNumber(
  phone: string | null | undefined,
  style: 'domestic' | 'international' | 'both' = 'domestic',
): string | null {
  if (!phone) return null;
  if (style === 'international') {
    return formatInternationalPhone(phone);
  }
  if (style === 'both') {
    const parts = phone.split(/[/,|\n]+/).map((p) => p.trim()).filter(Boolean);
    const formatted = parts
      .map((p) => {
        const dom = formatDomesticSinglePhone(p);
        const intl = formatInternationalSinglePhone(p);
        if (dom && intl) return `${dom} (${intl})`;
        return dom || intl || p;
      })
      .filter(Boolean);
    return formatted.length > 0 ? formatted.join(' / ') : null;
  }
  return formatDomesticPhone(phone);
}

export interface ExtractedContacts {
  phone?: string;
  telegram?: string;
  whatsapp?: string;
}

/**
 * Extracts, disambiguates and correlates contact channels (phone, telegram, whatsapp) from raw post text.
 * - Disambiguates numbers designated for calls vs Telegram vs WhatsApp.
 * - Formats all phone numbers in Cambodian domestic mask with leading 0 (0XX XXX XXX or 0XX XXX XXXX).
 */
export function extractDirectContacts(
  text: string,
  seed?: { rawPhone?: string; rawTelegram?: string; rawWhatsapp?: string },
): ExtractedContacts {
  const result: ExtractedContacts = {};
  const cleanText = text || '';
  const lines = cleanText.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  let extractedTelegram: string | undefined = undefined;
  let extractedWhatsapp: string | undefined = undefined;
  const callPhones: string[] = [];
  const genericPhones: string[] = [];

  // 1. Line-by-line & segment contextual parsing
  for (const rawLine of lines) {
    // Split on "/" or "|" when separating distinct labeled items (e.g. Call ... / Telegram ...)
    const segments = rawLine
      .split(/\s*[/|]\s*(?=[A-Za-z\u1780-\u17FF]+[:：]|\+?855|0\d)/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const seg of segments) {
      const isTg = /(?:telegram|tg)\b|តេឡេក្រាម/i.test(seg);
      const isWa = /(?:whatsapp|whats\s*app|wa)\b/i.test(seg);
      const isCall = /(?:tel|call|phone|mobile|cellcard|smart|metfone|contact)\b|ទូរស័ព្ទ|ទំនាក់ទំនង/i.test(seg);

      const phoneMatches = seg.match(/(?:\+?855|0)[1-9]\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g) || [];
      const tgLinkMatch = /https?:\/\/t\.me\/([a-zA-Z0-9_+]+)/i.exec(seg);
      const tgAtMatch = /@([a-zA-Z0-9_]{4,32})\b/.exec(seg);
      const waLinkMatch = /https?:\/\/wa\.me\/([0-9+]+)/i.exec(seg);

      if (isTg) {
        if (tgLinkMatch?.[1]) {
          extractedTelegram = `@${tgLinkMatch[1]}`;
        } else if (tgAtMatch?.[1] && !['gmail', 'yahoo', 'hotmail'].includes(tgAtMatch[1].toLowerCase())) {
          extractedTelegram = `@${tgAtMatch[1]}`;
        } else if (phoneMatches.length > 0) {
          const dom = formatDomesticPhone(phoneMatches[0]);
          if (dom) extractedTelegram = dom;
        }
      }

      if (isWa) {
        if (waLinkMatch?.[1]) {
          const dom = formatDomesticPhone(waLinkMatch[1]);
          if (dom) extractedWhatsapp = dom;
        } else if (phoneMatches.length > 0) {
          const dom = formatDomesticPhone(phoneMatches[0]);
          if (dom) extractedWhatsapp = dom;
        }
      }

      if (isCall) {
        for (const p of phoneMatches) {
          const dom = formatDomesticPhone(p);
          if (dom && !callPhones.includes(dom)) {
            callPhones.push(dom);
          }
        }
      } else if (!isTg && !isWa) {
        for (const p of phoneMatches) {
          const dom = formatDomesticPhone(p);
          if (dom && !genericPhones.includes(dom)) {
            genericPhones.push(dom);
          }
        }
      }
    }
  }

  // 2. Inline suffix pattern check across whole text:
  // e.g. "012 345 678 (Call) / 098 765 432 (Telegram)"
  const suffixTgMatch = /((?:\+?855|0)[1-9]\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4})\s*\((?:telegram|tg|t\.me)\)/i.exec(cleanText);
  if (suffixTgMatch?.[1] && !extractedTelegram) {
    const dom = formatDomesticPhone(suffixTgMatch[1]);
    if (dom) extractedTelegram = dom;
  }

  const suffixWaMatch = /((?:\+?855|0)[1-9]\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4})\s*\((?:whatsapp|wa)\)/i.exec(cleanText);
  if (suffixWaMatch?.[1] && !extractedWhatsapp) {
    const dom = formatDomesticPhone(suffixWaMatch[1]);
    if (dom) extractedWhatsapp = dom;
  }

  const suffixCallMatch = /((?:\+?855|0)[1-9]\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4})\s*\((?:call|tel|phone|voice)\)/i.exec(cleanText);
  if (suffixCallMatch?.[1]) {
    const dom = formatDomesticPhone(suffixCallMatch[1]);
    if (dom && !callPhones.includes(dom)) callPhones.push(dom);
  }

  // 3. Check for global @handle or t.me link if Telegram not yet found
  if (!extractedTelegram) {
    const globalTgLink = /https?:\/\/t\.me\/([a-zA-Z0-9_+]+)/i.exec(cleanText);
    if (globalTgLink?.[1]) {
      extractedTelegram = `@${globalTgLink[1]}`;
    } else {
      const globalTgAt = /@([a-zA-Z0-9_]{5,32})\b/.exec(cleanText);
      if (globalTgAt?.[1] && !['gmail', 'hotmail', 'yahoo', 'facebook', 'khmer24', 'channel'].includes(globalTgAt[1].toLowerCase())) {
        extractedTelegram = `@${globalTgAt[1]}`;
      }
    }
  }

  // 4. Resolve primary phone(s)
  const candidatePhones = callPhones.length > 0 ? callPhones : genericPhones;

  // Filter out numbers that are designated for Telegram or WhatsApp if other numbers exist
  const nonChatPhones = candidatePhones.filter((p) => p !== extractedTelegram && p !== extractedWhatsapp);
  let resolvedPhones = nonChatPhones.length > 0 ? nonChatPhones : candidatePhones;

  // Incorporate seed if text did not yield phone/telegram/whatsapp
  if (seed?.rawPhone) {
    const domSeed = formatDomesticPhone(seed.rawPhone);
    if (domSeed && !resolvedPhones.includes(domSeed)) {
      if (resolvedPhones.length === 0) {
        resolvedPhones.push(domSeed);
      }
    }
  }

  if (seed?.rawTelegram && !extractedTelegram) {
    extractedTelegram = seed.rawTelegram;
  }
  if (seed?.rawWhatsapp && !extractedWhatsapp) {
    extractedWhatsapp = seed.rawWhatsapp;
  }

  if (resolvedPhones.length > 0) {
    result.phone = resolvedPhones.join(' / ');
  }
  if (extractedTelegram) {
    result.telegram = extractedTelegram;
  }
  if (extractedWhatsapp) {
    result.whatsapp = extractedWhatsapp;
  }

  return result;
}

// ─── Photo Sanitization ───────────────────────────────────────────────────────

const JUNK_PHOTO_PATTERNS: RegExp[] = [
  /\/t39\.30808-1\//i, // Facebook profile picture CDN indicator
  /\/p(40|50|60|75|100|160)x\1\//i,
  /\/s(40|50|60|75|100|160)x\1\//i,
  /[?&]ctp=s(40|50|60|75|100|160)x\1/i,
  /[?&]cstp=s(40|50|60|75|100|160)x\1/i,
  /c\d+\.\d+\.\d+\.\d+/i,
  /profile/i,
  /avatar/i,
  /emoji/i,
  /static\.xx\.fbcdn\.net/i,
  /rsrc\.php/i,
];

function photoResolutionArea(url: string): number {
  // Facebook encodes the actual rendered/cached size in query params like:
  //   ctp=s1280x960        <- actual cached thumbnail
  //   cstp=mx1280x960      <- maximum container/source size
  // The same URL can contain both; prefer the actual rendered size (ctp).
  // Sometimes the size is also in the path like s1280x960 or p1280x960.
  function maxArea(re: RegExp): number {
    let max = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(url)) !== null) {
      const area = Number(m[1]) * Number(m[2]);
      if (area > max) max = area;
    }
    return max;
  }

  const ctp = maxArea(/[?&]ctp=m?[sx]?(\d+)x(\d+)/gi);
  if (ctp > 0) return ctp;

  const cstp = maxArea(/[?&]cstp=m?[sx]?(\d+)x(\d+)/gi);
  if (cstp > 0) return cstp;

  const path = maxArea(/\/(?:s|p|mx)(\d+)x(\d+)\//gi) || maxArea(/[?&]size=(\d+)x(\d+)/gi);
  if (path > 0) return path;

  // No size hint: assume it's a full-resolution original and keep it first.
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Sanitizes an array of photo URLs:
 * 1. Discards avatars, tiny thumbnails, profile icons, and emoji graphics.
 * 2. Eliminates duplicates (including same photo with different resolution query params) while preserving insertion order.
 * 3. Prefers the highest-resolution variant when the same image appears in multiple sizes.
 * 4. CRITICAL INVARIANT: The very first valid original post image remains at index 0 (Hero Image).
 */
export function cleanPhotoUrls(urls: string[] | undefined | null): string[] {
  if (!Array.isArray(urls) || urls.length === 0) return [];

  // Process largest resolutions first so the hero image is the best available copy.
  const sorted = [...urls].sort((a, b) => photoResolutionArea(b) - photoResolutionArea(a));

  const seenPaths = new Set<string>();
  const filtered: string[] = [];

  for (const rawUrl of sorted) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    const url = rawUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;

    const isJunk = JUNK_PHOTO_PATTERNS.some((pattern) => pattern.test(url));
    if (isJunk) continue;

    let pathKey = url;
    try {
      const parsed = new URL(url);
      pathKey = parsed.pathname;
    } catch {
      // If URL parsing fails, fallback to exact string
    }

    if (!seenPaths.has(pathKey)) {
      seenPaths.add(pathKey);
      filtered.push(url);
    }
  }

  return filtered;
}

