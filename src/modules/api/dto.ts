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
import { findLandmarksInText, type LandmarkEntry } from '../../config/landmarks';
import { extractCoordinatesFromMapsUrl, getFallbackCoordinates } from '../../config/locations';
import { formatDomesticPhone, formatPhoneNumber, normalizePhoneNumber } from '../parser/normalizer';

export interface PropertyDTO {
  id: number;
  hash: string;
  title: string;
  description: string;
  priceUsd: number;
  currency: 'USD' | 'KHR';
  type: 'rent' | 'sale';
  category: string | null;
  propertyType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  depositUsd: number | null;
  minLeaseMonths: number | null;
  hasPool: boolean;
  location: string;
  city: string;
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
    landmarks: Array<{ id: string; name: string; link: string }>;
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
}

export interface MapMarkerDTO {
  id: number;
  title: string;
  priceUsd: number;
  category: string | null;
  propertyType: string;
  bedrooms: number | null;
  location: string;
  city: string;
  hasPool: boolean;
  thumbnail: string | null;
  coordinates: { lat: number; lng: number } | null;
  mapsUrl: string | null;
  isExact: boolean;
  count?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
}

/**
 * Transforms an internal database Property entity into a rich, frontend-friendly PropertyDTO.
 */
export function toPropertyDTO(property: Property, isFavorite?: boolean): PropertyDTO {
  const fullText = `${property.title}\n${property.description}`;
  const electricity = property.electricity ?? extractElectricity(fullText);
  const water = property.water ?? extractWater(fullText);
  const propertyType = extractPropertyType(fullText, property.category) ?? (property.category ?? 'Property');
  const cleaning = property.cleaning ?? extractCleaning(fullText);
  const restrictions = property.restrictions && property.restrictions.length > 0 ? property.restrictions : extractRestrictions(fullText);
  const landmarks = findLandmarksInText(fullText, property.city).map((l: LandmarkEntry) => ({
    id: l.id,
    name: l.canonicalName,
    link: l.gmapsLink,
  }));

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
    const formatted = formatDomesticPhone(property.direct_contact.phone) ?? property.direct_contact.phone;
    contact.phone = formatted;
    contact.phoneFormatted = formatted;
    const firstPhone = property.direct_contact.phone.split(/[/,|\n]+/)[0]?.trim();
    contact.phoneLink = `tel:${firstPhone ? firstPhone.replace(/\s+/g, '') : property.direct_contact.phone}`;
  }

  if (property.direct_contact.telegram) {
    const rawTg = property.direct_contact.telegram.trim();
    if (rawTg.startsWith('http')) {
      contact.telegram = rawTg.replace(/^https?:\/\/t\.me\//, '@');
      contact.telegramLink = rawTg;
    } else if (rawTg.startsWith('@')) {
      contact.telegram = rawTg;
      contact.telegramLink = `https://t.me/${rawTg.slice(1)}`;
    } else {
      const dom = formatDomesticPhone(rawTg) ?? rawTg;
      const digits = normalizePhoneNumber(rawTg);
      contact.telegram = dom;
      contact.telegramLink = digits ? `https://t.me/+${digits}` : `https://t.me/${rawTg}`;
    }
  } else if (property.direct_contact.phone) {
    const firstPhone = property.direct_contact.phone.split(/[/,|\n]+/)[0]?.trim() || '';
    const digits = normalizePhoneNumber(firstPhone);
    if (digits && digits.length >= 8) {
      contact.telegramLink = `https://t.me/+${digits}`;
    }
  }

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
    hash: property.hash,
    title: property.title || `${propertyType} in ${property.location || property.city}`,
    description: property.description,
    priceUsd: Math.round(property.price / 100),
    currency: property.currency,
    type: property.type,
    category: property.category,
    propertyType,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    depositUsd: property.deposit ? Math.round(property.deposit / 100) : null,
    minLeaseMonths: property.min_lease,
    hasPool: property.has_pool,
    location: property.location,
    city: property.city,
    mapsUrl: property.maps_url,
    coordinates: coords,
    photos: property.photos ?? [],
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
      landmarks,
    },
    contact,
    isFavorite,
  };
}

/**
 * Transforms a property to a lightweight map marker DTO.
 */
export function toMapMarkerDTO(property: Property): MapMarkerDTO {
  const fullText = `${property.title}\n${property.description}`;
  const propertyType = extractPropertyType(fullText, property.category) ?? (property.category ?? 'Property');
  
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
    title: property.title || `${propertyType} in ${property.location || property.city}`,
    priceUsd: Math.round(property.price / 100),
    category: property.category,
    propertyType,
    bedrooms: property.bedrooms,
    location: property.location,
    city: property.city,
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
    count: number;
    minPriceUsd: number;
    maxPriceUsd: number;
    lat: number;
    lng: number;
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
    city,
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
