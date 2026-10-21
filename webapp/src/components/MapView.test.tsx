import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapMarkerDTO } from '../types';

const api = vi.hoisted(() => ({
  fetchMapMarkers: vi.fn(),
  fetchPropertyById: vi.fn(),
}));

const leaflet = vi.hoisted(() => ({
  bounds: { south: 11, north: 12, west: 104, east: 105 },
  handlers: new Map<string, () => void>(),
  layers: [] as Array<[number, number]>,
}));

vi.mock('../services/api', () => api);
vi.mock('../services/telegram', () => ({ triggerHaptic: vi.fn() }));
vi.mock('leaflet', () => {
  const map = {
    getBounds: () => ({
      getSouth: () => leaflet.bounds.south,
      getNorth: () => leaflet.bounds.north,
      getWest: () => leaflet.bounds.west,
      getEast: () => leaflet.bounds.east,
    }),
    on: (event: string, handler: () => void) => { leaflet.handlers.set(event, handler); return map; },
    whenReady: (callback: () => void) => { callback(); return map; },
    setView: () => map,
  };
  const layer = {
    addTo: () => layer,
    clearLayers: () => { leaflet.layers.splice(0); },
  };
  return {
    default: {
      map: () => map,
      tileLayer: () => ({ addTo: () => undefined }),
      control: { zoom: () => ({ addTo: () => undefined }) },
      layerGroup: () => layer,
      divIcon: () => ({}),
      marker: (coords: [number, number]) => {
        const marker = {
          on: () => marker,
          addTo: () => { leaflet.layers.push(coords); return marker; },
        };
        return marker;
      },
    },
  };
});

import { MapView } from './MapView';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function marker(id: number, lat: number, lng: number): MapMarkerDTO {
  return {
    id, title: `Listing ${id}`, priceUsd: 300, category: null, propertyType: 'rent',
    bedrooms: 1, location: 'Wat Bo', locationKey: null, city: 'siem_reap',
    coordinatePrecision: 'exact', hasPool: false, thumbnail: null,
    coordinates: { lat, lng }, mapsUrl: null, isExact: true,
  };
}

describe('MapView viewport marker requests', () => {
  let root: Root;
  let host: HTMLDivElement;
  let requests: Array<ReturnType<typeof deferred<MapMarkerDTO[]>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    leaflet.handlers.clear();
    leaflet.layers.splice(0);
    Object.assign(leaflet.bounds, { south: 11, north: 12, west: 104, east: 105 });
    requests = [];
    api.fetchMapMarkers.mockImplementation(() => {
      const request = deferred<MapMarkerDTO[]>();
      requests.push(request);
      return request.promise;
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function mountAndMove() {
    await act(async () => {
      root.render(<MapView city="siem_reap" onSelectProperty={vi.fn()} />);
    });
    // The initial whenReady callback and city effect both request the initial viewport.
    expect(requests).toHaveLength(2);
    const initial = requests.at(-1)!;

    Object.assign(leaflet.bounds, { south: 13, north: 14, west: 103, east: 104 });
    await act(async () => {
      leaflet.handlers.get('moveend')!();
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(requests).toHaveLength(3);
    expect(api.fetchMapMarkers).toHaveBeenLastCalledWith('siem_reap', undefined, undefined, {
      minLat: 13, maxLat: 14, minLng: 103, maxLng: 104, paddingRatio: 0.2,
    });
    return { initial, latest: requests.at(-1)! };
  }

  it('keeps latest viewport markers when an older request resolves afterward', async () => {
    const { initial, latest } = await mountAndMove();

    await act(async () => {
      latest.resolve([marker(2, 13.5, 103.5)]);
      await Promise.resolve();
    });
    expect(leaflet.layers).toEqual([[13.5, 103.5]]);

    await act(async () => {
      initial.resolve([marker(1, 11.5, 104.5)]);
      await Promise.resolve();
    });
    expect(leaflet.layers).toEqual([[13.5, 103.5]]);
  });

  it('ignores an older viewport error while the latest marker request is pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initial, latest } = await mountAndMove();

    await act(async () => {
      initial.reject(new Error('Old viewport failed'));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Loading map pins...');

    await act(async () => {
      latest.resolve([marker(2, 13.5, 103.5)]);
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Loading map pins...');
    expect(leaflet.layers).toEqual([[13.5, 103.5]]);
  });
});
