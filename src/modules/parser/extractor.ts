import { DISTRICTS, type CityKey, type PropertyCategory } from '../../config/settings';
import { findCanonicalLocation } from '../../config/locations';
import { khrToUsdCents, normalizeLocationString, normalizePriceString, usdToUsdCents } from './normalizer';
import { extractCanonicalListingsBatch } from './canonical-listing-extractor';
import { toLegacyListingExtraction } from './canonical-listing-adapter';
import type { ListingExtraction } from './listing-extraction';
import { createAiRouter, validateCompleteBatchItems } from '../ai';

// ─── Canonical LLM extraction adapters ──────────────────────────────────────

export interface LLMExtractedListing {
  /** Full, lossless facts from the canonical extractor; legacy columns are only a projection. */
  canonical_facts?: ListingExtraction;
  is_real_estate: boolean | null;
  admission_reason?: string | null;
  title_en: string;
  price: number | null;
  currency: 'USD' | 'KHR';
  category: 'apartment' | 'house' | 'room' | 'hotel' | 'land' | 'commercial' | null;
  property_type?: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  min_lease: number | null; // in months
  deposit?: number | null;
  deposit_amount?: number | null;
  deposit_months?: number | null;
  has_pool: boolean | null;
  electricity?: string | null;
  water?: string | null;
  cleaning?: string | null;
  restrictions?: string[];
  pet_friendly: boolean | null;
  landmarks?: string[];
  location: string | null;
  marketing_landmarks?: string[];
  phone_numbers: string[]; // Extract all phone numbers found
  maps_url: string | null;
  description_en: string;
  discovered_amenities?: string[];
}


/**
 * Checks if a text has more than `threshold` (default 10%) Khmer characters.
 */
export function prepareLlmInput(text: string, maxChars = 8_000): string {
  const seen = new Set<string>();
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || /^(?:see more|like|comment|share|send message)$/i.test(line)) return false;
      const key = line.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const cleaned = cleanedLines.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  const tailSize = Math.min(1_000, Math.floor(maxChars / 4));
  return `${cleaned.slice(0, maxChars - tailSize)}\n…\n${cleaned.slice(-tailSize)}`;
}

export function isExcessiveKhmer(text: string | null | undefined, threshold = 0.10): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const khmerMatches = trimmed.match(/[\u1780-\u17FF]/g);
  if (!khmerMatches) return false;
  return khmerMatches.length / trimmed.length > threshold;
}


// ─── Regex Heuristic Fallbacks for Utilities & Property Types ─────────────────

export function extractElectricity(text: string): string | null {
  // 1. Included / All inclusive
  if (
    /\b(?:free\s+electric(?:ity)?|electric(?:ity)?\s+free|utilities\s+included|all\s+inclusive|electricity\s*:\s*included)\b/i.test(text) ||
    /ភ្លើងឥតគិតថ្លៃ|ភ្លើងហ្វ្រី|រួមបញ្ចូលភ្លើង/.test(text)
  ) {
    return 'Included';
  }

  // 2. EDC / State rate / Government rate / 720r
  if (
    /\b(?:edc|electricit[eé]\s+du\s+cambodge|state\s+rate|gov(?:ernment)?\s+rate|state\s+electric(?:ity)?)\b/i.test(text) ||
    /ភ្លើងរដ្ឋ/.test(text) ||
    /(?:electricity|electric|ភ្លើង)\s*:\s*(?:720|740)\s*(?:r|riel|៛)/i.test(text)
  ) {
    return 'EDC (State Rate) ~$0.20/kWh';
  }

  // 3a. Fixed dollar rate with explicit electricity keyword (e.g. "Electricity: $0.25/kWh", "Electric 0.25$", "Electricity: 0.25")
  const kwDollarMatch = /(?:electricity|electric|power|⚡|ភ្លើង|ថ្លៃភ្លើង)\s*(?::|\s+is|-)?\s*\$?(0\.\d{1,2})\s*\$?(?:\s*\/\s*(?:kwh|kw|unit|degree)|\s*per\s*(?:kwh|kw|unit))?/i.exec(text);
  if (kwDollarMatch) {
    const val = parseFloat(kwDollarMatch[1]);
    if (val >= 0.15 && val <= 0.80) {
      return `Fixed Rate ($${val.toFixed(2)}/kWh)`;
    }
  }

  // 3b. Fixed dollar rate with explicit unit /kWh or /kw without explicit electricity keyword (e.g. "$0.25/kWh")
  const unitDollarMatch = /\$?(0\.\d{1,2})\s*\$?\s*(?:\/\s*(?:kwh|kw|unit)|per\s*(?:kwh|kw))\b/i.exec(text);
  if (unitDollarMatch) {
    const val = parseFloat(unitDollarMatch[1]);
    if (val >= 0.15 && val <= 0.80) {
      return `Fixed Rate ($${val.toFixed(2)}/kWh)`;
    }
  }

  // 4a. Fixed Riel rate with explicit keyword (e.g. "Electricity 1000r", "Electricity: 1,000 riels/kwh", "ភ្លើង 1000៛")
  const kwRielMatch = /(?:electricity|electric|power|⚡|ភ្លើង|ថ្លៃភ្លើង)\s*(?::|\s+is|-)?\s*([1-9][\d,]{2,4})\s*(?:r|riel|៛)?(?:\s*\/\s*(?:kwh|kw|unit|degree)|\s*per\s*(?:kwh|kw|unit))?/i.exec(text);
  if (kwRielMatch) {
    const cleanNum = kwRielMatch[1].replace(/,/g, '');
    const val = parseInt(cleanNum, 10);
    if (val >= 500 && val <= 3500) {
      return `Fixed Rate (${val}៛/kWh)`;
    }
  }

  // 4b. Fixed Riel rate with explicit unit /kWh (e.g. "1,000 riels/kwh")
  const unitRielMatch = /([1-9][\d,]{2,4})\s*(?:r|riel|៛)\s*(?:\/\s*(?:kwh|kw|unit)|per\s*(?:kwh|kw))\b/i.exec(text);
  if (unitRielMatch) {
    const cleanNum = unitRielMatch[1].replace(/,/g, '');
    const val = parseInt(cleanNum, 10);
    if (val >= 500 && val <= 3500) {
      return `Fixed Rate (${val}៛/kWh)`;
    }
  }

  return null;
}

export function extractWater(text: string): string | null {
  // 1. Included / Free
  if (
    /\b(?:free\s+water|water\s+free|water\s*(?::|\s+is)?\s*included|including\s+water|water\s*:\s*free|water\s+supply\s+free)\b/i.test(text) ||
    /ទឹកឥតគិតថ្លៃ|ទឹកហ្វ្រី|រួមបញ្ចូលទឹក/.test(text)
  ) {
    return 'Included';
  }

  // 2. State rate / PPWSA / 1000r/m3
  if (
    /\b(?:state\s+water|gov(?:ernment)?\s+water|state\s+rate\s+water|ppwsa|1000\s*(?:r|riel|៛)?\s*\/\s*m[3³])\b/i.test(text) ||
    /(?:water|ទឹក)\s*:\s*(?:state|gov|រដ្ឋ|1000\s*(?:r|riel|៛)?\s*\/\s*m[3³])/i.test(text) ||
    /ទឹករដ្ឋ|ទឹកដ្ឋ/.test(text)
  ) {
    return 'State Rate (~1000៛/m³)';
  }

  // 3a. Fixed per cubic meter ($/m3, e.g. "$0.50/m3", "0.5$/m³")
  const m3DollarMatch = /(?:water|water\s+supply|ទឹក|ថ្លៃទឹក|💧)?\s*(?::|\s+is|-)?\s*\$?(0\.\d{1,2})\s*\$?\s*(?:\/\s*(?:m3|m³|cubic\s*meter)|per\s*(?:m3|m³))/i.exec(text);
  if (m3DollarMatch) {
    const val = parseFloat(m3DollarMatch[1]);
    if (val >= 0.15 && val <= 2.50) {
      return `Fixed Rate ($${val.toFixed(2)}/m³)`;
    }
  }

  // 3b. Fixed per cubic meter (Riel/m3, e.g. "water 2,000 riels/m³", "2500 riel/m3")
  const m3RielMatch = /(?:water|water\s+supply|ទឹក|ថ្លៃទឹក|💧)?\s*(?::|\s+is|-)?\s*([1-9][\d,]{2,4})\s*(?:r|riels?|៛)?\s*(?:\/\s*(?:m3|m³|cubic\s*meter)|per\s*(?:m3|m³))/i.exec(text);
  if (m3RielMatch) {
    const cleanNum = m3RielMatch[1].replace(/,/g, '');
    const val = parseInt(cleanNum, 10);
    if (val >= 500 && val <= 5000) {
      return `Fixed Rate (${val}៛/m³)`;
    }
  }

  // 4a. Fixed per person (e.g. "Water: $5/person", "5$/pax", "Water: 5$/person")
  const personMatch = /(?:water|water\s+supply|ទឹក|ថ្លៃទឹក|💧)\s*(?::|\s+is|-)?\s*\$?(\d+(?:\.\d+)?)\s*\$?\s*(?:\/\s*(?:person|pax|people)|per\s*(?:person|pax|people))/i.exec(text);
  if (personMatch) {
    return `Fixed ($${personMatch[1]}/person)`;
  }

  // 4b. Fixed per month (e.g. "Water: $5/month", "Water: $5", "Water 5$/mo", "Water: 5$")
  const monthMatch = /(?:water|water\s+supply|ទឹក|ថ្លៃទឹក|💧)\s*(?::|\s+is|-)?\s*\$?(\d+(?:\.\d+)?)\s*\$?(?:\s*(?:\/\s*(?:month|mo)|per\s*(?:month|mo)))?/i.exec(text);
  if (monthMatch) {
    const val = parseFloat(monthMatch[1]);
    if (val >= 1 && val <= 50) {
      return `Fixed ($${val}/month)`;
    }
  }

  return null;
}

const AMENITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:swimming\s+pool|private\s+pool|pool)\b/i, 'Swimming Pool'],
  [/\b(?:gym|fitness)\b/i, 'Gym'],
  [/\b(?:wifi|wi-fi|internet)\b/i, 'WiFi'],
  [/\b(?:air\s+conditioner|ac|aircon|air-conditioning|air\s+conditioning)\b/i, 'AC'],
  [/\b(?:washing\s+machine|washer)\b/i, 'Washing Machine'],
  [/\b(?:fridge|refrigerator)\b/i, 'Fridge'],
  [/\b(?:generator)\b/i, 'Generator'],
  [/\b(?:parking|garage|motor\s+parking|car\s+park)\b/i, 'Parking'],
  [/\b(?:balcony|balconies)\b/i, 'Balcony'],
  [/\b(?:fully\s+furnished|furnished)\b/i, 'Furnished'],
  [/\b(?:steam|sauna)\b/i, 'Sauna/Steam'],
  [/\b(?:cable\s+tv|tv)\b/i, 'Cable TV'],
  [/\b(?:mosquito\s+screen|mosquito\s+net)\b/i, 'Mosquito Screens'],
  [/\b(?:kitchen\s+hood|stove|cooker)\b/i, 'Kitchen Appliances'],
];

export function extractAmenities(text: string): string[] {
  const found = new Set<string>();
  for (const [re, name] of AMENITY_PATTERNS) {
    if (re.test(text)) found.add(name);
  }
  return Array.from(found);
}

export function extractPropertyType(text: string, category?: PropertyCategory | string | null): string | null {
  // 1. Flat House (Shophouse / ផ្ទះល្វែង)
  if (
    /\b(?:flat\s*house|shophouse|shop\s*house|flathouse)\b/i.test(text) ||
    /ផ្ទះល្វែង/.test(text)
  ) {
    return 'Flat House';
  }

  // 2. Private Villa (ផ្ទះវីឡា)
  if (
    /\b(?:villa|private\s+villa|detached\s+villa|luxury\s+villa)\b/i.test(text) ||
    /ផ្ទះវីឡា/.test(text)
  ) {
    return 'Private Villa';
  }

  // 3. Private House
  if (/\b(?:private\s+house|detached\s+house|entire\s+house|whole\s+house|wooden\s+house|khmer\s+house)\b/i.test(text)) {
    return 'Private House';
  }

  // 4. Hotel Room
  if (category === 'hotel' || /\b(?:hotel\s+room|boutique\s+hotel|hotel\s+suite)\b/i.test(text)) {
    return 'Hotel Room';
  }

  // 5. Studio — a self-contained single-unit studio (own bathroom/kitchenette, no
  // separate bedroom wall). Checked BEFORE Condo/Apartment so "Studio Condo" /
  // "Studio Apartment" text reads as the more specific "Studio".
  if (/\bstudio\b/i.test(text)) {
    return 'Studio';
  }

  // 6. Condo
  if (/\b(?:condo|condominium)\b/i.test(text)) {
    return 'Condo';
  }

  // 7. Apartment
  if (category === 'apartment' || /\b(?:apartment|serviced\s+apartment)\b/i.test(text)) {
    return 'Apartment';
  }

  // 8. Room — ONLY a single room rented inside a shared house/building without its
  // own private kitchen (NOT a self-contained studio/apartment/condo, which are
  // handled above). Deliberately narrow to avoid false positives on "bedroom",
  // "living room", etc.
  if (
    category === 'room' ||
    /\b(?:single\s+room|private\s+room|shared\s+room|room\s+for\s+rent|room\s+available)\b/i.test(text)
  ) {
    return 'Room';
  }

  return null;
}

/**
 * Derives the coarse filter `category` (apartment/house/room/hotel) from the more
 * granular `property_type` (Condo/Apartment/Studio/Room/Private Villa/Private
 * House/Flat House/Hotel Room). This is the SINGLE SOURCE OF TRUTH for category
 * once a property_type is known — it must be preferred over whatever category the
 * scrape source page or LLM's own (looser) `category` field guessed, so that
 * self-contained studios/condos/apartments never get miscategorized as "room"
 * just because they were discovered on a "Room for Rent" listing page (Khmer24)
 * or the LLM only returned property_type and left category null.
 */
export function categoryFromPropertyType(propertyType?: string | null): PropertyCategory | null {
  if (!propertyType || typeof propertyType !== 'string') return null;
  const normalized = propertyType.trim().toLowerCase();
  if (normalized.includes('hotel') && normalized.includes('room')) return 'hotel';
  if (normalized === 'room' || normalized.includes('private room') || normalized.includes('shared room')) return 'room';
  if (
    normalized.includes('studio') ||
    normalized.includes('apartment') ||
    normalized.includes('condo')
  ) {
    return 'apartment';
  }
  if (
    normalized.includes('house') ||
    normalized.includes('villa') ||
    normalized.includes('flat house') ||
    normalized.includes('shophouse')
  ) {
    return 'house';
  }
  return null;
}

// All listing extraction now uses the canonical contract and the shared model cascade.
export async function extractListingWithLLM(
  text: string,
  _customSystemInstruction?: string,
): Promise<LLMExtractedListing | null> {
  const results = await extractCanonicalListingsBatch([{ id: '0', text: prepareLlmInput(text) }]);
  const facts = results.get('0');
  return facts ? toLegacyListingExtraction(facts) : null;
}

export async function extractListingsBatchWithLLM(
  items: Array<{ id: string | number; text: string }>,
  sourceNotes?: string,
): Promise<Map<string | number, LLMExtractedListing>> {
  const results = new Map<string | number, LLMExtractedListing>();
  if (!items.length) return results;
  const extracted = await extractCanonicalListingsBatch(
    items.map((item) => ({ id: item.id, text: prepareLlmInput(item.text) })),
    sourceNotes,
  );
  for (const [id, facts] of extracted) results.set(id, toLegacyListingExtraction(facts));
  return results;
}

export interface ClassifiedListing {
  class: 'rental' | 'sale' | 'commercial' | 'daily' | 'not_property' | 'unclear';
  reason: string;
}

/** Compatibility for the old maintenance CLI; the CLI's active path uses canonical reparse. */
export async function classifyListingsBatchWithLLM(
  items: Array<{ id: string | number; text: string }>,
  systemInstruction: string,
): Promise<Map<string | number, ClassifiedListing>> {
  const results = new Map<string | number, ClassifiedListing>();
  if (!items.length) return results;
  const ids = items.map((item) => String(item.id));
  try {
    const { data } = await createAiRouter().generateJson<{ items: Array<{ id: string; class: ClassifiedListing['class']; reason: string }> }>({
      systemPrompt: systemInstruction + '\nReturn a JSON object with items: [{id, class, reason}].',
      userPrompt: JSON.stringify(items.map((item) => ({ id: String(item.id), text: prepareLlmInput(item.text) }))),
      validate: (value) => validateCompleteBatchItems(value, ids),
    });
    for (const entry of data.items) {
      if (ids.includes(entry.id) && ['rental', 'sale', 'commercial', 'daily', 'not_property', 'unclear'].includes(entry.class)) {
        results.set(items.find((item) => String(item.id) === entry.id)!.id, { class: entry.class, reason: entry.reason ?? '' });
      }
    }
  } catch (error) {
    console.warn('[Extractor] Classification batch failed:', error);
  }
  for (const item of items) if (!results.has(item.id)) results.set(item.id, { class: 'unclear', reason: 'classification unavailable' });
  return results;
}

// ─── Price extraction ─────────────────────────────────────────────────────────

export interface ExtractedPrice {
  /** Amount in USD cents */
  amountCents: number;
  currency: 'USD' | 'KHR';
  rawAmount: number;
}

const PRICE_PATTERNS: RegExp[] = [
  /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?/i,
  /([\d,]+(?:\.\d+)?)\s*USD\b/i,
  /([\d,]+(?:\.\d+)?)\s*\$/i,
  /([\d,]+)\s*(?:riel|KHR)\b/i,
];

export function extractPrice(text: string): ExtractedPrice | null {
  for (const pattern of PRICE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || !match[1]) continue;

    const raw = normalizePriceString(match[1]);
    let amount = parseFloat(raw);
    if (isNaN(amount) || amount <= 0) continue;

    if (match[2]?.toLowerCase() === 'k') {
      amount *= 1_000;
    }

    const isKhr = /riel|khr/i.test(match[0]) || (!match[0].includes('$') && amount > 50_000);

    if (isKhr) {
      return { rawAmount: amount, currency: 'KHR', amountCents: khrToUsdCents(amount) };
    }

    return { rawAmount: amount, currency: 'USD', amountCents: usdToUsdCents(amount) };
  }

  return null;
}

// ─── Deposit extraction ───────────────────────────────────────────────────────

export function extractDeposit(text: string, rentPriceCents?: number): number | null {
  // Check for explicit month deposits first: "2 months deposit", "2-month deposit",
  // "deposit 2 months", "deposit: 2 months".
  const monthMatch =
    /(?:deposit)\s*(?::|=)?\s*(\d+)\s*(?:month|months|mo|mos)\b/i.exec(text) ||
    /(\d+)\s*(?:month|months|mo|mos)(?:\s*of)?\s*deposit/i.exec(text) ||
    /(\d+)\s*-?\s*(?:month|months|mo|mos)\s*deposit/i.exec(text);
  if (monthMatch?.[1] && rentPriceCents) {
    const months = parseInt(monthMatch[1], 10);
    if (!isNaN(months) && months > 0 && months <= 12) {
      return rentPriceCents * months;
    }
  }

  // Check for "$500 deposit" or "deposit: $500"
  const dollarMatch = /(?:deposit|security\s*deposit)\s*(?::|is|=|of)?\s*\$\s*([\d,]+)/i.exec(text);
  if (dollarMatch?.[1]) {
    const num = parseFloat(normalizePriceString(dollarMatch[1]));
    if (!isNaN(num) && num > 0) {
      return usdToUsdCents(num);
    }
  }

  return null;
}

// ─── Minimum Lease extraction ─────────────────────────────────────────────────

export function extractMinLease(text: string): number | null {
  // "6 months minimum lease", "min lease: 6 months", "1 year lease", "1 year contract"
  const yearMatch = /(?:min(?:imum)?\s*lease|contract|lease\s*term|term)\s*(?::|is|=|of)?\s*(\d+)\s*(?:year|years|yr|yrs)/i.exec(text)
    || /(\d+)\s*(?:year|years|yr|yrs)\s*(?:minimum\s*)?(?:lease|contract)/i.exec(text);
  if (yearMatch?.[1]) {
    const years = parseInt(yearMatch[1], 10);
    if (!isNaN(years) && years > 0 && years <= 10) return years * 12;
  }

  const monthMatch = /(?:min(?:imum)?\s*lease|contract|lease\s*term|term)\s*(?::|is|=|of)?\s*(\d+)\s*(?:month|months|mo|mos)/i.exec(text)
    || /(\d+)\s*(?:month|months|mo|mos)\s*(?:minimum\s*)?(?:lease|contract)/i.exec(text);
  if (monthMatch?.[1]) {
    const months = parseInt(monthMatch[1], 10);
    if (!isNaN(months) && months >= 1 && months <= 60) return months;
  }

  if (/\b(?:month to month|monthly lease|short term available)\b/i.test(text)) {
    return 1;
  }

  return null;
}

// ─── Category extraction ──────────────────────────────────────────────────────

export function extractCategory(text: string): PropertyCategory | null {
  if (/\b(hotel\s+room|boutique\s+hotel|hotel\s+suite|hotel-style|hotel)\b/i.test(text)) {
    return 'hotel';
  }
  if (/\b(villa|house|townhouse|shophouse|borey)\b/i.test(text)) {
    return 'house';
  }
  if (/\b(condo|condominium|apartment|flat|serviced apartment|penthouse)\b/i.test(text)) {
    return 'apartment';
  }
  if (/\b(room|studio|single room|private room)\b/i.test(text)) {
    return 'room';
  }
  return null;
}

// ─── Swimming Pool extraction ─────────────────────────────────────────────────

export function extractHasPool(text: string): boolean | null {
  if (
    /អាងហែលទឹក/.test(text) ||
    /\b(swimming pool|swimmingpool|private pool|rooftop pool|shared pool|pool access|with pool|has pool)\b/i.test(text)
  ) {
    return true;
  }
  // A text that explicitly rules out a pool lets us return false.
  if (/\b(?:no\s+pool|without\s+pool|no\s+swimming\s+pool)\b/i.test(text)) {
    return false;
  }
  return null;
}

// ─── Google Maps URL extraction ───────────────────────────────────────────────

export function extractMapsUrl(text: string): string | null {
  const match = /(https?:\/\/(?:www\.)?(?:google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)\S+)/i.exec(text);
  return match?.[1] ?? null;
}

// ─── Bedrooms extraction ──────────────────────────────────────────────────────

const BEDROOM_PATTERNS: RegExp[] = [
  /(\d+)\s*បន្ទប់គេង/,
  /(\d+)\s*(?:BR|bed(?:room)?s?)\b/i,
  /(\d+)\s*(?:BDR|BDRM)\b/i,
  /(\d+)\s*-\s*bed(?:room)?s?\b/i,
];

export function extractBedrooms(text: string): number | null {
  if (/\bstudio\b/i.test(text)) return 0;

  for (const pattern of BEDROOM_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const n = parseInt(match[1], 10);
      if (!isNaN(n) && n >= 0 && n <= 20) return n;
    }
  }

  return null;
}

// ─── Bathrooms extraction ─────────────────────────────────────────────────────

export function extractBathrooms(text: string): number | null {
  const khmerMatch = /(\d+)\s*បន្ទប់ទឹក/.exec(text);
  if (khmerMatch?.[1]) {
    const n = parseInt(khmerMatch[1], 10);
    if (!isNaN(n) && n >= 0 && n <= 20) return n;
  }

  const match = /(\d+)\s*(?:bath(?:room)?s?|WC)\b/i.exec(text);
  if (match?.[1]) {
    const n = parseInt(match[1], 10);
    if (!isNaN(n) && n >= 0 && n <= 20) return n;
  }
  return null;
}

// ─── Location extraction ──────────────────────────────────────────────────────

/** Flat list of all known districts with their parent city key. */
const ALL_DISTRICTS = (Object.entries(DISTRICTS) as [CityKey, readonly string[]][]).flatMap(
  ([city, districts]) => districts.map((district) => ({ city, district })),
);

export const KHMER_SANGKAT_MAP: Array<{ regex: RegExp; location: string; city: CityKey }> = [
  { regex: /ស្វាយដង្គុំ/i, location: 'Svay Dangkum', city: 'siem_reap' },
  { regex: /សាលាកំរើក/i, location: 'Sala Kamreuk', city: 'siem_reap' },
  { regex: /ស្លក្រាម/i, location: 'Sla Kram', city: 'siem_reap' },
  { regex: /ជ្រាវ/i, location: 'Chreav', city: 'siem_reap' },
  { regex: /វត្តបូព៌|វត្តបូ/i, location: 'Wat Bo', city: 'siem_reap' },
  { regex: /វត្តដំណាក់/i, location: 'Wat Damnak', city: 'siem_reap' },
  { regex: /គោកចក/i, location: 'Kouk Chak', city: 'siem_reap' },
  { regex: /សំបួរ/i, location: 'Sambuor', city: 'siem_reap' },
  { regex: /បឹងកេងកង|BKK1|BKK\s*1/i, location: 'BKK1', city: 'phnom_penh' },
  { regex: /ទួលទំពូង/i, location: 'Toul Tom Poung', city: 'phnom_penh' },
  { regex: /ទន្លេបាសាក់/i, location: 'Tonle Bassac', city: 'phnom_penh' },
  { regex: /ដូនពេញ/i, location: 'Daun Penh', city: 'phnom_penh' },
  { regex: /ទួលគោក/i, location: 'Tuol Kouk', city: 'phnom_penh' },
  { regex: /ជ្រោយចង្វារ/i, location: 'Chroy Changvar', city: 'phnom_penh' },
  { regex: /ច្បារអំពៅ/i, location: 'Chbar Ampov', city: 'phnom_penh' },
  { regex: /បឹងកក់/i, location: 'Boeung Kak', city: 'phnom_penh' },
];

export interface ExtractedLocation {
  location: string;
  city: CityKey;
}

/**
 * Attempts to match text against known district / sangkat lists (supporting both Khmer & English).
 *
 * @param restrictCity - When the caller already knows the listing's city from a reliable source
 *   (a Khmer24 category page or a Facebook group are always single-city, assigned at scrape time),
 *   pass it here to only search that city's districts. Post text frequently name-drops the OTHER
 *   city for marketing/comparison purposes (e.g. "cheaper than BKK1", "closer than Phnom Penh"),
 *   which — without this restriction — would silently flip the listing into the wrong city tab.
 *   Leave undefined only when the city is genuinely unknown (e.g. manual/bulk JSON import).
 */
export function extractLocation(text: string, restrictCity?: CityKey): ExtractedLocation | null {
  // 1. Check direct Khmer Sangkat mentions
  for (const entry of KHMER_SANGKAT_MAP) {
    if (restrictCity && entry.city !== restrictCity) continue;
    if (entry.regex.test(text)) {
      return { location: entry.location, city: entry.city };
    }
  }

  // 2. Check normalized English district names
  const normalized = normalizeLocationString(text);

  for (const { city, district } of ALL_DISTRICTS) {
    if (restrictCity && city !== restrictCity) continue;
    const normDistrict = normalizeLocationString(district);
    const abbrevMatch = /^\S+/.exec(normDistrict);
    const abbrev = abbrevMatch ? abbrevMatch[0] : '';

    if (
      normalized.includes(normDistrict) ||
      (abbrev.length >= 5 && normalized.includes(abbrev))
    ) {
      return { location: district, city };
    }
  }

  // 3. Fallback to canonical location aliases (handles K24 full addresses
  // like "Boeng Kak Muoy, Tuol Kouk, Phnom Penh" and alternate spellings)
  const canonical = findCanonicalLocation(text, restrictCity);
  if (canonical) {
    return { location: canonical.canonicalName, city: canonical.city };
  }

  return null;
}

// ─── Type extraction ──────────────────────────────────────────────────────────

export function extractType(text: string): 'rent' | 'sale' | null {
  if (/\b(for sale|to sell|selling|buy now|purchase)\b/i.test(text)) return 'sale';
  if (/\b(for rent|to rent|rental|lease|let|available for)\b/i.test(text)) return 'rent';
  return null;
}
