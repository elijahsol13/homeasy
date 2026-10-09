import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackMiniAppOpen, type TrackingAttribution } from './api';

const mockFetch = vi.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

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
      agent_id: null,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, slug: 'Ab7K2', attribution }),
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
