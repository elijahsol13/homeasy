/**
 * Shared contract for LLM batch responses.
 *
 * LLMs are allowed to reorder outputs, but they must return one and only one
 * item for every requested id. Keeping this check outside individual prompts
 * makes an incomplete response a provider fallback instead of silent data loss.
 */
export interface BatchResponseItem {
  id: unknown;
}

export interface BatchResponse {
  items: BatchResponseItem[];
}

/**
 * Validates the transport-level batch contract only. Callers still validate
 * their domain payload (classification or extraction result) separately.
 */
export function validateCompleteBatchItems(data: unknown, expectedIds: readonly string[]): true | string {
  if (!data || typeof data !== 'object' || !Array.isArray((data as Partial<BatchResponse>).items)) {
    return 'items is not an array';
  }

  const requested = new Set(expectedIds);
  if (requested.size !== expectedIds.length) return 'internal error: duplicate input ids';

  const outputIds: string[] = [];
  for (const item of (data as BatchResponse).items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) {
      return 'every output item needs a non-empty string id';
    }
    outputIds.push(item.id);
  }

  if (outputIds.length !== expectedIds.length) {
    return `wrong item count: got ${outputIds.length}, expected ${expectedIds.length}`;
  }

  const output = new Set(outputIds);
  if (output.size !== outputIds.length) return 'duplicate output ids';

  const unknown = outputIds.filter((id) => !requested.has(id));
  if (unknown.length > 0) return `unknown output ids: ${unknown.join(', ')}`;

  const missing = expectedIds.filter((id) => !output.has(id));
  if (missing.length > 0) return `missing output ids: ${missing.join(', ')}`;

  return true;
}
