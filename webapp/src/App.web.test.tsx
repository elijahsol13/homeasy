import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyDTO } from './types';

const REF = `lst_${'a'.repeat(32)}`;
const OTHER_REF = `lst_${'b'.repeat(32)}`;

const api = vi.hoisted(() => ({
  fetchProperties: vi.fn(),
  fetchFilterMetadata: vi.fn(),
  fetchFavorites: vi.fn(),
  fetchMe: vi.fn(),
  reviewProperty: vi.fn(),
  toggleFavorite: vi.fn(),
  trackMiniAppOpen: vi.fn(),
  fetchPropertyById: vi.fn(),
  recordListingView: vi.fn(),
  recordTelegramContactDispatched: vi.fn(),
}));

vi.mock('./services/api', () => api);
vi.mock('./services/analytics', () => ({ captureEvent: vi.fn(), capturePageView: vi.fn() }));
vi.mock('./services/telegram', () => ({
  getTelegramStartParam: vi.fn(() => 'should-be-ignored'),
  isTelegramWebApp: vi.fn(() => false),
  initTelegramWebApp: vi.fn(),
  triggerHaptic: vi.fn(),
}));
vi.mock('./components/Header', () => ({
  Header: () => <div>Web catalog</div>,
}));
vi.mock('./components/PropertyCard', () => ({
  PropertyCard: ({ property, onSelect, onToggleFavorite, onTelegramContactDispatched }: {
    property: PropertyDTO;
    onSelect: (property: PropertyDTO) => void;
    onToggleFavorite: (identity: string | number) => void;
    onTelegramContactDispatched: (property: PropertyDTO) => void;
  }) => <article data-testid={`card-${property.publicRef}`}>
    <button type="button" onClick={() => onSelect(property)}>View {property.title}</button>
    <button type="button" onClick={() => onToggleFavorite(property.publicRef ?? property.id)}>
      {property.isFavorite ? 'Unsave' : 'Save'} {property.title}
    </button>
    <button type="button" onClick={() => onTelegramContactDispatched(property)}>Contact {property.title}</button>
  </article>,
}));
vi.mock('./components/PropertyDetailModal', () => ({
  PropertyDetailModal: ({ property, onClose, onToggleFavorite }: {
    property: PropertyDTO | null;
    onClose: () => void;
    onToggleFavorite: (identity: string | number) => void;
  }) => property ? <div role="dialog">
    <span>Detail {property.title}</span>
    <button type="button" onClick={onClose}>Close detail</button>
    <button type="button" onClick={() => onToggleFavorite(property.publicRef ?? property.id)}>
      {property.isFavorite ? 'Unsave detail' : 'Save detail'}
    </button>
  </div> : null,
}));
vi.mock('./components/BottomNav', () => ({
  BottomNav: ({ onTabChange }: { onTabChange: (tab: 'feed' | 'map' | 'saved') => void }) => <nav>
    <button type="button" onClick={() => onTabChange('feed')}>Feed tab</button>
    <button type="button" onClick={() => onTabChange('saved')}>Saved tab</button>
    <button type="button" onClick={() => onTabChange('map')}>Map tab</button>
  </nav>,
}));
vi.mock('./components/MapView', () => ({ MapView: () => <div>Map</div> }));

import { App } from './App';

const first = { id: 9, publicRef: REF, title: 'Riverside flat' } as PropertyDTO;
const second = { id: 10, publicRef: OTHER_REF, title: 'Garden home' } as PropertyDTO;

describe('standalone guest browser', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    api.fetchProperties.mockResolvedValue({ items: [first, second], page: 1, total: 2, limit: 20, totalPages: 1 });
    api.fetchFilterMetadata.mockResolvedValue({ currentCity: 'siem_reap', cities: [], locations: [], categories: [], priceRange: { minUsd: 0, maxUsd: 0 }, bedroomOptions: [] });
    api.fetchPropertyById.mockImplementation(async (ref: string) => ref === REF ? first : second);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  const click = async (host: HTMLElement, label: string) => {
    const control = [...host.querySelectorAll('button, a')].find((item) => item.textContent?.trim() === label);
    if (!control) throw new Error(`Missing control: ${label}`);
    await act(async () => { (control as HTMLElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  const render = async () => {
    await act(async () => { root.render(<App />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  };

  it('presents a standalone public homepage and navigates without the mini app bottom bar', async () => {
    await render();
    expect(host.querySelector('h1')?.textContent).toContain('Find your place');
    expect(host.textContent).toContain('HOW HOMEASY WORKS');
    expect(host.textContent).toContain('Privacy & analytics');
    expect(host.textContent).not.toContain('Saved tab');
    await click(host, 'Saved homes');
    expect(window.location.pathname).toBe('/saved');
    expect(host.textContent).toContain('No saved properties yet');
    await click(host, 'Explore homes');
    expect(window.location.pathname).toBe('/');
    expect(host.textContent).toContain('Riverside flat');
  });

  it('supports direct map and saved routes, history navigation, and a valid skip target', async () => {
    window.history.replaceState(null, '', '/map');
    await render();
    expect(host.textContent).toContain('Explore homes by location.');
    expect(host.querySelector('nav[aria-label="Public website navigation"] [aria-current="page"]')?.textContent).toBe('Map view');
    const skip = host.querySelector<HTMLAnchorElement>('.public-skip-link');
    expect(skip?.textContent).toContain('Skip to main content');
    expect(host.querySelector(skip!.getAttribute('href')!)).toBeTruthy();

    await click(host, 'Saved homes');
    expect(window.location.pathname).toBe('/saved');
    expect(host.textContent).toContain('No saved properties yet');
    expect(host.querySelector(skip!.getAttribute('href')!)).toBeTruthy();

    await act(async () => {
      window.history.replaceState(null, '', '/map');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.textContent).toContain('Explore homes by location.');
    expect(host.textContent).not.toContain('No saved properties yet');
  });

  it('reads catalog, saves and opens contacts without any Telegram-only calls', async () => {
    await render();
    await click(host, 'Save Riverside flat');
    expect(localStorage.getItem('homeasy_web_saved_v1')).toContain(REF);
    expect(host.textContent).toContain('Unsave Riverside flat');
    await click(host, 'View Riverside flat');
    expect(window.location.pathname).toBe(`/listing/${REF}`);
    expect(host.textContent).toContain('Detail Riverside flat');
    expect(host.textContent).toContain('Unsave detail');
    await click(host, 'Contact Riverside flat');
    expect(api.fetchProperties).toHaveBeenCalled();
    for (const name of ['fetchMe', 'fetchFavorites', 'toggleFavorite', 'trackMiniAppOpen', 'recordListingView', 'recordTelegramContactDispatched', 'reviewProperty'] as const) {
      expect(api[name], name).not.toHaveBeenCalled();
    }
  });

  it('hydrates local saved listing after a fresh mount and can unsave it', async () => {
    localStorage.setItem('homeasy_web_saved_v1', JSON.stringify([REF]));
    await render();
    await click(host, 'Saved homes 1');
    expect(host.textContent).toContain('Unsave Riverside flat');
    await click(host, 'Unsave Riverside flat');
    expect(JSON.parse(localStorage.getItem('homeasy_web_saved_v1')!)).toEqual([]);
    expect(host.textContent).toContain('No saved properties yet');
  });

  it('loads a deep link and reacts to browser navigation without protected writes', async () => {
    window.history.replaceState(null, '', `/listing/${REF}`);
    await render();
    expect(host.textContent).toContain('Detail Riverside flat');
    await act(async () => {
      window.history.replaceState(null, '', `/listing/${OTHER_REF}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Detail Garden home');
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(api.recordListingView).not.toHaveBeenCalled();
  });

  it('hides the previous detail while a different deep link is loading', async () => {
    let resolveSecond!: (property: PropertyDTO) => void;
    const pendingSecond = new Promise<PropertyDTO>((resolve) => { resolveSecond = resolve; });
    api.fetchPropertyById.mockImplementation((ref: string) => ref === OTHER_REF
      ? pendingSecond : Promise.resolve(first));
    window.history.replaceState(null, '', `/listing/${REF}`);
    await render();
    expect(host.textContent).toContain('Detail Riverside flat');

    await act(async () => {
      window.history.replaceState(null, '', `/listing/${OTHER_REF}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.textContent).not.toContain('Detail Riverside flat');
    expect(host.textContent).toContain('Opening listing');

    await act(async () => { resolveSecond(second); });
    expect(host.textContent).toContain('Detail Garden home');
    expect(host.textContent).not.toContain('Detail Riverside flat');
  });

  it('shows a recoverable error when a linked property is gone', async () => {
    api.fetchPropertyById.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
    window.history.replaceState(null, '', `/listing/${REF}`);
    await render();
    expect(host.textContent).toContain('This listing is no longer available.');
    await click(host, 'Return to listings');
    expect(window.location.pathname).toBe('/');
  });
});
