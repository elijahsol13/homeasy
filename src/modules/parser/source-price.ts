export type ParsedSourcePrice = { price: number; currency: 'USD' | 'KHR' | null };

const AMOUNT = '(\\d[\\d,]*(?:\\.\\d+)?)';
const UTILITY_MARKERS = /\b(?:electricity|water|utilities|utility|edc|kwh|m3|m³|person|pax)\b|ភ្លើង|ទឹក/gi;
const RENT_MARKERS = /\b(?:rent(?:al)?|asking\s+price|price\s+for\s+rent|monthly\s+rate)\b|តម្លៃជួល|តំលៃជួល/gi;

function lastMatchIndex(text: string, pattern: RegExp): number {
  let last = -1;
  const regex = new RegExp(pattern.source, pattern.flags);
  for (const match of text.matchAll(regex)) last = match.index ?? last;
  return last;
}

/** True for a tariff/utility charge near an amount, while preserving a rent amount
 * that appears earlier on the same line (for example: "Rent $300, water $80"). */
export function isUtilityPriceOccurrence(rawText: string, index: number, length: number): boolean {
  const lineStart = rawText.lastIndexOf('\n', Math.max(-1, index - 1)) + 1;
  const newline = rawText.indexOf('\n', index);
  const lineEnd = newline < 0 ? rawText.length : newline;
  const line = rawText.slice(lineStart, lineEnd);
  const prefix = line.slice(0, index - lineStart);
  const utilityIndex = lastMatchIndex(prefix, UTILITY_MARKERS);
  const rentIndex = lastMatchIndex(prefix, RENT_MARKERS);
  const suffix = line.slice(index - lineStart + length, index - lineStart + length + 36);
  const utilityUnit = /(?:\/\s*(?:kwh|m3|m³)|\bper\s+person\b|\b(?:person|pax)\b)/i.test(suffix);
  return utilityUnit || (utilityIndex >= 0 && utilityIndex > rentIndex);
}

function currency(value: string | undefined, fallback?: 'USD' | 'KHR'): 'USD' | 'KHR' | null {
  const normalized = value?.toUpperCase();
  if (normalized === 'KHR' || normalized === '៛') return 'KHR';
  if (normalized === 'USD' || normalized === '$') return 'USD';
  return fallback ?? null;
}

function amount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Khmer source text can use zero-width separators that regex whitespace does
 * not recognize. Replace them one-for-one so source offsets stay stable for
 * utility-context checks. */
function normalizeSourcePriceText(rawText: string): string {
  return rawText.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ' ')
    // Preserve offsets while exposing prices wrapped in Markdown bold: **$350**.
    .replace(/\*{1,2}(?=\s*(?:USD|KHR|\$|៛)\s*\d)/gi, stars => ' '.repeat(stars.length));
}

/** Price labels in original rental posts do not always include "/month".
 * Accept only a label scoped to an explicit rental offer, or the Khmer
 * "rental price" label. Keep each occurrence for conflicting-tier review. */
function labelledRentalPrices(rawText: string): Array<{ index: number; length: number; value: number; denomination: 'USD' | 'KHR' }> {
  const text = normalizeSourcePriceText(rawText);
  const found: Array<{ index: number; length: number; value: number; denomination: 'USD' | 'KHR' }> = [];
  const pattern = new RegExp(`(?:ថ្លៃ\\s*ឈ្នួល|\\bprice)\\s*[:：=\\-]?\\s*(USD|KHR|\\$|៛)?\\s*${AMOUNT}\\s*(USD|KHR|\\$|៛)?`, 'gi');
  const scopes = [...text.matchAll(/\bfor\s+(?:rent|sale)\b/gi)];
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const explicitKhmerRent = /^ថ្លៃ/i.test(match[0]);
    const preceding = text.slice(Math.max(0, index - 70), index);
    if (!explicitKhmerRent) {
      const scope = scopes.filter(item => (item.index ?? 0) < index).at(-1);
      if (!scope || !/\bfor\s+rent\b/i.test(scope[0])) continue;
      // A generic Price label only inherits a nearby for-rent heading; do not
      // treat a later unrelated listing in the same scraped text as rent.
      if (index - ((scope.index ?? 0) + scope[0].length) > 300) continue;
      // A sale/deposit/utility price can occur after a rental heading.
      if (/(?:\basking|\bsale|\bdeposit|\bbooking|\belectricity|\bwater|\butility|ថ្លៃកក់|ថ្លៃភ្លើង|ថ្លៃទឹក)\s*[:：=-]?\s*$/i.test(preceding)) continue;
    }
    if (isUtilityPriceOccurrence(rawText, index, match[0].length)) continue;
    const denomination = currency(match[1] || match[3]);
    const value = amount(match[2]);
    if (!denomination || value === null) continue;
    found.push({ index, length: match[0].length, value, denomination });
  }
  return found;
}

export function parseSourceListingPrice(rawText: string | null): ParsedSourcePrice | null {
  if (!rawText) return null;
  const searchableText = normalizeSourcePriceText(rawText);
  const labelled = labelledRentalPrices(rawText)[0];
  if (labelled) return { price: labelled.value, currency: labelled.denomination };
  const patterns: Array<{
    regex: RegExp;
    amountGroup: number;
    currencyGroup?: number;
    prefixCurrency?: boolean;
    fallbackCurrency?: 'USD' | 'KHR';
  }> = [
    {
      regex: new RegExp(`(?:monthly\\s+rent|rent(?:al)?\\s+(?:price|rate)|asking\\s+price|price\\s+for\\s+rent)\\s*[:|]?\\s*(USD|KHR|\\$|៛)?\\s*${AMOUNT}`, 'gi'),
      amountGroup: 2, currencyGroup: 1,
    },
    {
      regex: new RegExp(`(?:USD|KHR|\\$|៛)\\s*${AMOUNT}\\s*(?:/\\s*(?:months?|mo)|per\\s+month|monthly|ខែ)`, 'gi'),
      amountGroup: 1, prefixCurrency: true,
    },
    {
      // Khmer24 sometimes places the property type between the slash and
      // "per month", e.g. "369USD/ Villa per month".
      regex: new RegExp(`${AMOUNT}\\s*(USD|KHR|\\$|៛)\\s*/\\s*(?:villa|house|room|apartment|flat|studio|shophouse|condo)\\s+per\\s+month`, 'gi'),
      amountGroup: 1, currencyGroup: 2,
    },
    {
      // Khmer rental copy can state a rate as "$119/per 1 month".
      regex: new RegExp(`${AMOUNT}\\s*(USD|KHR|\\$|៛)\\s*/?\\s*(?:ក្នុង\\s*)?(?:1|១)\\s*ខែ`, 'gi'),
      amountGroup: 1, currencyGroup: 2,
    },
    {
      regex: new RegExp(`${AMOUNT}\\s*(USD|KHR|\\$|៛)\\s*(?:/\\s*(?:months?|mo)|per\\s+month|monthly|ខែ)`, 'gi'),
      amountGroup: 1, currencyGroup: 2,
    },
    {
      // Some Khmer rental copy states the duration before the amount:
      // "one month 300$" / "មួយខែ300$".
      regex: new RegExp(`(?:one\\s+month|1\\s+month|មួយ\\s*ខែ)\\s*${AMOUNT}\\s*(USD|KHR|\\$|៛)`, 'gi'),
      amountGroup: 1, currencyGroup: 2,
    },
    {
      regex: new RegExp(`(?:one\\s+month|1\\s+month|មួយ\\s*ខែ)\\s*(USD|KHR|\\$|៛)\\s*${AMOUNT}`, 'gi'),
      amountGroup: 2, currencyGroup: 1,
    },
    { regex: new RegExp(`\\bUSD\\s*${AMOUNT}`, 'gi'), amountGroup: 1, fallbackCurrency: 'USD' },
    { regex: new RegExp(`\\bKHR\\s*${AMOUNT}`, 'gi'), amountGroup: 1, fallbackCurrency: 'KHR' },
  ];

  for (const pattern of patterns) {
    for (const match of searchableText.matchAll(pattern.regex)) {
      const index = match.index ?? 0;
      if (isUtilityPriceOccurrence(rawText, index, match[0].length)) continue;
      const price = amount(match[pattern.amountGroup]);
      if (price === null) continue;
      const currencyValue = pattern.currencyGroup ? match[pattern.currencyGroup]
        : pattern.prefixCurrency ? /^(USD|KHR|\$|៛)/i.exec(match[0])?.[1] : undefined;
      return { price, currency: currency(currencyValue, pattern.fallbackCurrency) };
    }
  }
  return null;
}

/** Literal monthly rent evidence used by moderation. Utility charges are excluded. */
export function sourceMonthlyPrices(rawText: string): number[] {
  const searchableText = normalizeSourcePriceText(rawText);
  const patterns: Array<{ regex: RegExp; amountGroup?: number }> = [
    { regex: new RegExp(`(?:rent(?:al)?\\s*(?:price)?|price\\s*(?:for\\s*)?rent|តម្លៃជួល|តំលៃជួល)\\s*[:\\-=]?\\s*(?:USD\\s*|\\$\\s*)?${AMOUNT}\\s*(?:USD|\\$)?`, 'gi') },
    { regex: new RegExp(`(?:USD\\s*|\\$\\s*)${AMOUNT}(?:\\s*(?:USD|\\$))?\\s*(?:/\\s*(?:mo(?:nth)?s?|ខែ)|per\\s+month|monthly|ខែ)`, 'gi') },
    { regex: new RegExp(`${AMOUNT}\\s*(?:USD|KHR|\\$|៛)\\s*/\\s*(?:villa|house|room|apartment|flat|studio|shophouse|condo)\\s+per\\s+month`, 'gi') },
    { regex: new RegExp(`${AMOUNT}\\s*(?:USD|KHR|\\$|៛)\\s*/?\\s*(?:ក្នុង\\s*)?(?:1|១)\\s*ខែ`, 'gi') },
    { regex: new RegExp(`${AMOUNT}\\s*(?:\\$|USD)?\\s*(?:/\\s*(?:mo(?:nth)?s?|ខែ)|per\\s+month|ខែ)`, 'gi') },
    { regex: new RegExp(`(?:one\\s+month|1\\s+month|មួយ\\s*ខែ)\\s*(?:USD|KHR|\\$|៛)\\s*${AMOUNT}`, 'gi') },
    { regex: new RegExp(`(?:one\\s+month|1\\s+month|មួយ\\s*ខែ)\\s*${AMOUNT}\\s*(?:USD|KHR|\\$|៛)`, 'gi') },
  ];
  const found = new Set<number>();
  for (const item of labelledRentalPrices(rawText)) {
    if (item.denomination === 'USD' && item.value >= 30 && item.value <= 100_000) found.add(item.value);
  }
  for (const pattern of patterns) for (const match of searchableText.matchAll(pattern.regex)) {
    const index = match.index ?? 0;
    if (isUtilityPriceOccurrence(rawText, index, match[0].length)) continue;
    const value = amount(match[pattern.amountGroup ?? 1]);
    if (value !== null && value >= 30 && value <= 100_000) found.add(value);
  }
  return [...found];
}

/** Amounts explicitly labelled as an asking price. This is not monthly-rent
 * proof by itself; moderation may use it only with independent rent context. */
export function sourceAskingPrices(rawText: string): number[] {
  const searchableText = normalizeSourcePriceText(rawText);
  const found = new Set<number>();
  const pattern = new RegExp(`\\basking\\s+price\\s*[:：=]?\\s*(?:USD\\s*|\\$\\s*)${AMOUNT}`, 'gi');
  for (const match of searchableText.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (isUtilityPriceOccurrence(rawText, index, match[0].length)) continue;
    const value = amount(match[1]);
    if (value !== null && value >= 30 && value <= 100_000) found.add(value);
  }
  return [...found];
}
