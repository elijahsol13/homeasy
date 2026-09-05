import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { DISTRICTS, type CityKey, type PropertyCategory } from '../../config/settings';
import { khrToUsdCents, normalizeLocationString, normalizePriceString, usdToUsdCents } from './normalizer';
import { env } from '../../config/env';

// ─── LLM-based Extraction (Gemini Free Tier & OpenAI gpt-4o-mini) ────────────

export interface LLMExtractedListing {
  is_real_estate: boolean;
  title: string;
  price: number | null;
  currency: 'USD' | 'KHR';
  category: 'apartment' | 'house' | 'room' | 'hotel' | 'land' | null;
  bedrooms: number | null;
  bathrooms: number | null;
  min_lease: number | null; // in months
  has_pool: boolean;
  location: string | null;
  phone_numbers: string[]; // Extract all phone numbers found
  maps_url: string | null;
  description_en: string;
}

export const VALID_SANGKATS: readonly string[] = [
  ...DISTRICTS.siem_reap,
  ...DISTRICTS.phnom_penh,
];

const SYSTEM_INSTRUCTIONS =
  "You are a real estate data extraction API. Translate the input to English. Extract the data and return a JSON object exactly matching this schema:\n" +
  "{\n" +
  '  "is_real_estate": boolean,\n' +
  '  "title": string,\n' +
  '  "price": number,\n' +
  '  "currency": "USD" | "KHR",\n' +
  '  "category": "apartment" | "house" | "room" | "hotel" | "land",\n' +
  '  "bedrooms": number | null,\n' +
  '  "bathrooms": number | null,\n' +
  '  "min_lease": number | null,\n' +
  '  "has_pool": boolean,\n' +
  '  "location": string | null,\n' +
  '  "phone_numbers": string[],\n' +
  '  "maps_url": string | null,\n' +
  '  "description_en": string\n' +
  "}\n\n" +
  "STRICT RULES:\n" +
  "- `is_real_estate`: MUST be false if the post is selling second-hand goods, vehicles, electronics, furniture, food, or general non-property items.\n" +
  "- `title`: Must be a short, catchy title (max 5 words, e.g., 'Modern 2BR Apartment'). Do NOT just copy the description.\n" +
  "- `price`: The total price or monthly rent amount as a clean number without symbols (e.g. 350 for '$350/month', '$350' or '350$'). If not found, return null.\n" +
  "- `min_lease`: Read the text carefully! If it mentions '6 months lease', '6 Months at lease', '6 months contract' or 'from 6 months', return 6. If '1 year' or '12 months', return 12. If 'long term', return 6. If 'short term' or 'monthly', return 1. If not mentioned, return null.\n" +
  "- `phone_numbers`: Extract ALL phone numbers found (WhatsApp, Telegram, local, international). Strip non-numeric characters except leading '+'. Example: ['+85577448002', '089899084'].\n" +
  "- `description_en`: DO NOT repeat the price, location, or title. Extract ONLY actual amenities (e.g. Fridge, Washing Machine, AC, Secure Parking, Balcony, WiFi) and lease conditions (e.g. Excludes Electricity, Free Water, Pet Friendly). Return strictly as 1-3 short bullet points.\n" +
  `- \`location\`: Analyze the text and map the location to ONE of these exact values: [${VALID_SANGKATS.join(', ')}]. If the text mentions a location that matches or falls within one of these areas, return that specific area name. If NO location is mentioned, you MUST return null. Do not guess or invent a location.\n` +
  "- `maps_url`: If the post contains a Google Maps link (goo.gl, google.com/maps, maps.app.goo.gl), extract it here. Otherwise, return null.\n" +
  "- If the property is a hotel room, hotel suite, or boutique hotel room, return category: 'hotel'.\n" +
  "- If the post is selling land, return category: 'land'.";

let genAIInstance: GoogleGenerativeAI | null = null;
let openAIInstance: OpenAI | null = null;

function getGeminiKey(): string | undefined {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  if (env.OPENAI_API_KEY && (env.OPENAI_API_KEY.startsWith('AQ.') || env.OPENAI_API_KEY.startsWith('AIza'))) {
    return env.OPENAI_API_KEY;
  }
  return undefined;
}

function getOpenAIKey(): string | undefined {
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.startsWith('sk-')) {
    return env.OPENAI_API_KEY;
  }
  return undefined;
}

function sanitizeLlmResult(rawJson: string): LLMExtractedListing | null {
  try {
    const cleanJson = rawJson.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson) as Partial<LLMExtractedListing>;

    const is_real_estate = parsed.is_real_estate !== false;
    const title = typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title.trim() : '';

    let price: number | null = typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : null;
    const currency: 'USD' | 'KHR' = parsed.currency === 'KHR' ? 'KHR' : 'USD';
    let category: LLMExtractedListing['category'] = null;
    if (parsed.category && ['apartment', 'house', 'room', 'hotel', 'land'].includes(parsed.category.toLowerCase())) {
      category = parsed.category.toLowerCase() as LLMExtractedListing['category'];
    }

    const bedrooms = typeof parsed.bedrooms === 'number' && parsed.bedrooms >= 0 ? parsed.bedrooms : null;
    const bathrooms = typeof parsed.bathrooms === 'number' && parsed.bathrooms >= 0 ? parsed.bathrooms : null;
    const min_lease = typeof parsed.min_lease === 'number' && parsed.min_lease > 0 ? parsed.min_lease : null;
    const has_pool = Boolean(parsed.has_pool);

    let location: string | null = null;
    if (
      typeof parsed.location === 'string' &&
      parsed.location.trim().length > 0 &&
      parsed.location.trim().toLowerCase() !== 'null'
    ) {
      const trimmed = parsed.location.trim();
      const matched = VALID_SANGKATS.find(
        (s) => s.toLowerCase() === trimmed.toLowerCase() || trimmed.toLowerCase().includes(s.toLowerCase()),
      );
      location = matched ?? trimmed;
    }

    const phone_numbers: string[] = [];
    if (Array.isArray(parsed.phone_numbers)) {
      parsed.phone_numbers.forEach((p) => {
        if (typeof p === 'string' || typeof p === 'number') {
          const cleaned = String(p).replace(/[^\d+]/g, '');
          if (cleaned.length >= 8 && !phone_numbers.includes(cleaned)) {
            phone_numbers.push(cleaned);
          }
        }
      });
    }

    const maps_url = typeof parsed.maps_url === 'string' && parsed.maps_url.startsWith('http') ? parsed.maps_url.trim() : null;
    const description_en = typeof parsed.description_en === 'string' ? parsed.description_en.trim() : '';

    return {
      is_real_estate,
      title,
      price,
      currency,
      category,
      bedrooms,
      bathrooms,
      min_lease,
      has_pool,
      location,
      phone_numbers,
      maps_url,
      description_en,
    };
  } catch {
    return null;
  }
}

export async function extractListingWithLLM(text: string): Promise<LLMExtractedListing | null> {
  const geminiKey = getGeminiKey();
  if (geminiKey) {
    try {
      if (!genAIInstance) {
        genAIInstance = new GoogleGenerativeAI(geminiKey);
      }
      const model = genAIInstance.getGenerativeModel({
        model: 'gemini-3.5-flash-lite',
        generationConfig: {
          responseMimeType: 'application/json',
        },
        systemInstruction: SYSTEM_INSTRUCTIONS,
      });

      const result = await model.generateContent(text);
      const raw = result.response.text();
      if (raw) {
        const sanitized = sanitizeLlmResult(raw);
        if (sanitized) return sanitized;
      }
    } catch (err: unknown) {
      console.warn(`[Extractor] Gemini extraction error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const openAiKey = getOpenAIKey();
  if (openAiKey) {
    try {
      if (!openAIInstance) {
        openAIInstance = new OpenAI({ apiKey: openAiKey });
      }
      const response = await openAIInstance.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTIONS },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const raw = response.choices[0]?.message?.content;
      if (raw) {
        const sanitized = sanitizeLlmResult(raw);
        if (sanitized) return sanitized;
      }
    } catch (err: unknown) {
      console.warn(`[Extractor] OpenAI extraction error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
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
  // Check for "$500 deposit" or "deposit: $500"
  const dollarMatch = /(?:deposit|security\s*deposit)\s*(?::|is|=|of)?\s*\$?\s*([\d,]+)/i.exec(text);
  if (dollarMatch?.[1]) {
    const num = parseFloat(normalizePriceString(dollarMatch[1]));
    if (!isNaN(num) && num > 0) {
      return usdToUsdCents(num);
    }
  }

  // Check for "1 month deposit" or "2 months deposit"
  const monthMatch = /(\d+)\s*(?:month|months|mo|mos)\s*(?:of\s*)?deposit/i.exec(text);
  if (monthMatch?.[1] && rentPriceCents) {
    const months = parseInt(monthMatch[1], 10);
    if (!isNaN(months) && months > 0 && months <= 12) {
      return rentPriceCents * months;
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

export function extractHasPool(text: string): boolean {
  return (
    /អាងហែលទឹក/.test(text) ||
    /\b(swimming pool|swimmingpool|private pool|rooftop pool|shared pool|pool access|with pool|has pool)\b/i.test(text)
  );
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
  { regex: /ស្លក្រាម/i, location: 'Slor Kram', city: 'siem_reap' },
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
 */
export function extractLocation(text: string): ExtractedLocation | null {
  // 1. Check direct Khmer Sangkat mentions
  for (const entry of KHMER_SANGKAT_MAP) {
    if (entry.regex.test(text)) {
      return { location: entry.location, city: entry.city };
    }
  }

  // 2. Check normalized English district names
  const normalized = normalizeLocationString(text);

  for (const { city, district } of ALL_DISTRICTS) {
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

  return null;
}

// ─── Type extraction ──────────────────────────────────────────────────────────

export function extractType(text: string): 'rent' | 'sale' | null {
  if (/\b(for sale|to sell|selling|buy now|purchase)\b/i.test(text)) return 'sale';
  if (/\b(for rent|to rent|rental|lease|let|available for)\b/i.test(text)) return 'rent';
  return null;
}
