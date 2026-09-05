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
  property_type?: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  min_lease: number | null; // in months
  has_pool: boolean;
  electricity?: string | null;
  water?: string | null;
  landmarks?: string[];
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
  '  "property_type": "Flat House" | "Private Villa" | "Private House" | "Condo" | "Apartment" | "Hotel Room" | "Room" | null,\n' +
  '  "bedrooms": number | null,\n' +
  '  "bathrooms": number | null,\n' +
  '  "min_lease": number | null,\n' +
  '  "has_pool": boolean,\n' +
  '  "electricity": "Included" | "EDC (State Rate) ~$0.20/kWh" | string | null,\n' +
  '  "water": "Included" | "State Rate (~1000៛/m³)" | string | null,\n' +
  '  "landmarks": string[],\n' +
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
  "- `electricity`: If free/included or all-inclusive, return 'Included'. If EDC or government/state rate or ភ្លើងរដ្ឋ, return 'EDC (State Rate) ~$0.20/kWh'. If a fixed rate is mentioned (e.g. $0.25/kWh, 0.25$, 1000r, 1200r), return formatted as 'Fixed Rate ($0.25/kWh)' or 'Fixed Rate (1000៛/kWh)'. Otherwise null.\n" +
  "- `water`: If free/included, return 'Included'. If state/gov water or ទឹកដ្ឋ or ~1000r/m3, return 'State Rate (~1000៛/m³)'. If fixed per person (e.g. $5/person), return 'Fixed ($5/person)'. Otherwise null.\n" +
  "- `property_type`: 'Flat House' (for flat house, shophouse, ផ្ទះល្វែង), 'Private Villa' (for villa, ផ្ទះវីឡា), 'Private House' (for house, detached house), 'Condo', 'Apartment', or 'Hotel Room'.\n" +
  "- `phone_numbers`: Extract ALL phone numbers found (WhatsApp, Telegram, local, international). Strip non-numeric characters except leading '+'. Example: ['+85577448002', '089899084'].\n" +
  "- `description_en`: DO NOT repeat the price, location, or title. Extract ONLY actual amenities (e.g. Fridge, Washing Machine, AC, Secure Parking, Balcony, WiFi) and lease conditions (e.g. Pet Friendly). Return strictly as 1-3 short bullet points.\n" +
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

    const price: number | null = typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : null;
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

    const electricity = typeof parsed.electricity === 'string' && parsed.electricity.trim().length > 0
      ? parsed.electricity.trim()
      : null;
    const water = typeof parsed.water === 'string' && parsed.water.trim().length > 0
      ? parsed.water.trim()
      : null;
    const property_type = typeof parsed.property_type === 'string' && parsed.property_type.trim().length > 0
      ? parsed.property_type.trim()
      : null;
    const landmarks = Array.isArray(parsed.landmarks)
      ? parsed.landmarks.filter((l): l is string => typeof l === 'string')
      : [];

    return {
      is_real_estate,
      title,
      price,
      currency,
      category,
      property_type,
      bedrooms,
      bathrooms,
      min_lease,
      has_pool,
      electricity,
      water,
      landmarks,
      location,
      phone_numbers,
      maps_url,
      description_en,
    };
  } catch {
    return null;
  }
}

// ─── Regex Heuristic Fallbacks for Utilities & Property Types ─────────────────

export function extractElectricity(text: string): string | null {
  // 1. Included / All inclusive
  if (/\b(?:free\s+electric(?:ity)?|electric(?:ity)?\s+free|utilities\s+included|all\s+inclusive|electricity\s*:\s*included)\b/i.test(text)) {
    return 'Included';
  }

  // 2. EDC / State rate
  if (
    /\b(?:edc|state\s+rate|gov(?:ernment)?\s+rate|state\s+electric(?:ity)?)\b/i.test(text) ||
    /ភ្លើងរដ្ឋ/.test(text)
  ) {
    return 'EDC (State Rate) ~$0.20/kWh';
  }

  // 3. Fixed dollar rate (e.g. $0.25/kWh, 0.25$, $0.30)
  const dollarMatch = /(?:electricity|electric|power|⚡)?\s*(?::\s*)?\$?(0\.\d{2})\s*\$?(?:\s*\/\s*kwh|\s*per\s*kwh|\s*\/unit)?\b/i.exec(text);
  if (dollarMatch && parseFloat(dollarMatch[1]) >= 0.15 && parseFloat(dollarMatch[1]) <= 0.60) {
    return `Fixed Rate ($${dollarMatch[1]}/kWh)`;
  }

  // 4. Fixed Riel rate (e.g. 1000r, 1000 riel, 1200r/kwh)
  const rielMatch = /(?:electricity|electric|power|⚡)?\s*(?::\s*)?([1-9]\d{2,3})\s*(?:r|riel|៛)(?:\s*\/\s*kwh|\s*per\s*kwh|\s*\/unit)?\b/i.exec(text);
  if (rielMatch && parseInt(rielMatch[1], 10) >= 500 && parseInt(rielMatch[1], 10) <= 3000) {
    return `Fixed Rate (${rielMatch[1]}៛/kWh)`;
  }

  return null;
}

export function extractWater(text: string): string | null {
  // 1. Included / Free
  if (
    /\b(?:free\s+water|water\s+free|water\s*(?::|\s+is)?\s*included|including\s+water|water\s*:\s*free)\b/i.test(text) ||
    /ទឹកឥតគិតថ្លៃ|ទឹកហ្វ្រី|រួមបញ្ចូលទឹក/.test(text)
  ) {
    return 'Included';
  }

  // 2. State rate
  if (
    /\b(?:state\s+water|gov(?:ernment)?\s+water|1000\s*(?:r|riel)\s*\/\s*m3)\b/i.test(text) ||
    /ទឹករដ្ឋ|ទឹកដ្ឋ/.test(text)
  ) {
    return 'State Rate (~1000៛/m³)';
  }

  // 3. Fixed per person / per month
  const fixedMatch = /(?:water|💧)?\s*(?::\s*)?\$?(\d+(?:\.\d+)?)\s*\$?\s*(?:\/\s*person|\/\s*pax|\/\s*people|\/\s*month|\/\s*mo)\b/i.exec(text);
  if (fixedMatch) {
    const val = fixedMatch[1];
    const unit = /month|mo/i.test(fixedMatch[0]) ? '/month' : '/person';
    return `Fixed ($${val}${unit})`;
  }

  return null;
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

  // 5. Condo
  if (/\b(?:condo|condominium)\b/i.test(text)) {
    return 'Condo';
  }

  // 6. Apartment
  if (category === 'apartment' || /\b(?:apartment|serviced\s+apartment|studio\s+apartment)\b/i.test(text)) {
    return 'Apartment';
  }

  return null;
}

// ─── Single Item LLM Extraction with Model Cascade ────────────────────────────

export async function extractListingWithLLM(text: string): Promise<LLMExtractedListing | null> {
  const geminiKey = getGeminiKey();
  if (geminiKey) {
    // Model hierarchy: gemini-2.5-flash -> gemini-2.5-flash-lite
    for (const modelName of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      try {
        if (!genAIInstance) {
          genAIInstance = new GoogleGenerativeAI(geminiKey);
        }
        const model = genAIInstance.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
          },
          systemInstruction: SYSTEM_INSTRUCTIONS,
        });

        const result = await model.generateContent(text);
        const raw = result.response.text();
        if (raw) {
          const sanitized = sanitizeLlmResult(raw);
          if (sanitized) {
            // Heuristic fill-ins if model omitted them
            if (!sanitized.electricity) sanitized.electricity = extractElectricity(text);
            if (!sanitized.water) sanitized.water = extractWater(text);
            if (!sanitized.property_type) sanitized.property_type = extractPropertyType(text, sanitized.category);
            return sanitized;
          }
        }
      } catch (err: unknown) {
        console.warn(`[Extractor] Gemini ${modelName} extraction error: ${err instanceof Error ? err.message : String(err)}`);
      }
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
        if (sanitized) {
          if (!sanitized.electricity) sanitized.electricity = extractElectricity(text);
          if (!sanitized.water) sanitized.water = extractWater(text);
          if (!sanitized.property_type) sanitized.property_type = extractPropertyType(text, sanitized.category);
          return sanitized;
        }
      }
    } catch (err: unknown) {
      console.warn(`[Extractor] OpenAI extraction error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
}

// ─── Batch LLM Extraction for Scrapers & Maintenance (Saves 80–90% Quotas) ─────

export async function extractListingsBatchWithLLM(
  items: Array<{ id: string | number; text: string }>,
): Promise<Map<string | number, LLMExtractedListing>> {
  const results = new Map<string | number, LLMExtractedListing>();
  if (items.length === 0) return results;

  const geminiKey = getGeminiKey();
  if (geminiKey && items.length > 1) {
    const batchPrompt = JSON.stringify(
      items.map((it) => ({ id: it.id, text: it.text })),
    );

    const batchSystemInstruction =
      SYSTEM_INSTRUCTIONS +
      '\n\nYou will receive a JSON array of items: `[{"id": ..., "text": "..."}]`.\n' +
      'Return a JSON array of objects: `[{"id": ..., "result": {<schema>}}]` where result matches the extraction schema.\n' +
      'Do not skip any items.';

    for (const modelName of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      try {
        if (!genAIInstance) {
          genAIInstance = new GoogleGenerativeAI(geminiKey);
        }
        const model = genAIInstance.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
          },
          systemInstruction: batchSystemInstruction,
        });

        const res = await model.generateContent(batchPrompt);
        const raw = res.response.text();
        if (raw) {
          const parsedArray = JSON.parse(
            raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim(),
          );
          if (Array.isArray(parsedArray)) {
            for (const entry of parsedArray) {
              if (entry.id !== undefined && entry.result) {
                const sanitized = sanitizeLlmResult(JSON.stringify(entry.result));
                if (sanitized) {
                  const original = items.find((it) => it.id === entry.id);
                  if (original) {
                    if (!sanitized.electricity) sanitized.electricity = extractElectricity(original.text);
                    if (!sanitized.water) sanitized.water = extractWater(original.text);
                    if (!sanitized.property_type) sanitized.property_type = extractPropertyType(original.text, sanitized.category);
                  }
                  results.set(entry.id, sanitized);
                }
              }
            }
            // If batch was successful, stop attempting other models
            if (results.size > 0) break;
          }
        }
      } catch (batchErr) {
        console.warn(`[Extractor] Batch ${modelName} error:`, batchErr instanceof Error ? batchErr.message : String(batchErr));
      }
    }
  }

  // Fail-Safe Fallback: process any items missing from the batch individually
  for (const item of items) {
    if (!results.has(item.id)) {
      const single = await extractListingWithLLM(item.text);
      if (single) {
        results.set(item.id, single);
      }
    }
  }

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
