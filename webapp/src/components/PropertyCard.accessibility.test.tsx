// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropertyDTO } from '../types';
import { PropertyCard } from './PropertyCard';

const listing = {
  id: 9, publicRef: `lst_${'a'.repeat(32)}`, title: 'Garden apartment',
  description: '', priceUsd: 350, currency: 'USD', type: 'rent',
  category: 'apartment', propertyType: 'Apartment', bedrooms: 1, bathrooms: 1,
  depositUsd: null, minLeaseMonths: null, hasPool: null,
  location: 'Siem Reap', locationKey: null, city: 'Siem Reap',
  coordinatePrecision: 'city', mapsUrl: null, coordinates: null,
  createdAt: '2026-11-01T00:00:00Z', postedAt: null,
  photos: [], thumbnail: null, sourceUrl: null, originalUrl: '', contact: {},
  specs: { electricity: null, water: null, cleaning: null, restrictions: [], amenities: [], landmarks: [], marketingLandmarks: [] },
} satisfies PropertyDTO;

it('exposes the current favorite state and action to assistive technology', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const toggle = vi.fn();
  const render = async (isFavorite: boolean) => {
    await act(async () => root.render(<PropertyCard property={{ ...listing, isFavorite }} onSelect={vi.fn()} onToggleFavorite={toggle} />));
  };

  try {
    await render(false);
    const button = host.querySelector<HTMLButtonElement>('.property-card__favorite')!;
    expect(button.getAttribute('aria-label')).toBe('Save to favorites');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => button.click());
    expect(toggle).toHaveBeenCalledWith(listing.publicRef);

    await render(true);
    expect(button.getAttribute('aria-label')).toBe('Remove from favorites');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('retries the cover with only the next two listed photos and retains its accessible placeholder', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const photos = ['expired-1.jpg', 'expired-2.jpg', 'expired-3.jpg', 'photo-4.jpg'];

  try {
    await act(async () => root.render(
      <PropertyCard property={{ ...listing, photos }} onSelect={vi.fn()} onToggleFavorite={vi.fn()} />,
    ));

    const cover = () => host.querySelector<HTMLImageElement>('img[alt="Garden apartment - photo 1"]');
    expect(cover()?.getAttribute('src')).toBe('expired-1.jpg');

    await act(async () => cover()?.dispatchEvent(new Event('error')));
    expect(cover()?.getAttribute('src')).toBe('expired-2.jpg');

    await act(async () => cover()?.dispatchEvent(new Event('error')));
    expect(cover()?.getAttribute('src')).toBe('expired-3.jpg');

    await act(async () => cover()?.dispatchEvent(new Event('error')));
    expect(cover()).toBeNull();
    expect(host.querySelector('[role="img"][aria-label="Garden apartment - photo 1"]')?.textContent).toBe('Photo unavailable');
    expect(host.querySelector('img[alt="Garden apartment - photo 4"]')?.getAttribute('src')).toBe('photo-4.jpg');
    expect(host.querySelector('[aria-label="Show photo 1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelectorAll('[aria-label^="Show photo "]').length).toBe(4);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('shows the placeholder immediately when a non-cover carousel photo fails', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await act(async () => root.render(
      <PropertyCard property={{ ...listing, photos: ['cover.jpg', 'broken.jpg', 'third.jpg'] }} onSelect={vi.fn()} onToggleFavorite={vi.fn()} />,
    ));
    const secondSlide = host.querySelector<HTMLImageElement>('img[alt="Garden apartment - photo 2"]');
    expect(secondSlide?.getAttribute('src')).toBe('broken.jpg');

    await act(async () => secondSlide?.dispatchEvent(new Event('error')));
    expect(host.querySelector('img[alt="Garden apartment - photo 2"]')).toBeNull();
    expect(host.querySelector('[role="img"][aria-label="Garden apartment - photo 2"]')?.textContent).toBe('Photo unavailable');
    expect(host.querySelector('img[alt="Garden apartment - photo 1"]')?.getAttribute('src')).toBe('cover.jpg');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('skips duplicate URLs when selecting the two alternative cover photos', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await act(async () => root.render(
      <PropertyCard property={{ ...listing, photos: ['expired.jpg', 'expired.jpg', 'second.jpg', 'third.jpg'] }} onSelect={vi.fn()} onToggleFavorite={vi.fn()} />,
    ));
    const cover = () => host.querySelector<HTMLImageElement>('img[alt="Garden apartment - photo 1"]');

    await act(async () => cover()?.dispatchEvent(new Event('error')));
    expect(cover()?.getAttribute('src')).toBe('second.jpg');

    await act(async () => cover()?.dispatchEvent(new Event('error')));
    expect(cover()?.getAttribute('src')).toBe('third.jpg');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
