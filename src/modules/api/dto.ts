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
import { extractCoordinatesFromMapsUrl } from '../../config/locations';
import { formatPhoneNumber } from '../parser/normalizer';

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

  const rawCoords = property.maps_url ? extractCoordinatesFromMapsUrl(property.maps_url) : null;
  const coords = rawCoords ? { lat: rawCoords.latitude, lng: rawCoords.longitude } : null;

  // Build clean contact links
  const contact: PropertyDTO['contact'] = {};
  if (property.direct_contact.phone) {
    contact.phone = property.direct_contact.phone;
    contact.phoneFormatted = formatPhoneNumber(property.direct_contact.phone) ?? property.direct_contact.phone;
    contact.phoneLink = `tel:${property.direct_contact.phone}`;
  }

  if (property.direct_contact.telegram) {
    const handle = property.direct_contact.telegram.replace(/^@/, '');
    contact.telegram = `@${handle}`;
    contact.telegramLink = `https://t.me/${handle}`;
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
    originalUrl: property.original_url,
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
  const rawCoords = property.maps_url ? extractCoordinatesFromMapsUrl(property.maps_url) : null;
  const coords = rawCoords ? { lat: rawCoords.latitude, lng: rawCoords.longitude } : null;

  return {
    id: property.id,
    title: property.title || `${propertyType} in ${property.location}`,
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
  };
}
