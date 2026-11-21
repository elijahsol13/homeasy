import type L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type Map as MapLibreMap } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ENGLISH_LABEL_EXPRESSION = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin']];

function referencesNameField(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value[0] === 'get' && typeof value[1] === 'string' && /^name(?::|_|$)/.test(value[1])) return true;
  return value.some(referencesNameField);
}

function applyEnglishFirstLabels(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const textField = layer.layout?.['text-field'];
    if (!textField || !referencesNameField(textField)) continue;
    map.setLayoutProperty(layer.id, 'text-field', ENGLISH_LABEL_EXPRESSION as never);
  }
}

export function addOpenFreeMapBasemap(map: L.Map): void {
  setWorkerUrl(workerUrl);
  const openFreeMapLayer = maplibreGL({ style: OPENFREEMAP_STYLE_URL }).addTo(map);
  const maplibreMap = openFreeMapLayer.getMaplibreMap();
  maplibreMap.on('style.load', () => applyEnglishFirstLabels(maplibreMap));
}
