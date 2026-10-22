import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMapMarkers, fetchProperties, reviewProperty, trackMiniAppOpen, type TrackingAttribution } from './api';
import type { FilterState } from '../types';

const mockFetch = vi.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

describe('T24 map alias request encoding', () => {
  it('preserves commas inside aliases instead of splitting them as CSV', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ total: 0, items: [] }) } as Response);
    await fetchProperties({ city: 'siem_reap', type: 'rent', sort: 'newest', locations: ['Wat Bo', 'Sangkat Sla Kram, Siem Reap'], mapClusterKey: 'siem_reap:sla_kram' });
    const url = String(mockFetch.mock.calls[0][0]);
    const params = new URL(url, 'https://homeasy.example').searchParams;
    expect(JSON.parse(params.get('locations_json')!)).toEqual(['Wat Bo', 'Sangkat Sla Kram, Siem Reap']);
    expect(params.get('map_cluster_key')).toBe('siem_reap:sla_kram');
  });
});

describe('bedroom selection request encoding', () => {
  it('sends 2 BR plus 4+ BR as the existing numeric CSV API contract', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ total: 0, items: [] }) } as Response);
    await fetchProperties({ city: 'siem_reap', type: 'rent', locations: [], sort: 'newest', bedrooms: [2, 4] });
    const params = new URL(String(mockFetch.mock.calls[0][0]), 'https://homeasy.example').searchParams;
    expect(params.get('bedrooms')).toBe('2,4');
  });
});

describe('map and feed filter parity', () => {
  it('sends every active cohort filter on both endpoints with identical encoding and retains viewport bounds', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ total: 0, items: [], markers: [] }) } as Response);
    const filters: FilterState = {
      city: 'phnom_penh', locations: ['BKK1', 'Sangkat Boeung Keng Kang, Phnom Penh'],
      mapClusterKey: 'phnom_penh:bkk1', category: 'condo', type: 'sale',
      minPrice: 100, maxPrice: 900, bedrooms: [2, 4], bathrooms: [1, 2],
      hasPool: false, minLeaseMax: 6, query: ' pool ', sort: 'price_desc', reviewStatus: 'pending',
    };
    const bounds = { minLat: 11, maxLat: 12, minLng: 104, maxLng: 105, paddingRatio: 0.2 };
    await fetchProperties(filters, 2, 25);
    await fetchMapMarkers(filters, bounds);

    const feed = new URL(String(mockFetch.mock.calls[0][0])).searchParams;
    const map = new URL(String(mockFetch.mock.calls[1][0])).searchParams;
    for (const key of ['city', 'locations_json', 'map_cluster_key', 'category', 'type', 'min_price', 'max_price',
      'bedrooms', 'bathrooms', 'has_pool', 'min_lease_max', 'query', 'review_status']) {
      expect(map.get(key), key).toBe(feed.get(key));
      expect(map.has(key), key).toBe(true);
    }
    expect(map.get('query')).toBe('pool');
    expect(map.get('bedrooms')).toBe('2,4');
    expect(map.get('has_pool')).toBe('false');
    expect(map.get('sort')).toBeNull();
    expect(map.get('page')).toBeNull();
    expect(map.get('limit')).toBeNull();
    expect(feed.get('sort')).toBe('price_desc');
    expect(Object.fromEntries(['minLat', 'maxLat', 'minLng', 'maxLng', 'paddingRatio']
      .map((key) => [key, map.get(key)]))).toEqual({
      minLat: '11', maxLat: '12', minLng: '104', maxLng: '105', paddingRatio: '0.2',
    });
  });
});

describe('trackMiniAppOpen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to /links/:slug/opened and returns attribution', async () => {
    const attribution: TrackingAttribution = {
      source: 'facebook',
      campaign: 'demand-outreach',
      group_id: 'g1',
      post_id: 'p1',
      request_id: 'req_42',
      listing_id: null,
      listing_public_ref: null,
      agent_id: null,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, slug: 'Ab7K2', attribution, listingTarget: null }),
    } as Response);

    const result = await trackMiniAppOpen('Ab7K2');

    expect(result.slug).toBe('Ab7K2');
    expect(result.attribution).toEqual(attribution);
  });

  it('throws when response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Not Found',
    } as Response);

    await expect(trackMiniAppOpen('unknown')).rejects.toThrow('Failed to report tracked link open');
  });
});

describe('reviewProperty identities', () => {
  beforeEach(() => mockFetch.mockReset());

  it('sends a canonical public ref as the review path identity', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, property: null }) } as Response);
    await reviewProperty('lst_0123456789abcdef0123456789abcdef', 'approve');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/properties/lst_0123456789abcdef0123456789abcdef/review'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'approve' }) }));
  });

  it('retains numeric IDs for legacy moderation', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, property: null }) } as Response);
    await reviewProperty(42, 'reject');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/properties/42/review'), expect.anything());
  });
});
