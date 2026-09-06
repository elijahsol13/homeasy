import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { CityKey, MapMarkerDTO, PropertyDTO } from '../types';
import { fetchMapMarkers, fetchPropertyById } from '../services/api';
import { triggerHaptic } from '../services/telegram';
import { ChevronRight, Waves, MapPin } from 'lucide-react';

interface MapViewProps {
  city: CityKey;
  onSelectProperty: (property: PropertyDTO) => void;
}

const CITY_COORDS: Record<CityKey, [number, number]> = {
  siem_reap: [13.3611, 103.8596],
  phnom_penh: [11.5564, 104.9282],
};

export const MapView: React.FC<MapViewProps> = ({ city, onSelectProperty }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const [markers, setMarkers] = useState<MapMarkerDTO[]>([]);
  const [selectedMarker, setSelectedMarker] = useState<MapMarkerDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchMarkersForCurrentBounds = () => {
    if (!mapInstanceRef.current) return;
    const b = mapInstanceRef.current.getBounds();
    const bounds = {
      minLat: b.getSouth(),
      maxLat: b.getNorth(),
      minLng: b.getWest(),
      maxLng: b.getEast(),
      paddingRatio: 0.2, // ~20% buffer overscan (~5-10 mm beyond screen on mobile)
    };

    fetchMapMarkers(city, undefined, undefined, bounds)
      .then((data) => {
        setMarkers(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load map markers:', err);
        setLoading(false);
      });
  };

  // Initialize Leaflet map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: CITY_COORDS[city],
        zoom: 13,
        zoomControl: false,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      L.control.zoom({ position: 'topright' }).addTo(map);

      const markersLayer = L.layerGroup().addTo(map);
      markersLayerRef.current = markersLayer;
      mapInstanceRef.current = map;

      const onMoveEnd = () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          fetchMarkersForCurrentBounds();
        }, 300);
      };

      map.on('moveend', onMoveEnd);

      map.whenReady(() => {
        fetchMarkersForCurrentBounds();
      });
    } else {
      mapInstanceRef.current.setView(CITY_COORDS[city], 13);
    }
  }, [city]);

  // Initial fetch / city change fetch
  useEffect(() => {
    setSelectedMarker(null);
    setLoading(true);
    if (mapInstanceRef.current) {
      fetchMarkersForCurrentBounds();
    }
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [city]);

  // Render markers onto map
  useEffect(() => {
    if (!markersLayerRef.current || !mapInstanceRef.current) return;

    markersLayerRef.current.clearLayers();

    markers.forEach((item) => {
      if (!item.coordinates) return;

      // Custom HTML Price Tag Marker
      const customIcon = L.divIcon({
        className: 'custom-map-pin',
        html: `
          <div style="
            background: #0284c7;
            color: #ffffff;
            font-weight: 700;
            font-size: 11px;
            padding: 3px 7px;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.25);
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            border: 2px solid #ffffff;
            transform: translate(-50%, -50%);
            cursor: pointer;
          ">
            $${item.priceUsd}
          </div>
        `,
        iconSize: [40, 20],
        iconAnchor: [20, 10],
      });

      const marker = L.marker([item.coordinates.lat, item.coordinates.lng], {
        icon: customIcon,
      });

      marker.on('click', () => {
        triggerHaptic('light');
        setSelectedMarker(item);
      });

      marker.addTo(markersLayerRef.current!);
    });
  }, [markers]);

  const handleCardClick = async () => {
    if (!selectedMarker) return;
    try {
      triggerHaptic('medium');
      const full = await fetchPropertyById(selectedMarker.id);
      onSelectProperty(full);
    } catch (err) {
      console.error('Failed to load full property:', err);
    }
  };

  return (
    <div className="relative w-full h-[calc(100vh-140px)]">
      {/* Map DOM element */}
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Loading pill */}
      {loading && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-md px-4 py-1.5 rounded-full text-xs font-semibold shadow-md text-zinc-700 dark:text-zinc-200">
          Loading map pins...
        </div>
      )}

      {/* Bottom Popup Card when a pin is selected */}
      {selectedMarker && (
        <div className="absolute bottom-4 inset-x-4 z-20 animate-in slide-in-from-bottom duration-200">
          <div
            onClick={handleCardClick}
            className="bg-white dark:bg-zinc-800 rounded-2xl p-3 shadow-xl border border-zinc-200 dark:border-zinc-700 flex items-center gap-3 cursor-pointer active:scale-99 transition-all"
          >
            {selectedMarker.thumbnail ? (
              <img
                src={selectedMarker.thumbnail}
                alt=""
                className="w-16 h-16 rounded-xl object-cover shrink-0"
              />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-zinc-100 dark:bg-zinc-700 shrink-0 flex items-center justify-center text-[10px] text-zinc-400">
                No Photo
              </div>
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-base font-extrabold text-zinc-900 dark:text-zinc-50">
                  ${selectedMarker.priceUsd}/mo
                </span>
                <span className="text-[10px] font-semibold bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300 px-1.5 py-0.5 rounded">
                  {selectedMarker.propertyType}
                </span>
              </div>

              <h4 className="text-xs text-zinc-700 dark:text-zinc-200 font-medium truncate mt-0.5">
                {selectedMarker.title}
              </h4>

              <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="flex items-center gap-0.5 truncate">
                  <MapPin className="w-3 h-3 text-sky-500 shrink-0" />
                  <span className="truncate">{selectedMarker.location}</span>
                </span>
                {selectedMarker.hasPool && (
                  <span className="flex items-center gap-0.5 text-sky-600">
                    <Waves className="w-3 h-3" /> Pool
                  </span>
                )}
              </div>
            </div>

            <ChevronRight className="w-5 h-5 text-zinc-400 shrink-0" />
          </div>
        </div>
      )}
    </div>
  );
};

