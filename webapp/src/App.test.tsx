import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterState, PropertyDTO } from './types';

const api = vi.hoisted(() => ({
  fetchProperties: vi.fn(),
  fetchFilterMetadata: vi.fn(),
  fetchFavorites: vi.fn(),
  fetchMe: vi.fn(),
  reviewProperty: vi.fn(),
  toggleFavorite: vi.fn(),
  trackMiniAppOpen: vi.fn(),
  fetchPropertyById: vi.fn(),
}));

vi.mock('./services/api', () => api);
const telegram = vi.hoisted(() => ({ getTelegramStartParam: vi.fn<() => string | null>(() => null) }));
vi.mock('./services/telegram', () => ({
  getTelegramStartParam: telegram.getTelegramStartParam,
  initTelegramWebApp: vi.fn(),
  triggerHaptic: vi.fn(),
}));
vi.mock('./components/Header', () => ({
  Header: ({ onOpenFilterDrawer }: { onOpenFilterDrawer: () => void }) => (
    <button type="button" onClick={onOpenFilterDrawer}>Open filters</button>
  ),
}));
vi.mock('./components/PropertyCard', () => ({
  PropertyCard: ({ property, onSelect }: { property: PropertyDTO; onSelect: (property: PropertyDTO) => void }) => (
    <div><span data-testid="property">{property.id}</span><button type="button" onClick={() => onSelect(property)}>View {property.id}</button></div>
  ),
}));
vi.mock('./components/PropertyDetailModal', () => ({
  PropertyDetailModal: ({ property, onReview }: {
    property: PropertyDTO | null;
    onReview: (listing: PropertyDTO, action: 'approve' | 'reject') => void;
  }) => property ? (
    <>
      <div data-testid="detail-modal" data-photos={property.photos?.length ?? 0}>{property.title}</div>
      <button type="button" onClick={() => onReview(property, 'approve')}>Approve listing</button>
    </>
  ) : null,
}));
vi.mock('./components/MapView', () => ({
  MapView: ({ filters, onSelectLocation }: { filters: FilterState; onSelectLocation: (names: string[], key: string) => void }) => (
    <button data-testid="map-view" data-filters={JSON.stringify(filters)} onClick={() => onSelectLocation(['Sla Kram', 'Wat Bo', 'Sangkat Sla Kram, Siem Reap'], 'siem_reap:sla_kram')}>
      View as list
    </button>
  ),
}));
vi.mock('./components/BottomNav', () => ({
  BottomNav: ({ onTabChange }: { onTabChange: (tab: 'feed' | 'map' | 'saved') => void }) => (
    <button type="button" onClick={() => onTabChange('map')}>Open map tab</button>
  ),
}));

import { App } from './App';

type PropertiesResponse = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  items: PropertyDTO[];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function property(id: number): PropertyDTO {
  return { id, title: `Listing ${id}` } as PropertyDTO;
}

describe('feed sorting and pagination', () => {
  let root: Root;
  let host: HTMLDivElement;
  let requests: Array<{
    filters: FilterState;
    page: number;
    resolve: (result: PropertiesResponse) => void;
    reject: (reason?: unknown) => void;
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    telegram.getTelegramStartParam.mockReturnValue(null);
    requests = [];
    api.fetchProperties.mockImplementation((filters: FilterState, page = 1) => {
      const result = deferred<PropertiesResponse>();
      requests.push({ filters, page, resolve: result.resolve, reject: result.reject });
      return result.promise;
    });
    api.fetchFilterMetadata.mockResolvedValue({
      currentCity: 'siem_reap', cities: [], locations: [], categories: [],
      priceRange: { minUsd: 0, maxUsd: 0 }, bedroomOptions: [],
    });
    api.fetchFavorites.mockResolvedValue([]);
    api.fetchMe.mockResolvedValue({ isAdmin: false });
    localStorage.setItem('homeasy_filters', JSON.stringify({
      city: 'siem_reap', locations: ['Wat Bo'], maxPrice: 800, sort: 'newest',
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function renderWithSavedFilters(saved: string | null, delay = 10) {
    if (saved === null) localStorage.removeItem('homeasy_filters');
    else localStorage.setItem('homeasy_filters', saved);
    await act(async () => { root.render(<App />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)); });
  }

  function button(label: string) {
    const match = [...host.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match as HTMLButtonElement;
  }

  function drawerButton(label: string) {
    const match = [...host.querySelectorAll('.fixed.inset-0 button')]
      .find((item) => item.textContent?.trim() === label);
    if (!match) throw new Error(`Missing drawer button: ${label}`);
    return match as HTMLButtonElement;
  }

  it.each([null, '', '{bad-json', 'null', '[]'])('starts with safe defaults for absent or unusable storage: %s', async (saved) => {
    await renderWithSavedFilters(saved);
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({
      city: 'siem_reap', locations: [], type: 'rent', sort: 'newest',
    });
    await act(async () => { button('Open filters').click(); });
    expect(button('Newest').getAttribute('aria-pressed')).toBe('true');
    expect(button('Price: Low').className).not.toContain('bg-sky-500');
  });

  it('restores all supported valid fields including 4+ BR and sort without another feed request', async () => {
    const saved = {
      city: 'phnom_penh', locations: ['BKK1'], mapClusterKey: 'phnom_penh:bkk1',
      category: 'condo', type: 'sale', minPrice: 150, maxPrice: 800,
      bedrooms: [2, 4], bathrooms: [1, 2], hasPool: false, minLeaseMax: 6,
      query: 'pool', sort: 'price_desc', reviewStatus: 'pending',
    };
    await renderWithSavedFilters(JSON.stringify(saved), 330);
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual(saved);
    expect(button('Most expensive').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { button('Open filters').click(); });
    expect(button('4+ BR').className).toContain('bg-sky-500');
    expect(button('Price: High').className).toContain('bg-sky-500');
  });

  it('preserves valid empty selections, zero price and a false boolean', async () => {
    const saved = { locations: [], bedrooms: [], bathrooms: [], minPrice: 0, hasPool: false, sort: 'newest' };
    await renderWithSavedFilters(JSON.stringify(saved));
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({ city: 'siem_reap', type: 'rent', ...saved });
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!)).toEqual(requests[0].filters);
  });

  it('normalizes invalid field types and discards unknown keys before API use and persistence', async () => {
    await renderWithSavedFilters(JSON.stringify({
      city: ['siem_reap'], locations: null, type: 3, sort: { order: 'desc' },
      minPrice: '500', maxPrice: -5, bedrooms: '4', bathrooms: [null, '2'],
      hasPool: 'false', minLeaseMax: -2, query: [], category: {},
      reviewStatus: 'admin', mapClusterKey: 42, unknown: 'never persist',
    }));
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({
      city: 'siem_reap', locations: [], type: 'rent', sort: 'newest',
    });
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!)).toEqual(requests[0].filters);
    await act(async () => { button('Open filters').click(); });
    expect(button('4+ BR').className).not.toContain('bg-sky-500');
  });

  it('drops a persisted map cluster key rejected by the API while preserving other filters', async () => {
    await renderWithSavedFilters(JSON.stringify({
      locations: ['Wat Bo'], bedrooms: [4], sort: 'price_asc',
      mapClusterKey: 'siem_reap:bad/key',
    }));
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({
      city: 'siem_reap', locations: ['Wat Bo'], type: 'rent',
      bedrooms: [4], sort: 'price_asc',
    });
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!)).toEqual(requests[0].filters);
  });

  it('keeps valid fields when neighbours and entries within location/number arrays are damaged', async () => {
    await renderWithSavedFilters(JSON.stringify({
      locations: ['Wat Bo', 1, null, '', 'Sla Kram'], bedrooms: [4, '2', -1, 2, 4],
      bathrooms: [1, Infinity, false, 3.5, 2], maxPrice: 'bad',
      minPrice: 300, sort: 'price_asc', hasPool: true, query: 'villa',
    }), 330);
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({
      city: 'siem_reap', type: 'rent', locations: ['Wat Bo', 'Sla Kram'],
      bedrooms: [4, 2, 4], bathrooms: [1, 2], minPrice: 300,
      sort: 'price_asc', hasPool: true, query: 'villa',
    });
    expect(button('Cheapest').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { button('Open filters').click(); });
    expect(button('4+ BR').className).toContain('bg-sky-500');
    await act(async () => { button('Show Listings').click(); });
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!)).toEqual(requests[0].filters);
  });

  it('discards numbers the API cannot accept and keeps valid 4+ BR and location choices', async () => {
    await renderWithSavedFilters(`{
      "locations":["Wat Bo","${'x'.repeat(251)}"], "bedrooms":[4,1.25,1e309],
      "bathrooms":[2,1e309], "minPrice":150.5, "maxPrice":1e309,
      "minLeaseMax":3.5, "sort":"price_desc"
    }`);
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({
      city: 'siem_reap', locations: ['Wat Bo'], type: 'rent',
      bedrooms: [4], bathrooms: [2], sort: 'price_desc',
    });
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!)).toEqual(requests[0].filters);
  });

  it('repairs unknown persisted sort while preserving other filters and opening a fresh drawer', async () => {
    await renderWithSavedFilters(JSON.stringify({
      locations: ['Wat Bo'], bedrooms: [4], maxPrice: 800, sort: 'featured',
    }));
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toMatchObject({
      locations: ['Wat Bo'], bedrooms: [4], maxPrice: 800, sort: 'newest',
    });
    expect(button('Newest').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { button('Open filters').click(); });
    expect(drawerButton('Newest').className).toContain('bg-sky-500');
    await act(async () => { button('Price: High').click(); });
    await act(async () => { (host.querySelector('.fixed.inset-0 button.p-1') as HTMLButtonElement).click(); });
    await act(async () => { button('Open filters').click(); });
    expect(drawerButton('Newest').className).toContain('bg-sky-500');
    await act(async () => { button('Price: Low').click(); });
    await act(async () => { button('Show Listings').click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(requests.at(-1)?.filters.sort).toBe('price_asc');
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!).sort).toBe('price_asc');
  });

  it('retains repaired applied filters through Cancel and clears them with Reset', async () => {
    await renderWithSavedFilters(JSON.stringify({ locations: ['Wat Bo'], bedrooms: [4], maxPrice: 'oops', sort: 'price_desc' }));
    await act(async () => { button('Open filters').click(); });
    await act(async () => { button('2 BR').click(); });
    await act(async () => { (host.querySelector('.fixed.inset-0 button.p-1') as HTMLButtonElement).click(); });
    await act(async () => { button('Open filters').click(); });
    expect(button('4+ BR').className).toContain('bg-sky-500');
    expect(button('2 BR').className).not.toContain('bg-sky-500');
    await act(async () => { button('Reset').click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(requests.at(-1)?.filters).toEqual({
      city: 'siem_reap', locations: [], type: 'rent', sort: 'newest',
      category: undefined, minPrice: undefined, maxPrice: undefined,
      bedrooms: undefined, bathrooms: undefined, hasPool: undefined,
      minLeaseMax: undefined, query: undefined, reviewStatus: undefined,
    });
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!).sort).toBe('newest');
  });

  it('continues with defaults if localStorage.getItem throws', async () => {
    const original = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'homeasy_filters') throw new DOMException('Blocked', 'SecurityError');
      return original.call(this, key);
    });
    await act(async () => { root.render(<App />); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(requests).toHaveLength(1);
    expect(requests[0].filters).toEqual({
      city: 'siem_reap', locations: [], type: 'rent', sort: 'newest',
    });
  });

  it('keeps map code off the initial feed and renders the map after opening its tab', async () => {
    await act(async () => { root.render(<App />); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="map-view"]')).toBeNull();

    const openMap = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open map tab')!;
    await act(async () => {
      openMap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="map-view"]')).not.toBeNull();
  });

  it('T24: selecting a map cluster retains applied cohort filters and scopes the list to its exact key', async () => {
    localStorage.setItem('homeasy_filters', JSON.stringify({
      locations: ['Wat Bo'], bedrooms: [4], maxPrice: 800, hasPool: false, sort: 'price_desc',
    }));
    await act(async () => { root.render(<App />); await Promise.resolve(); });
    const openMap = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open map tab')!;
    await act(async () => { openMap.click(); await Promise.resolve(); });
    expect(JSON.parse(host.querySelector('[data-testid="map-view"]')!.getAttribute('data-filters')!)).toMatchObject({
      locations: ['Wat Bo'], bedrooms: [4], maxPrice: 800, hasPool: false, sort: 'price_desc',
    });
    await act(async () => { (host.querySelector('[data-testid="map-view"]') as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(requests.at(-1)?.filters.locations).toEqual(['Wat Bo']);
    expect(requests.at(-1)?.filters.mapClusterKey).toBe('siem_reap:sla_kram');
    expect(requests.at(-1)?.filters).toMatchObject({ bedrooms: [4], maxPrice: 800, hasPool: false, sort: 'price_desc' });
    expect(host.querySelector('[data-testid="map-view"]')).toBeNull();
  });

  it('passes Apply and Reset changes to the mounted MapView', async () => {
    await act(async () => { root.render(<App />); await Promise.resolve(); });
    await act(async () => { button('Open map tab').click(); await Promise.resolve(); });
    const mapFilters = () => JSON.parse(host.querySelector('[data-testid="map-view"]')!.getAttribute('data-filters')!);
    expect(mapFilters().maxPrice).toBe(800);
    await act(async () => { button('Open filters').click(); });
    await act(async () => { button('4+ BR').click(); });
    await act(async () => { button('Show Listings').click(); });
    expect(mapFilters()).toMatchObject({ locations: ['Wat Bo'], maxPrice: 800, bedrooms: [4] });
    await act(async () => { button('Open filters').click(); });
    await act(async () => { button('Reset').click(); });
    expect(mapFilters()).toMatchObject({ locations: [], sort: 'newest', type: 'rent' });
    expect(mapFilters().bedrooms).toBeUndefined();
    expect(mapFilters().maxPrice).toBeUndefined();
  });

  it('documents that FilterDrawer Apply drops a map cluster key but retains its location aliases', async () => {
    await act(async () => { root.render(<App />); await Promise.resolve(); });
    await act(async () => { button('Open map tab').click(); await Promise.resolve(); });
    await act(async () => {
      (host.querySelector('[data-testid="map-view"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(requests.at(-1)?.filters.mapClusterKey).toBe('siem_reap:sla_kram');
    const aliases = requests.at(-1)!.filters.locations;

    await act(async () => { button('Open filters').click(); });
    await act(async () => { button('Show Listings').click(); await new Promise((resolve) => setTimeout(resolve, 5)); });

    expect(requests.at(-1)?.filters.locations).toEqual(aliases);
    expect(requests.at(-1)?.filters.mapClusterKey).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('homeasy_filters')!).mapClusterKey).toBeUndefined();
  });

  it('keeps filters with the selected sort and drops an old page after sorting changes', async () => {
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      requests[0].resolve({ total: 3, page: 1, limit: 20, totalPages: 3, items: [property(1)] });
      await Promise.resolve();
    });

    const loadMore = () => [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Load More Listings'))!;
    await act(async () => {
      loadMore().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(requests[1].page).toBe(2);

    const cheapest = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Cheapest')!;
    await act(async () => {
      cheapest.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      page: 1,
      filters: { locations: ['Wat Bo'], maxPrice: 800, sort: 'price_asc' },
    });
    expect(JSON.parse(localStorage.getItem('homeasy_filters') ?? '{}')).toMatchObject({
      locations: ['Wat Bo'], maxPrice: 800, sort: 'price_asc',
    });
    expect(cheapest.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      requests[1].resolve({ total: 3, page: 2, limit: 20, totalPages: 3, items: [property(99)] });
      await Promise.resolve();
    });

    await act(async () => {
      requests[2].resolve({ total: 2, page: 1, limit: 20, totalPages: 2, items: [property(2)] });
      await Promise.resolve();
    });
    expect([...host.querySelectorAll('[data-testid="property"]')].map((node) => node.textContent)).toEqual(['2']);
    await act(async () => {
      loadMore().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(requests[3]).toMatchObject({ page: 2, filters: { sort: 'price_asc', locations: ['Wat Bo'] } });

    await act(async () => {
      requests[3].resolve({ total: 2, page: 2, limit: 20, totalPages: 2, items: [property(3)] });
      await Promise.resolve();
    });
    expect([...host.querySelectorAll('[data-testid="property"]')].map((node) => node.textContent)).toEqual(['2', '3']);
  });

  it('hides stale feed cards and pagination after a changed filter request fails, then recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderWithSavedFilters(null);
    expect(requests).toHaveLength(1);

    await act(async () => {
      requests[0].resolve({ total: 22, page: 1, limit: 20, totalPages: 2, items: [property(1)] });
      await Promise.resolve();
    });
    expect([...host.querySelectorAll('[data-testid="property"]')].map((item) => item.textContent)).toEqual(['1']);
    expect(button('Load More Listings (21 remaining)')).toBeTruthy();

    await act(async () => {
      button('Cheapest').click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].filters.sort).toBe('price_asc');

    await act(async () => {
      requests[1].reject(new Error('Network offline'));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Network offline');
    expect(host.querySelector('[data-testid="property"]')).toBeNull();
    expect(host.textContent).not.toContain('Load More Listings');

    await act(async () => {
      button('Newest').click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(requests).toHaveLength(3);
    await act(async () => {
      requests[2].resolve({ total: 1, page: 1, limit: 20, totalPages: 1, items: [property(3)] });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Network offline');
    expect([...host.querySelectorAll('[data-testid="property"]')].map((item) => item.textContent)).toEqual(['3']);
  });

  it('keeps newest as the default and drops an old first page after sorting changes', async () => {
    localStorage.removeItem('homeasy_filters');
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      page: 1,
      filters: { city: 'siem_reap', type: 'rent', sort: 'newest' },
    });
    const group = host.querySelector('[role="group"][aria-labelledby="feed-sort-label"]');
    expect(group).not.toBeNull();
    const newest = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Newest')!;
    expect(newest.getAttribute('aria-pressed')).toBe('true');

    const mostExpensive = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Most expensive')!;
    await act(async () => {
      mostExpensive.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ page: 1, filters: { sort: 'price_desc' } });

    await act(async () => {
      requests[0].resolve({ total: 1, page: 1, limit: 20, totalPages: 1, items: [property(99)] });
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="property"]')).toBeNull();

    await act(async () => {
      requests[1].resolve({ total: 1, page: 1, limit: 20, totalPages: 1, items: [property(2)] });
      await Promise.resolve();
    });
    expect([...host.querySelectorAll('[data-testid="property"]')].map((node) => node.textContent)).toEqual(['2']);
  });

  it('opens the drawer with the applied feed sort and discards changes cancelled on close', async () => {
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const button = (label: string) => Array.from(host.querySelectorAll('button'))
      .find((item) => item.textContent?.trim() === label)!;

    await act(async () => { button('Open filters').click(); });
    await act(async () => {
      (host.querySelector('.fixed.inset-0 button.p-1') as HTMLButtonElement).click();
    });
    await act(async () => { button('Most expensive').click(); });
    await act(async () => { button('Open filters').click(); });
    expect(button('Price: High').className).toContain('bg-sky-500');

    await act(async () => { button('Price: Low').click(); });
    await act(async () => {
      (host.querySelector('.fixed.inset-0 button.p-1') as HTMLButtonElement).click();
    });
    await act(async () => { button('Open filters').click(); });
    expect(button('Price: High').className).toContain('bg-sky-500');

    await act(async () => { button('Show Listings').click(); });
    expect(requests.at(-1)?.filters).toMatchObject({
      locations: ['Wat Bo'], maxPrice: 800, sort: 'price_desc',
    });
  });

  it('hydrates the full photo gallery after opening a feed card and ignores stale detail responses', async () => {
    api.fetchPropertyById.mockReset();
    const first = deferred<PropertyDTO>();
    const second = deferred<PropertyDTO>();
    api.fetchPropertyById.mockImplementation((id: number) => id === 1 ? first.promise : second.promise);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await act(async () => {
      requests[0].resolve({ total: 2, page: 1, limit: 20, totalPages: 1, items: [property(1), property(2)] });
      await Promise.resolve();
    });

    const view = (id: number) => [...host.querySelectorAll('button')].find((button) => button.textContent === `View ${id}`)! as HTMLButtonElement;
    await act(async () => { view(1).click(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).toBe('Listing 1');
    await act(async () => { view(2).click(); await Promise.resolve(); });
    await act(async () => {
      second.resolve({ ...property(2), photos: Array.from({ length: 11 }, (_, i) => `photo-${i}`) });
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve({ ...property(1), photos: Array.from({ length: 9 }, (_, i) => `old-${i}`) });
      await Promise.resolve();
    });
    expect(api.fetchPropertyById.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).toBe('Listing 2');
    expect(host.querySelector('[data-testid="detail-modal"]')?.getAttribute('data-photos')).toBe('11');
  });

  it('keeps all review photos and ignores a detail response that arrives during approval', async () => {
    const oldDetail = deferred<PropertyDTO>();
    const review = deferred<{ property: PropertyDTO }>();
    api.fetchPropertyById.mockReturnValue(oldDetail.promise);
    api.reviewProperty.mockReturnValue(review.promise);
    await act(async () => { root.render(<App />); await new Promise((resolve) => setTimeout(resolve, 5)); });
    await act(async () => {
      requests[0].resolve({ total: 1, page: 1, limit: 20, totalPages: 1, items: [{ ...property(1), photos: ['preview'] }] });
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'View 1')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve listing')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      oldDetail.resolve({ ...property(1), title: 'Stale detail', photos: ['stale'] });
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).not.toContain('Stale detail');
    await act(async () => {
      review.resolve({ property: { ...property(1), title: 'Approved', photos: Array.from({ length: 11 }, (_, i) => `photo-${i}`) } });
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).toContain('Approved');
    expect(host.querySelector('[data-testid="detail-modal"]')?.getAttribute('data-photos')).toBe('11');
  });

  it('does not replace a newly opened listing when an earlier review finishes', async () => {
    const pendingReview = deferred<{ property: PropertyDTO }>();
    api.reviewProperty.mockReturnValue(pendingReview.promise);
    api.fetchPropertyById.mockImplementation((id: number) => Promise.resolve(property(id)));
    await act(async () => { root.render(<App />); await new Promise((resolve) => setTimeout(resolve, 5)); });
    await act(async () => {
      requests[0].resolve({ total: 2, page: 1, limit: 20, totalPages: 1, items: [property(1), property(2)] });
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'View 1')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve listing')!.click();
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'View 2')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      pendingReview.resolve({ property: { ...property(1), title: 'Reviewed first listing' } });
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).toBe('Listing 2');
  });

  it('opens the tracked canonical listing detail after recording attribution', async () => {
    telegram.getTelegramStartParam.mockReturnValue('canonical-slug');
    api.trackMiniAppOpen.mockResolvedValue({
      ok: true, slug: 'canonical-slug',
      attribution: { request_id: 'request-42' },
      listingTarget: 'lst_0123456789abcdef0123456789abcdef',
    });
    api.fetchPropertyById.mockResolvedValue(property(42));
    await act(async () => { root.render(<App />); await Promise.resolve(); });
    expect(api.trackMiniAppOpen).toHaveBeenCalledExactlyOnceWith('canonical-slug');
    expect(api.fetchPropertyById).toHaveBeenCalledExactlyOnceWith('lst_0123456789abcdef0123456789abcdef');
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).toBe('Listing 42');
    expect(host.textContent).toContain('We prepared matches based on your housing request.');
  });

  it('preserves tracked listing resolution across StrictMode effect cleanup/replay', async () => {
    telegram.getTelegramStartParam.mockReturnValue('strict-slug');
    const tracked = deferred<{ ok: true; slug: string; attribution: { request_id: string | null }; listingTarget: number }>();
    api.trackMiniAppOpen.mockReturnValue(tracked.promise);
    api.fetchPropertyById.mockResolvedValue(property(1));
    await act(async () => { root.render(<StrictMode><App /></StrictMode>); await Promise.resolve(); });
    expect(api.trackMiniAppOpen).toHaveBeenCalledTimes(1);
    await act(async () => {
      tracked.resolve({ ok: true, slug: 'strict-slug', attribution: { request_id: null }, listingTarget: 1 });
      await Promise.resolve();
    });
    expect(api.fetchPropertyById).toHaveBeenCalledExactlyOnceWith(1);
    expect(host.querySelector('[data-testid="detail-modal"]')?.textContent).toBe('Listing 1');
  });
});
