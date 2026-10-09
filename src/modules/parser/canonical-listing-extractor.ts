import { createAiRouter, validateCompleteBatchItems } from '../ai';
import { LISTING_EXTRACTION_PROMPT, sanitizeListingFacts, type ListingExtraction } from './listing-extraction';

const MAX_BATCH_ITEMS = 3; // Groq free-tier output limit is ~1,000 tokens/minute.
const router = createAiRouter();
const REQUIRED_FACT_KEYS = [
  'is_supported_listing', 'rejection_reason', 'title_en', 'description_en', 'price', 'currency',
  'category', 'property_type', 'bedrooms', 'bathrooms', 'city', 'sangkat', 'explicit_location',
  'landmarks', 'marketing_landmarks', 'min_lease_months', 'lease_term_text', 'deposit_amount',
  'deposit_months', 'has_pool', 'electricity_type', 'electricity_rate', 'water_type', 'water_rate',
  'cleaning', 'restrictions', 'pet_friendly', 'discovered_amenities',
] as const;

/** One contract for every source using the canonical listing prompt. */
export function validateCanonicalListingBatch(
  response: unknown,
  sourceTextById: ReadonlyMap<string, string>,
): true | string {
  const ids = [...sourceTextById.keys()];
  const contract = validateCompleteBatchItems(response, ids);
  if (contract !== true) return contract;
  const entries = (response as { items: Array<{ id: string; result?: unknown }> }).items;
  for (const entry of entries) {
    const raw = entry.result as Record<string, unknown> | null | undefined;
    if (!raw || typeof raw !== 'object' || typeof raw.is_supported_listing !== 'boolean' && raw.is_supported_listing !== null) {
      return `invalid admission decision for ${entry.id}`;
    }
    if (!REQUIRED_FACT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(raw, key))) {
      return `incomplete facts for ${entry.id}`;
    }
    if (raw.is_supported_listing === true && (!raw.title_en || typeof raw.title_en !== 'string')) {
      return `missing supported-listing title for ${entry.id}`;
    }
    if (raw.price !== null && (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price <= 0)) {
      return `invalid monthly price for ${entry.id}`;
    }
    if (raw.currency !== null && raw.currency !== 'USD' && raw.currency !== 'KHR') {
      return `invalid currency for ${entry.id}`;
    }
    if (!sanitizeListingFacts(raw, sourceTextById.get(entry.id)!)) return `invalid listing for ${entry.id}`;
  }
  return true;
}

export async function extractCanonicalListingsBatch(
  items: ReadonlyArray<{ id: string | number; text: string }>,
  sourceNotes?: string,
): Promise<Map<string | number, ListingExtraction>> {
  const results = new Map<string | number, ListingExtraction>();
  for (let offset = 0; offset < items.length; offset += MAX_BATCH_ITEMS) {
    const chunk = items.slice(offset, offset + MAX_BATCH_ITEMS);
    const ids = chunk.map((item) => String(item.id));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate input ids in canonical extraction batch');
    const byId = new Map(chunk.map((item) => [String(item.id), item]));
    const sourceTextById = new Map(chunk.map((item) => [String(item.id), item.text]));

    try {
      const { data } = await router.generateJson<{ items: Array<{ id: string; result?: unknown }> }>({
        systemPrompt: sourceNotes ? `${LISTING_EXTRACTION_PROMPT}\n\nSOURCE-SPECIFIC NOTES:\n${sourceNotes}` : LISTING_EXTRACTION_PROMPT,
        userPrompt: JSON.stringify(chunk.map((item) => ({ id: String(item.id), text: item.text }))),
        validate: (response) => validateCanonicalListingBatch(response, sourceTextById),
      });
      for (const entry of data.items) {
        const original = byId.get(entry.id)!;
        const facts = sanitizeListingFacts(entry.result, original.text);
        if (facts) results.set(original.id, facts);
      }
    } catch (error) {
      console.warn(`[CanonicalExtractor] Batch failed (${ids.join(', ')}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}
