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
