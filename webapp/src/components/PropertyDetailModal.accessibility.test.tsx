// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyDTO } from '../types';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

import { PropertyDetailModal } from './PropertyDetailModal';

// jsdom has no scrollTo; photo scrolling is covered by separate carousel tests.
Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });

const listing: PropertyDTO = {
  id: 42, title: 'Accessible villa', description: '', priceUsd: 700, currency: 'USD',
  type: 'rent', category: 'villa', propertyType: 'Villa', bedrooms: 2, bathrooms: 1,
  depositUsd: null, minLeaseMonths: null, hasPool: null, location: 'Siem Reap',
  locationKey: null, city: 'siem_reap', coordinatePrecision: 'city', mapsUrl: null,
  coordinates: null, photos: [], thumbnail: null, sourceUrl: null, originalUrl: '',
  postedAt: null, createdAt: '2026-10-23T00:00:00Z',
  specs: { electricity: null, water: null, cleaning: null, restrictions: [], amenities: [], landmarks: [], marketingLandmarks: [] },
  contact: {},
};

describe('property detail dialog keyboard access', () => {
  let opener: HTMLButtonElement;
  let host: HTMLDivElement;
  let root: Root;
  let onClose: () => void;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    opener = document.createElement('button');
    opener.textContent = 'Open detail';
    document.body.appendChild(opener);
    opener.focus();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onClose = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    opener.remove();
  });

  async function render(property: PropertyDTO | null) {
    await act(async () => {
      root.render(<PropertyDetailModal property={property} onClose={onClose}
        onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />);
    });
  }

  async function keyDown(key: string, shiftKey = false) {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    });
  }

  it('focuses the Close button when opened, handles Escape and restores the opener on close', async () => {
    await render(listing);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(close);

    await keyDown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await render(null);
    expect(document.activeElement).toBe(opener);
  });

  it('wraps Tab and Shift+Tab inside the dialog and redirects stray focus back inside', async () => {
    await render(listing);
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    const last = host.querySelector<HTMLAnchorElement>('[aria-label="Google Maps"]')!;

    await keyDown('Tab', true);
    expect(document.activeElement).toBe(last);
    await keyDown('Tab');
    expect(document.activeElement).toBe(close);
    opener.focus();
    expect(document.activeElement).toBe(close);
  });

  it('keeps focus in the photo lightbox and Escape closes photos before the listing', async () => {
    await render({ ...listing, photos: ['https://example.com/1.jpg', 'https://example.com/2.jpg'] });
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    const firstPhoto = host.querySelector<HTMLImageElement>('img[alt="Accessible villa - photo 1"]')!;
    await act(async () => firstPhoto.click());

    const closePhotos = host.querySelector<HTMLButtonElement>('[aria-label="Close photos"]')!;
    expect(document.activeElement).toBe(closePhotos);
    await keyDown('Tab', true);
    expect(document.activeElement).toBe([...host.querySelectorAll('[aria-label="Next photo"]')].at(-1));

    await keyDown('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Close photos"]')).toBeNull();
    expect(document.activeElement).toBe(close);

    await keyDown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('announces whether the listing has been saved', async () => {
    await render({ ...listing, isFavorite: false });
    const favorite = host.querySelector<HTMLButtonElement>('[aria-label="Save to favorites"]');
    expect(favorite?.getAttribute('aria-pressed')).toBe('false');
    await render({ ...listing, isFavorite: true });
    expect(favorite?.getAttribute('aria-label')).toBe('Remove from favorites');
    expect(favorite?.getAttribute('aria-pressed')).toBe('true');
  });
});
