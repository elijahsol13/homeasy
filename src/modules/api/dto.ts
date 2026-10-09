import type { Property } from '../../database/repositories/properties.repo';
import {
  extractElectricity,
  extractWater,
  extractPropertyType,
} from '../parser/extractor';
import {
  extractCleaning,
  extractRestrictions,
} from '../../services/notifier';
import { findLandmarksInText, getLandmarkByCanonicalName, type LandmarkEntry } from '../../config/landmarks';
import { extractCoordinatesFromMapsUrl } from '../../config/locations';
import { formatDomesticPhone, normalizePhoneNumber, normalizePhoneToE164 } from '../parser/normalizer';
import { getPhoneActionLink, getTelegramContactLink } from './contact-links';

const AMENITY_LABELS: Record<string, string> = {
  parking: 'Parking',
  'parking space': 'Parking',
  'parking spaces': 'Parking',
  'parking spot': 'Parking',
  'parking lot': 'Parking',
  'parking area': 'Parking',
  'private parking': 'Parking',
  'private parking space': 'Parking',
  'big parking space': 'Parking',
  'covered parking': 'Parking',
  'undercover parking': 'Parking',
  'secure parking': 'Parking',
  'gated parking': 'Parking',
  'spacious parking': 'Parking',
  'spacious parking lot': 'Parking',
  'parking for car and moto': 'Parking',
  'parking for cars and moto': 'Parking',
  'parking for cars and motorbikes': 'Parking',
  'free motorcycles parking': 'Parking',
  'motor parking': 'Parking',
  'motorbike parking': 'Parking',
  'motorcycle parking': 'Parking',
  'car parking': 'Parking',
  'car park': 'Parking',
  carport: 'Parking',
  pool: 'Swimming Pool',
  'swimming pool': 'Swimming Pool',
  'private swimming pool': 'Swimming Pool',
  'shared swimming pool': 'Swimming Pool',
  gym: 'Gym',
  gymnasium: 'Gym',
  wifi: 'WiFi',
  'wi fi': 'WiFi',
  'wireless internet': 'WiFi',
  'free wifi': 'WiFi',
  'free wi fi': 'WiFi',
  'free internet': 'WiFi',
  'high speed wifi': 'WiFi',
  'high speed internet': 'WiFi',
  'internet wifi': 'WiFi',
  fridge: 'Fridge',
  refrigerator: 'Fridge',
  ac: 'Air Conditioning',
  'a c': 'Air Conditioning',
  aircon: 'Air Conditioning',
  'air con': 'Air Conditioning',
  'air conditioner': 'Air Conditioning',
  'air conditioners': 'Air Conditioning',
  'air conditioning': 'Air Conditioning',
  'air conditioning unit': 'Air Conditioning',
  'air conditioning units': 'Air Conditioning',
  balconies: 'Balcony',
  'private balcony': 'Private Balcony',
  'private balconies': 'Private Balcony',
  gardens: 'Garden',
  mattresses: 'Mattress',
  wardrobes: 'Wardrobe',
  televisions: 'TV',
  television: 'TV',
  tvs: 'TV',
  'water heaters': 'Water Heater',
  'hot cold water heater': 'Water Heater',
  'backup generator': 'Backup Generator',
  'back up generator': 'Backup Generator',
};

const AMENITY_ACRONYMS: Record<string, string> = {
  cctv: 'CCTV',
  led: 'LED',
  tv: 'TV',
  wifi: 'WiFi',
};

function amenityKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titleCaseAmenity(value: string): string {
  const cleaned = value.trim().replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ');
  return cleaned.replace(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu, (word) => {
    const lower = word.toLocaleLowerCase();
    if (AMENITY_ACRONYMS[lower]) return AMENITY_ACRONYMS[lower]!;
    return lower.replace(/^\p{L}/u, (first) => first.toLocaleUpperCase());
  });
}

function normalizeAmenityTags(amenities: string[], hasPool: boolean): string[] {
  const normalized = new Map<string, string>();
  for (const raw of amenities) {
    const key = amenityKey(raw);
    if (!key) continue;
    const label = AMENITY_LABELS[key] ?? titleCaseAmenity(raw);
    const labelKey = amenityKey(label);
    if (hasPool && label === 'Swimming Pool') continue;
    if (!normalized.has(labelKey)) normalized.set(labelKey, label);
  }
  return [...normalized.values()];
}

export interface PropertyDTO {
  id: number;
  title: string;
  description: string;
  priceUsd: number;
  currency: 'USD' | 'KHR';
  type: 'rent' | 'sale';
  matchTier?: 'EXACT' | 'PROBABLE' | 'UNKNOWN';
  cityTier?: 'EXACT_CITY' | 'PROBABLE_CITY' | 'UNKNOWN_CITY';
  cityEvidence?: 'LOCAL_EVIDENCE' | 'SOURCE_PRIOR_ONLY';
  publicRef?: string;
  category: string | null;
  propertyType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  depositUsd: number | null;
  minLeaseMonths: number | null;
  hasPool: boolean | null;
  location: string;
  locationKey: string | null;
  city: string;
  coordinatePrecision: 'exact' | 'district' | 'city';
  mapsUrl: string | null;
  coordinates: { lat: number; lng: number } | null;
  photos: string[];
  thumbnail: string | null;
  sourceUrl: string | null;
  originalUrl: string;
  postedAt: string | null;
  createdAt: string;
  specs: {
    electricity: string | null;
    water: string | null;
    cleaning: string | null;
    restrictions: string[];
    amenities: string[];
    landmarks: Array<{ id: string; name: string; link: string }>;
    /** Promotional "5 min to X" claims — shown as advertised references, not facts. */
    marketingLandmarks: Array<{ id: string; name: string; link: string }>;
  };
  contact: {
    phone?: string;
    phoneFormatted?: string;
    phoneLink?: string;
    telegram?: string;
    telegramLink?: string;
    whatsapp?: string;
    whatsappLink?: string;
  };
  isFavorite?: boolean;
  /** Admin/debug fields */
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  reviewReason?: string | null;
  parseWarnings?: string[];
}

export interface MapMarkerDTO {
  id: number;
  publicRef?: string;
  title: string;
  priceUsd: number;
  category: string | null;
  propertyType: string;
  bedrooms: number | null;
  location: string;
  locationKey: string | null;
  city: string;
  coordinatePrecision: 'exact' | 'district' | 'city';
  locationAliases?: string[];
  hasPool: boolean | null;
  thumbnail: string | null;
  coordinates: { lat: number; lng: number } | null;
  mapsUrl: string | null;
  isExact: boolean;
  count?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
}

/**
 * Maps a stored canonical landmark name to a DTO entry. Names missing from the
 * catalog still get a generic Google Maps search link scoped to the city.
 */
function landmarkNameToDTO(
  name: string,
  city: string,
): { id: string; name: string; link: string } {
  const entry = getLandmarkByCanonicalName(name);
  if (entry) {
    return { id: entry.id, name: entry.canonicalName, link: entry.gmapsLink };
  }
  const cityLabel = city === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap';
  return {
    id: `custom:${name}`,
    name,
    link: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${cityLabel}, Cambodia`)}`,
  };
}

/**
 * Transforms an internal database Property entity into a rich, frontend-friendly PropertyDTO.
 */
export function toPropertyDTO(property: Property, isFavorite?: boolean): PropertyDTO {
  const fullText = `${property.title}\n${property.description}`;
  const electricity = property.electricity ?? extractElectricity(fullText);
  const water = property.water ?? extractWater(fullText);
  const propertyType =
    (property.property_type && property.property_type.trim().length > 0 ? property.property_type.trim() : null) ??
    extractPropertyType(fullText, property.category) ??
    (property.category ?? 'Property');
  const cleaning = property.cleaning ?? extractCleaning(fullText);
  const restrictions = property.restrictions && property.restrictions.length > 0 ? property.restrictions : extractRestrictions(fullText);

  // Prefer stored (AI-normalized) landmark data; fall back to text scanning
  // for legacy rows that predate the landmarks column.
  const storedLandmarks = property.landmarks ?? [];
  const landmarks =
    storedLandmarks.length > 0
      ? storedLandmarks.map((n) => landmarkNameToDTO(n, property.city))
      : findLandmarksInText(fullText, property.city).map((l: LandmarkEntry) => ({
          id: l.id,
          name: l.canonicalName,
          link: l.gmapsLink,
        }));
  const marketingLandmarks = (property.marketing_landmarks ?? []).map((n) =>
    landmarkNameToDTO(n, property.city),
  );

  let coords: { lat: number; lng: number } | null = null;
  if (property.latitude !== null && property.latitude !== undefined && property.longitude !== null && property.longitude !== undefined) {
    coords = { lat: Number(property.latitude), lng: Number(property.longitude) };
  } else if (property.maps_url) {
    const rawCoords = extractCoordinatesFromMapsUrl(property.maps_url);
    if (rawCoords) {
      coords = { lat: rawCoords.latitude, lng: rawCoords.longitude };
    }
  }

  // Build clean contact links
  const contact: PropertyDTO['contact'] = {};
  if (property.direct_contact.phone) {
    const phoneParts = property.direct_contact.phone.split(/[/,|\n]+/).map((part) => part.trim()).filter(Boolean);
    const allCambodian = phoneParts.length > 0 && phoneParts.every((part) => normalizePhoneToE164(part)?.startsWith('+855'));
    const formatted = allCambodian
      ? formatDomesticPhone(property.direct_contact.phone) ?? property.direct_contact.phone
      : property.direct_contact.phone;
    contact.phone = formatted;
    contact.phoneFormatted = formatted;
    contact.phoneLink = getPhoneActionLink(property.direct_contact.phone) ?? undefined;
  }

  if (property.direct_contact.telegram) {
    const rawTg = property.direct_contact.telegram.trim();
    if (/^https?:\/\//i.test(rawTg)) {
      try {
        const parsed = new URL(rawTg);
        const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
        contact.telegram = path.startsWith('+') ? path : `@${path}`;
      } catch {
        contact.telegram = rawTg;
      }
    } else if (rawTg.startsWith('@')) {
      contact.telegram = rawTg;
    } else {
      const e164 = normalizePhoneToE164(rawTg);
      contact.telegram = e164?.startsWith('+855') ? formatDomesticPhone(rawTg) ?? rawTg : rawTg;
    }
  }

  contact.telegramLink = getTelegramContactLink(
    property.direct_contact.telegram,
    property.direct_contact.phone,
  ) ?? undefined;

  if (property.direct_contact.whatsapp) {
    const rawWa = property.direct_contact.whatsapp.trim();
    const dom = formatDomesticPhone(rawWa) ?? rawWa;
    const digits = normalizePhoneNumber(rawWa);
    contact.whatsapp = dom;
    if (digits) {
      contact.whatsappLink = `https://wa.me/${digits}`;
    }
  }

  return {
    id: property.id,
    ...(property.public_listing_ref ? { publicRef: property.public_listing_ref } : {}),
    title: property.title || `${propertyType} in ${property.location || property.city}`,
    description: property.description,
    priceUsd: Math.round(property.price / 100),
    currency: property.currency,
    type: property.type,
    ...(property.match_tier ? { matchTier: property.match_tier } : {}),
    ...(property.city_tier ? { cityTier: property.city_tier } : {}),
    ...(property.city_evidence ? { cityEvidence: property.city_evidence } : {}),
    category: property.category,
    propertyType,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    depositUsd: property.deposit ? Math.round(property.deposit / 100) : null,
    minLeaseMonths: property.min_lease,
    hasPool: property.has_pool,
    location: property.location,
    locationKey: property.location_key ?? null,
    city: property.city,
    coordinatePrecision: property.coordinate_precision ?? (coords ? 'exact' : property.location_key ? 'district' : 'city'),
    mapsUrl: property.maps_url,
    coordinates: coords,
    photos: (property.photos ?? []).slice(0, 8),
    thumbnail: property.photos && property.photos.length > 0 ? property.photos[0] : null,
    sourceUrl: property.source_url,
    originalUrl: (property.original_url || '').replace('web.facebook.com', 'www.facebook.com'),
    postedAt: property.posted_at,
    createdAt: property.created_at,
    specs: {
      electricity,
      water,
      cleaning,
      restrictions,
      amenities: normalizeAmenityTags(property.amenities ?? [], property.has_pool === true),
      landmarks,
      marketingLandmarks,
    },
    contact,
    isFavorite,
    reviewStatus: property.review_status,
    reviewReason: property.review_reason,
    parseWarnings: property.parse_warnings ?? [],
  };
}

/**
 * Transforms a property to a lightweight map marker DTO.
 */
export function toMapMarkerDTO(property: Property): MapMarkerDTO {
  const fullText = `${property.title}\n${property.description}`;
  const propertyType =
    (property.property_type && property.property_type.trim().length > 0 ? property.property_type.trim() : null) ??
    extractPropertyType(fullText, property.category) ??
    (property.category ?? 'Property');
  
  let coords: { lat: number; lng: number } | null = null;
  if (property.latitude !== null && property.latitude !== undefined && property.longitude !== null && property.longitude !== undefined) {
    coords = { lat: Number(property.latitude), lng: Number(property.longitude) };
  } else if (property.maps_url) {
    const rawCoords = extractCoordinatesFromMapsUrl(property.maps_url);
    if (rawCoords) {
      coords = { lat: rawCoords.latitude, lng: rawCoords.longitude };
    }
  }

  return {
    id: property.id,
    ...(property.public_listing_ref ? { publicRef: property.public_listing_ref } : {}),
    title: property.title || `${propertyType} in ${property.location || property.city}`,
    priceUsd: Math.round(property.price / 100),
    category: property.category,
    propertyType,
    bedrooms: property.bedrooms,
    location: property.location,
    locationKey: property.location_key ?? null,
    city: property.city,
    coordinatePrecision: 'exact',
    hasPool: property.has_pool,
    thumbnail: property.photos && property.photos.length > 0 ? property.photos[0] : null,
    coordinates: coords,
    mapsUrl: property.maps_url,
    isExact: coords !== null,
  };
}

/**
 * Transforms an aggregated Sangkat cluster into a MapMarkerDTO with count and price range.
 */
export function toSangkatClusterDTO(
  cluster: {
    location: string;
    locationKey: string | null;
    count: number;
    minPriceUsd: number;
    maxPriceUsd: number;
    lat: number;
    lng: number;
    coordinatePrecision?: 'district' | 'city';
    locationAliases?: string[];
  },
  city: string,
  index: number,
): MapMarkerDTO {
  return {
    id: -(index + 1),
    title: cluster.location,
    priceUsd: cluster.minPriceUsd,
    category: null,
    propertyType: 'Neighborhood Cluster',
    bedrooms: null,
    location: cluster.location,
    locationKey: cluster.locationKey,
    city,
    coordinatePrecision: cluster.coordinatePrecision ?? 'district',
    ...(cluster.locationAliases?.length ? { locationAliases: cluster.locationAliases } : {}),
    hasPool: false,
    thumbnail: null,
    coordinates: { lat: cluster.lat, lng: cluster.lng },
    mapsUrl: null,
    isExact: false,
    count: cluster.count,
    minPriceUsd: cluster.minPriceUsd,
    maxPriceUsd: cluster.maxPriceUsd,
  };
}
