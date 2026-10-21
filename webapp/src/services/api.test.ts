import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchProperties, reviewProperty, trackMiniAppOpen, type TrackingAttribution } from './api';

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
