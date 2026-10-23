import { createAiRouter, validateCompleteBatchItems } from '../ai';
import { z } from 'zod';
import {
  LISTING_CATEGORIES, LISTING_PROPERTY_TYPES, LISTING_EXTRACTION_PROMPT, LISTING_AMENITY_IDS,
  sanitizeListingFacts, type ListingExtraction,
} from './listing-extraction';

// The complete nullable facts contract plus edited copy typically needs hundreds
// of output tokens per item. Groq's configured 1,000-token response ceiling is
// too small for three complete objects; avoid turning truncation into silent loss.
const MAX_BATCH_ITEMS = 1;
const router = createAiRouter();
const nullableText = z.string().max(1200).nullable();
const textList = z.array(z.string().min(1).max(250)).max(25);
const nonnegativeInt = z.number().int().min(0).max(100).nullable();
const amenityIdSet = new Set(LISTING_AMENITY_IDS);

/** Required JSON keys, nullable when unknown. Fail closed on invalid typed facts. */
export const CANONICAL_FACTS_RESPONSE_SCHEMA = z.object({
  is_supported_listing: z.boolean().nullable(),
  rejection_reason: nullableText,
  title_en: z.string().max(180),
  description_en: z.string().max(3000),
  price: z.number().positive().finite().nullable(),
  currency: z.enum(['USD', 'KHR']).nullable(),
  category: z.enum(LISTING_CATEGORIES).nullable(),
  property_type: z.enum(LISTING_PROPERTY_TYPES).nullable(),
  bedrooms: nonnegativeInt,
  bathrooms: nonnegativeInt,
  city: nullableText,
  sangkat: nullableText,
  explicit_location: nullableText,
  landmarks: textList,
  marketing_landmarks: textList,
  min_lease_months: z.number().int().positive().max(240).nullable(),
  lease_term_text: nullableText,
  deposit_amount: z.number().positive().finite().nullable(),
  deposit_months: z.number().positive().finite().max(120).nullable(),
  has_pool: z.boolean().nullable(),
  electricity_type: z.enum(['included', 'state_rate', 'fixed', 'not_included']).nullable(),
  electricity_rate: nullableText,
  water_type: z.enum(['included', 'state_rate', 'fixed', 'not_included']).nullable(),
  water_rate: nullableText,
  cleaning: nullableText,
  restrictions: textList,
  pet_friendly: z.boolean().nullable(),
  discovered_amenities: textList.refine((list) => list.every((id) => amenityIdSet.has(id)), {
    message: 'amenities must use a canonical ID from the catalog',
  }),
}).strict();

/** One contract for every source using the canonical listing prompt. */
export function validateCanonicalListingBatch(
  response: unknown,
  sourceTextById: ReadonlyMap<string, string>,
  platformMetaById: ReadonlyMap<string, Record<string, string | number | boolean | null>> = new Map(),
): true | string {
  const ids = [...sourceTextById.keys()];
  const contract = validateCompleteBatchItems(response, ids);
  if (contract !== true) return contract;
  const entries = (response as { items: Array<{ id: string; result?: unknown }> }).items;
  for (const entry of entries) {
    const raw = entry.result as Record<string, unknown> | null | undefined;
    const validation = CANONICAL_FACTS_RESPONSE_SCHEMA.safeParse(raw);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      return `invalid typed facts for ${entry.id}: ${issue?.path.join('.') || 'result'} (${issue?.message ?? 'unknown error'})`;
    }
    const facts = validation.data;
    if (facts.is_supported_listing === true && !facts.title_en) {
      return `missing supported-listing title for ${entry.id}`;
    }
    if (facts.price !== null && (!Number.isFinite(facts.price) || facts.price <= 0)) {
      return `invalid monthly price for ${entry.id}`;
    }
    if (facts.currency !== null && facts.currency !== 'USD' && facts.currency !== 'KHR') {
      return `invalid currency for ${entry.id}`;
    }
    if (!sanitizeListingFacts(raw, sourceTextById.get(entry.id)!, platformMetaById.get(entry.id))) return `invalid listing for ${entry.id}`;
  }
  return true;
}

export async function extractCanonicalListingsBatch(
  items: ReadonlyArray<{
    id: string | number;
    text: string;
    platformMetadata?: Record<string, string | number | boolean | null>;
  }>,
  sourceNotes?: string,
): Promise<Map<string | number, ListingExtraction>> {
  const results = new Map<string | number, ListingExtraction>();
  for (let offset = 0; offset < items.length; offset += MAX_BATCH_ITEMS) {
    const chunk = items.slice(offset, offset + MAX_BATCH_ITEMS);
    const ids = chunk.map((item) => String(item.id));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate input ids in canonical extraction batch');
    const byId = new Map(chunk.map((item) => [String(item.id), item]));
    const sourceTextById = new Map(chunk.map((item) => [String(item.id), item.text]));
    const platformMetaById = new Map(chunk.filter((item) => item.platformMetadata)
      .map((item) => [String(item.id), item.platformMetadata!] as const));

    try {
      const { data } = await router.generateJson<{ items: Array<{ id: string; result?: unknown }> }>({
        systemPrompt: sourceNotes ? `${LISTING_EXTRACTION_PROMPT}\n\nSOURCE-SPECIFIC NOTES:\n${sourceNotes}` : LISTING_EXTRACTION_PROMPT,
        userPrompt: JSON.stringify(chunk.map((item) => ({
          id: String(item.id), text: item.text,
          ...(item.platformMetadata ? { platform_metadata: item.platformMetadata } : {}),
        }))),
        validate: (response) => validateCanonicalListingBatch(response, sourceTextById, platformMetaById),
      });
      for (const entry of data.items) {
        const original = byId.get(entry.id)!;
        const facts = sanitizeListingFacts(entry.result, original.text, original.platformMetadata);
        if (facts) results.set(original.id, facts);
      }
    } catch (error) {
      console.warn(`[CanonicalExtractor] Batch failed (${ids.join(', ')}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}
