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
 * Formats a Cambodian phone number into a standardized, clean mask:
 * e.g. "85512345678"    -> "+855 12 345 678"
 *      "855969343456"   -> "+855 96 934 3456"
 *      "012345678 / 09693434" -> "+855 12 345 678 / +855 96 934 34"
 */
export function formatPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const parts = phone.split(/[/,|\n]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const formattedList = parts
      .map((p) => formatSinglePhoneNumber(p))
      .filter((p): p is string => Boolean(p));
    return formattedList.length > 0 ? formattedList.join(' / ') : null;
  }

  return formatSinglePhoneNumber(phone);
}

function formatSinglePhoneNumber(phone: string): string | null {
  const norm = normalizePhoneNumber(phone);
  if (!norm) return null;

  const withoutCc = norm.startsWith('855') ? norm.slice(3) : norm;

  if (withoutCc.length === 8) {
    // Standard 8-digit mobile: e.g. 12 345 678
    return `+855 ${withoutCc.slice(0, 2)} ${withoutCc.slice(2, 5)} ${withoutCc.slice(5)}`;
  }

  if (withoutCc.length === 9) {
    // 9-digit mobile: e.g. 96 934 3456
    return `+855 ${withoutCc.slice(0, 2)} ${withoutCc.slice(2, 5)} ${withoutCc.slice(5)}`;
  }

  if (withoutCc.length === 7) {
    // 7-digit landline: e.g. 23 888 999
    return `+855 ${withoutCc.slice(0, 2)} ${withoutCc.slice(2, 5)} ${withoutCc.slice(5)}`;
  }

  return `+${norm}`;
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

/**
 * Sanitizes an array of photo URLs:
 * 1. Discards avatars, tiny thumbnails, profile icons, and emoji graphics.
 * 2. Eliminates duplicates (including same photo with different resolution query params) while preserving insertion order.
 * 3. CRITICAL INVARIANT: The very first valid original post image remains at index 0 (Hero Image).
 */
export function cleanPhotoUrls(urls: string[] | undefined | null): string[] {
  if (!Array.isArray(urls) || urls.length === 0) return [];

  const seenPaths = new Set<string>();
  const filtered: string[] = [];

  for (const rawUrl of urls) {
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

