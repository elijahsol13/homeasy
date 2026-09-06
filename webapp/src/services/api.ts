import type { FilterMetadata, FilterState, MapMarkerDTO, PropertyDTO } from '../types';
import { getTelegramInitData } from './telegram';

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '/api/v1');

function getAuthHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const initData = getTelegramInitData();
  if (initData) {
    headers['Authorization'] = `tma ${initData}`;
  } else if (import.meta.env.DEV) {
    // In local dev without Telegram client, provide test user header
    headers['X-Dev-Telegram-Id'] = '999888777';
  }

  return headers;
}

export async function fetchProperties(
  filters: FilterState,
  page = 1,
  limit = 20,
): Promise<{ total: number; page: number; limit: number; totalPages: number; items: PropertyDTO[] }> {
  const params = new URLSearchParams();
  params.set('city', filters.city);
  params.set('page', page.toString());
  params.set('limit', limit.toString());
  params.set('sort', filters.sort);

  if (filters.locations.length > 0) {
    params.set('locations', filters.locations.join(','));
  }
  if (filters.category) {
    params.set('category', filters.category);
  }
  if (filters.type) {
    params.set('type', filters.type);
  }
  if (typeof filters.minPrice === 'number' && filters.minPrice > 0) {
    params.set('min_price', filters.minPrice.toString());
  }
  if (typeof filters.maxPrice === 'number' && filters.maxPrice > 0) {
    params.set('max_price', filters.maxPrice.toString());
  }
  if (filters.bedrooms && filters.bedrooms.length > 0) {
    params.set('bedrooms', filters.bedrooms.join(','));
  }
  if (filters.hasPool !== undefined) {
    params.set('has_pool', filters.hasPool ? 'true' : 'false');
  }
  if (filters.minLeaseMax) {
    params.set('min_lease_max', filters.minLeaseMax.toString());
  }
  if (filters.query && filters.query.trim().length > 0) {
    params.set('query', filters.query.trim());
  }

  const res = await fetch(`${API_BASE}/properties?${params.toString()}`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch properties: ${res.statusText}`);
  }

  return res.json();
}

export async function fetchPropertyById(id: number): Promise<PropertyDTO> {
  const res = await fetch(`${API_BASE}/properties/${id}`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Property #${id} not found`);
  }

  return res.json();
}

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  paddingRatio?: number;
}

export async function fetchMapMarkers(
  city: string,
  category?: string,
  type?: 'rent' | 'sale',
  bounds?: MapBounds,
): Promise<MapMarkerDTO[]> {
  const params = new URLSearchParams();
  params.set('city', city);
  if (category) params.set('category', category);
  if (type) params.set('type', type);
  if (bounds) {
    params.set('minLat', bounds.minLat.toString());
    params.set('maxLat', bounds.maxLat.toString());
    params.set('minLng', bounds.minLng.toString());
    params.set('maxLng', bounds.maxLng.toString());
    if (bounds.paddingRatio !== undefined) {
      params.set('paddingRatio', bounds.paddingRatio.toString());
    }
  }

  const res = await fetch(`${API_BASE}/properties/map?${params.toString()}`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to load map markers: ${res.statusText}`);
  }

  const data = await res.json();
  return data.markers || [];
}

export async function fetchFilterMetadata(city: string): Promise<FilterMetadata> {
  const res = await fetch(`${API_BASE}/filters/metadata?city=${city}`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to load filter metadata: ${res.statusText}`);
  }

  return res.json();
}

export async function fetchFavorites(): Promise<PropertyDTO[]> {
  const res = await fetch(`${API_BASE}/favorites`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  return data.items || [];
}

export async function toggleFavorite(propertyId: number): Promise<{ isFavorite: boolean }> {
  const res = await fetch(`${API_BASE}/favorites/toggle`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ propertyId }),
  });

  if (!res.ok) {
    throw new Error('Failed to toggle favorite');
  }

  return res.json();
}
