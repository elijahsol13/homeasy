export type CityKey = 'siem_reap' | 'phnom_penh';

export interface PropertyDTO {
  id: number;
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
    /** Promotional "5 min to X" claims from the ad — not verified facts. */
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
  /** Admin review fields — populated for admins viewing review queue. */
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  reviewReason?: string | null;
  parseWarnings?: string[];
}

export interface MapFocusRequest {
  propertyId: number;
  city: CityKey;
  locationKey: string | null;
  location: string;
  coordinates: { lat: number; lng: number } | null;
  coordinatePrecision: 'exact' | 'district' | 'city';
}

export interface MapMarkerDTO {
  id: number;
  title: string;
  priceUsd: number;
  category: string | null;
  propertyType: string;
  bedrooms: number | null;
  location: string;
  locationKey: string | null;
  city: string;
  coordinatePrecision: 'exact' | 'district' | 'city';
  hasPool: boolean | null;
  thumbnail: string | null;
  coordinates: { lat: number; lng: number } | null;
  mapsUrl: string | null;
  isExact?: boolean;
  count?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
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
  bathrooms?: number[];
  hasPool?: boolean;
  minLeaseMax?: number;
  query?: string;
  sort: 'newest' | 'price_asc' | 'price_desc';
  /** Admin-only review filter. Ignored by the API for non-admin users. */
  reviewStatus?: 'pending' | 'approved' | 'rejected' | 'all';
}

export type ActiveTab = 'feed' | 'map' | 'saved';

