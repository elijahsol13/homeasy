export type CityKey = 'siem_reap' | 'phnom_penh';

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

export interface FilterMetadata {
  currentCity: CityKey;
  cities: Array<{ key: CityKey; name: string; currency: string }>;
  locations: Array<{ name: string; count: number }>;
  categories: Array<{ id: string; label: string; count: number }>;
  priceRange: { minUsd: number; maxUsd: number };
  bedroomOptions: Array<{ value: number; label: string }>;
}

export interface FilterState {
  city: CityKey;
  locations: string[];
  category?: string;
  type?: 'rent' | 'sale';
  minPrice?: number;
  maxPrice?: number;
  bedrooms?: number[];
  hasPool?: boolean;
  minLeaseMax?: number;
  query?: string;
  sort: 'newest' | 'price_asc' | 'price_desc';
}

export type ActiveTab = 'feed' | 'map' | 'saved';
