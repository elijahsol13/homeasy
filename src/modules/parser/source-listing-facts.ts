/** A missing or malformed room count must not erase a previously observed count. */
export function validRoomCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Live adapters store listingExtraction; historic Khmer24 imports store listingFacts. */
export function sourceListingFacts(payload: Record<string, unknown>): Record<string, unknown> {
  const legacy = record(payload.listingFacts);
  const extracted = record(payload.listingExtraction);
  const facts = { ...legacy, ...extracted };
  for (const field of ['bedrooms', 'bathrooms'] as const) {
    const count = validRoomCount(extracted[field]) ?? validRoomCount(legacy[field]);
    if (count === null) delete facts[field];
    else facts[field] = count;
  }
  return facts;
}
