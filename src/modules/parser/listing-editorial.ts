import { sourceRoomCounts } from './source-room-counts';

/**
 * Minimal copy for a failed/empty AI editorial pass. The original post is kept
 * in raw_text; only counts independently verified against the author text may
 * be repeated here. Other terms remain in structured details pending review.
 */
export function factualListingFallback(input: {
  sourceText: string;
  propertyType?: string | null;
  category?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
}): string {
  const type = input.propertyType && /^(?:Condo|Apartment|Studio|Room|Private Villa|Private House|Flat House|Hotel Room)$/i.test(input.propertyType)
    ? input.propertyType
    : input.category === 'apartment' ? 'Apartment'
      : input.category === 'house' ? 'House'
        : input.category === 'room' ? 'Room'
          : input.category === 'hotel' ? 'Hotel room' : 'Property';
  const rooms = sourceRoomCounts(input.sourceText);
  const parts: string[] = [];
  if (!rooms.conflictingBedrooms && rooms.bedrooms !== null && rooms.bedrooms === input.bedrooms && rooms.bedrooms > 0) {
    parts.push(`${rooms.bedrooms} bedroom${rooms.bedrooms === 1 ? '' : 's'}`);
  }
  if (!rooms.conflictingBathrooms && rooms.bathrooms !== null && rooms.bathrooms === input.bathrooms && rooms.bathrooms > 0) {
    parts.push(`${rooms.bathrooms} bathroom${rooms.bathrooms === 1 ? '' : 's'}`);
  }
  return `${type} for rent${parts.length ? ` with ${parts.join(' and ')}` : ''}.`;
}
