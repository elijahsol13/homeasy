import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyDTO } from '../types';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

import { PropertyDetailModal } from './PropertyDetailModal';

type Place = PropertyDTO['specs']['landmarks'][number];

const place = (name: string): Place => ({
  id: `custom:${name}`,
  name,
  link: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`,
});

const baseline: PropertyDTO = {
  id: 16511, title: '5-Bedroom Villa', description: '', priceUsd: 700, currency: 'USD',
  type: 'rent', category: 'villa', propertyType: 'Villa', bedrooms: 5, bathrooms: 6,
  depositUsd: null, minLeaseMonths: null, hasPool: null, location: 'Svay Dangkum',
  locationKey: null, city: 'siem_reap', coordinatePrecision: 'district', mapsUrl: null,
  coordinates: null, photos: [], thumbnail: null, sourceUrl: null, originalUrl: '',
  postedAt: null, createdAt: '2026-10-23T00:00:00Z',
  specs: { electricity: null, water: null, cleaning: null, restrictions: [], amenities: [], landmarks: [], marketingLandmarks: [] },
  contact: {},
};

describe('property detail landmark claims', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const sections = (element: HTMLElement) => ({
    neutral: [...element.querySelectorAll('h3')].find((h) => h.textContent === 'Nearby Landmarks')?.parentElement,
    promoted: [...element.querySelectorAll('h3')].find((h) => h.textContent === 'Advertised Nearby')?.parentElement,
  });

  async function render(landmarks: Place[], marketingLandmarks: Place[]) {
    await act(async () => {
      root.render(<PropertyDetailModal property={{ ...baseline, specs: { ...baseline.specs, landmarks, marketingLandmarks } }}
        onClose={vi.fn()} onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />);
    });
    return sections(host);
  }

  it('shows the Zannier hotel once as a neutral landmark despite near-phrase duplicate', async () => {
    const result = await render([place('Zannier Phum Baitang Hotel')], [place('close to Zannier Phum Baitang Hotel')]);
    expect(result.neutral?.querySelectorAll('button')).toHaveLength(1);
    expect(result.neutral?.textContent).toContain('Zannier Phum Baitang Hotel');
    expect(result.promoted).toBeUndefined();
    expect(result.neutral?.querySelector('button')?.textContent).not.toContain('close to');
    expect(result.neutral?.querySelector('button')?.title).toContain('close to Zannier Phum Baitang Hotel');
  });

  it('relabels an ordinary university proximity claim as a neutral landmark', async () => {
    const result = await render([], [place('3 minutes south of Build Bright University')]);
    expect(result.neutral?.textContent).toContain('Build Bright University');
    expect(result.neutral?.textContent).not.toContain('3 minutes south');
    expect(result.promoted).toBeUndefined();
    expect(result.neutral?.querySelector('button')?.title).toContain('Unverified advertiser wording: 3 minutes south');
    expect(result.neutral?.querySelector('button')?.textContent).not.toContain('3 minutes');
    expect(decodeURIComponent(result.neutral?.querySelector('button')?.getAttribute('title') ?? '')).toContain('Build Bright University');
  });

  it('preserves advertiser wording for tourist-destination proximity and deduplicates nearby counterparts', async () => {
    const result = await render([place('Pub Street'), place('Old Market')], [place('5 minutes from Pub Street and Old Market')]);
    expect(result.neutral).toBeUndefined();
    expect(result.promoted?.querySelectorAll('button')).toHaveLength(1);
    expect(result.promoted?.textContent).toContain('5 minutes from Pub Street and Old Market');
    expect(result.promoted?.textContent).toContain('not verified');
  });

  it('retains genuine neutral places alongside distinct promotional tourist claims', async () => {
    const result = await render([place('Wat Bo')], [place('10 minutes drive to Pub Street (3 km)')]);
    expect(result.neutral?.textContent).toContain('Wat Bo');
    expect(result.promoted?.textContent).toContain('10 minutes drive to Pub Street (3 km)');
  });

  it('does not present unnamed facilities as either geocodable landmarks or promotional claims', async () => {
    const result = await render([], [place('shops, cafés, restaurants, and daily necessities all within walking distance')]);
    expect(result.neutral).toBeUndefined();
    expect(result.promoted).toBeUndefined();
  });

  it('deduplicates Angkor Supermarket with its road qualifier, retaining another tourist promotion', async () => {
    const nearby = [place('Angkor Supermarket')];
    const marketed = [place('Close to Angkor Supermarket (6th Road)'), place('5 minutes drive to Pub Street (2km)')];
    const before = JSON.stringify({ nearby, marketed });
    const result = await render(nearby, marketed);
    expect(result.neutral?.querySelectorAll('button')).toHaveLength(1);
    expect(result.neutral?.querySelector('button')?.title).toContain('Close to Angkor Supermarket (6th Road)');
    expect(result.promoted?.querySelectorAll('button')).toHaveLength(1);
    expect(result.promoted?.textContent).toContain('5 minutes drive to Pub Street (2km)');
    expect(JSON.stringify({ nearby, marketed })).toBe(before);
  });

  it('normalizes a distinct named road without presenting a generic unnamed river as a landmark', async () => {
    const result = await render([], [place('80 meters from National Road 6'), place('near the river')]);
    expect(result.neutral?.querySelectorAll('button')).toHaveLength(1);
    expect(result.neutral?.textContent).toContain('National Road 6');
    expect(result.neutral?.querySelector('button')?.title).toContain('80 meters from National Road 6');
    expect(result.promoted).toBeUndefined();
  });

  it('rejects vague original neutral names and generic marketing labels while retaining Wat Bo', async () => {
    const result = await render([place('River'), place('near the river'), place('City Center'), place('Wat Bo')], [place('near hotel')]);
    expect(result.neutral?.querySelectorAll('button')).toHaveLength(1);
    expect(result.neutral?.textContent).toContain('Wat Bo');
    expect(result.promoted).toBeUndefined();
  });

  it('does not discard an unpromoted second place from a combined original landmark', async () => {
    const result = await render([place('Pub Street / Old Market')], [place('5 minutes to Pub Street')]);
    expect(result.neutral?.textContent).toContain('Old Market');
    expect(result.promoted?.textContent).toContain('5 minutes to Pub Street');
  });
});
