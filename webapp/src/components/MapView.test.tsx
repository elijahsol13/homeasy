import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterState, MapMarkerDTO } from '../types';

const api = vi.hoisted(() => ({
  fetchMapMarkers: vi.fn(),
  fetchPropertyById: vi.fn(),
}));

const leaflet = vi.hoisted(() => ({
  bounds: { south: 11, north: 12, west: 104, east: 105 },
  handlers: new Map<string, () => void>(),
  layers: [] as Array<[number, number]>,
  removeMap: vi.fn(),
}));

const maplibre = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  layers: [] as Array<{ id: string; type: string; layout?: Record<string, unknown> }>,
  maplibreGL: vi.fn(),
  setLayoutProperty: vi.fn(),
  setWorkerUrl: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../services/telegram', () => ({ triggerHaptic: vi.fn() }));
vi.mock('maplibre-gl', () => ({ setWorkerUrl: maplibre.setWorkerUrl }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/mock-maplibre-worker.js' }));
vi.mock('@maplibre/maplibre-gl-leaflet', () => ({ maplibreGL: maplibre.maplibreGL }));
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
    remove: () => { leaflet.removeMap(); return map; },
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

const initialFilters: FilterState = { city: 'siem_reap', locations: [], type: 'rent', sort: 'newest' };

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
    maplibre.handlers.clear();
    maplibre.layers.splice(0, maplibre.layers.length,
      {
        id: 'place-name',
        type: 'symbol',
        layout: { 'text-field': ['coalesce', ['get', 'name:nonlatin'], ['get', 'name']] },
      },
      { id: 'road-ref', type: 'symbol', layout: { 'text-field': ['get', 'ref'] } },
      { id: 'background', type: 'background', layout: {} },
    );
    maplibre.setLayoutProperty.mockImplementation((layerId: string, property: string, value: unknown) => {
      const layer = maplibre.layers.find((candidate) => candidate.id === layerId);
      if (layer?.layout) layer.layout[property] = value;
    });
    const maplibreMap = {
      on: (event: string, handler: () => void) => { maplibre.handlers.set(event, handler); return maplibreMap; },
      getStyle: () => ({ layers: maplibre.layers }),
      setLayoutProperty: maplibre.setLayoutProperty,
    };
    maplibre.maplibreGL.mockImplementation(() => {
      const layer = {
        addTo: () => layer,
        getMaplibreMap: () => maplibreMap,
      };
      return layer;
    });
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
      root.render(<MapView filters={initialFilters} onSelectProperty={vi.fn()} />);
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
    expect(api.fetchMapMarkers).toHaveBeenLastCalledWith(initialFilters, {
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

  it('refetches on applied filter changes, clears prior pins for empty cohorts and rejects older responses', async () => {
    const { latest: previousViewport } = await mountAndMove();
    await act(async () => {
      previousViewport.resolve([marker(1, 13.5, 103.5)]);
      await Promise.resolve();
    });
    expect(leaflet.layers).toEqual([[13.5, 103.5]]);

    const applied = { ...initialFilters, locations: ['Wat Bo'], bedrooms: [4], maxPrice: 800 };
    await act(async () => {
      root.render(<MapView filters={applied} onSelectProperty={vi.fn()} />);
    });
    expect(api.fetchMapMarkers).toHaveBeenLastCalledWith(applied, {
      minLat: 13, maxLat: 14, minLng: 103, maxLng: 104, paddingRatio: 0.2,
    });
    expect(leaflet.layers).toEqual([]);
    const pendingFiltered = requests.at(-1)!;

    await act(async () => {
      root.render(<MapView filters={initialFilters} onSelectProperty={vi.fn()} />);
    });
    expect(api.fetchMapMarkers).toHaveBeenLastCalledWith(initialFilters, expect.anything());
    const reset = requests.at(-1)!;
    await act(async () => {
      reset.resolve([]);
      await Promise.resolve();
    });
    expect(leaflet.layers).toEqual([]);
    expect(host.textContent).not.toContain('Loading map pins...');

    await act(async () => {
      pendingFiltered.resolve([marker(2, 13.6, 103.6)]);
      await Promise.resolve();
    });
    expect(leaflet.layers).toEqual([]);
  });

  it('uses OpenFreeMap and prefers Latin or English labels while preserving non-name labels', async () => {
    await act(async () => {
      root.render(<MapView filters={initialFilters} onSelectProperty={vi.fn()} />);
    });

    expect(maplibre.maplibreGL).toHaveBeenCalledWith({ style: 'https://tiles.openfreemap.org/styles/liberty' });
    const styleLoad = maplibre.handlers.get('style.load');
    expect(styleLoad).toBeDefined();
    act(() => styleLoad!());

    expect(maplibre.setLayoutProperty).toHaveBeenCalledTimes(1);
    expect(maplibre.setLayoutProperty).toHaveBeenCalledWith('place-name', 'text-field', [
      'coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'],
    ]);
    expect(maplibre.layers.find((layer) => layer.id === 'road-ref')?.layout?.['text-field']).toEqual(['get', 'ref']);
  });

  it('removes the Leaflet map when the map view unmounts', async () => {
    await act(async () => {
      root.render(<MapView filters={initialFilters} onSelectProperty={vi.fn()} />);
    });

    await act(async () => root.render(null));

    expect(leaflet.removeMap).toHaveBeenCalledTimes(1);
  });
});
