import type { LLMExtractedListing } from './extractor';
import { geographyStatus, type ListingExtraction, type UtilityType } from './listing-extraction';

/** Legacy display fields cannot represent the full extraction. Keep the original facts alongside them. */
export type AdaptedListingExtraction = LLMExtractedListing & { canonical_facts: ListingExtraction };

function utilityLabel(type: UtilityType, rate: string | null, utility: 'electricity' | 'water'): string | null {
  if (type === 'included') return 'Included';
  if (type === 'not_included') return 'Not included';
  if (type === 'state_rate') return utility === 'electricity' ? 'EDC (State Rate)' : 'State Rate';
  if (type === 'fixed') return rate ? `Fixed Rate (${rate})` : 'Fixed Rate';
  return null;
}

/** Project canonical facts into current UI/database columns without inventing missing facts. */
export function toLegacyListingExtraction(facts: ListingExtraction): AdaptedListingExtraction {
  const outsideSiemReap = geographyStatus(facts.city) === 'out_of_area';
  const admission = outsideSiemReap ? false : facts.is_supported_listing;
  return {
    is_real_estate: admission,
    admission_reason: outsideSiemReap ? `Outside Siem Reap: ${facts.city}` : facts.rejection_reason,
    title_en: facts.title_en,
    description_en: facts.description_en,
    price: facts.currency ? facts.price : null,
    currency: facts.currency ?? 'USD', // required by legacy type; null currency remains in canonical_facts
    category: facts.category,
    property_type: facts.property_type,
    bedrooms: facts.bedrooms,
    bathrooms: facts.bathrooms,
    min_lease: facts.min_lease_months,
    deposit: facts.deposit_amount,
    deposit_amount: facts.deposit_amount,
    deposit_months: facts.deposit_months,
    has_pool: facts.has_pool,
    electricity: utilityLabel(facts.electricity_type, facts.electricity_rate, 'electricity'),
    water: utilityLabel(facts.water_type, facts.water_rate, 'water'),
    cleaning: facts.cleaning,
    restrictions: facts.restrictions,
    pet_friendly: facts.pet_friendly,
    landmarks: facts.landmarks,
    marketing_landmarks: facts.marketing_landmarks,
    location: facts.sangkat ?? facts.explicit_location,
    phone_numbers: facts.phone_numbers,
    maps_url: facts.maps_urls[0] ?? null,
    discovered_amenities: facts.discovered_amenities,
    canonical_facts: facts,
  };
}
