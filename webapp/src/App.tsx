import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import type {
  ActiveTab,
  FilterMetadata,
  FilterState,
  MapFocusRequest,
  PropertyDTO,
} from './types';
import {
  fetchProperties,
  fetchFilterMetadata,
  fetchFavorites,
  fetchMe,
  fetchPropertyById,
  reviewProperty,
  recordListingView,
  recordTelegramContactDispatched,
  toggleFavorite,
  trackMiniAppOpen,
  type TrackingAttribution,
} from './services/api';
import { getTelegramStartParam, initTelegramWebApp } from './services/telegram';
import { Header } from './components/Header';
import { PropertyCard } from './components/PropertyCard';
import { PropertyDetailModal } from './components/PropertyDetailModal';
import { FilterDrawer } from './components/FilterDrawer';
import { BottomNav } from './components/BottomNav';
import { Loader2, AlertCircle, Heart, Inbox } from 'lucide-react';
import { INITIAL_FILTERS, normalizeStoredFilters } from './filter-storage';

// Leaflet is only needed on the map tab, never on the initial feed load.
const MapView = React.lazy(async () => ({
  default: (await import('./components/MapView')).MapView,
}));

export const App: React.FC = () => {
  // Telegram initialization + tracked-link attribution bootstrap
  // Reuse the in-flight request across React StrictMode effect replays.
  // Each effect attaches its own cancellable UI continuation.
  const trackingBootstrap = useRef<ReturnType<typeof trackMiniAppOpen> | null>(null);
  const [attribution, setAttribution] = useState<TrackingAttribution | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<PropertyDTO | null>(null);
  const detailRequestVersion = useRef(0);

  useEffect(() => {
    initTelegramWebApp();

    if (!trackingBootstrap.current) {
      const startParam = getTelegramStartParam();
      if (!startParam) return;
      trackingBootstrap.current = trackMiniAppOpen(startParam);
    }
    let active = true;
    trackingBootstrap.current
      .then(async (res) => {
        if (!active) return;
        setAttribution(res.attribution);
        if (res.listingTarget === null || res.listingTarget === undefined) return;
        try {
          const property = await fetchPropertyById(res.listingTarget);
          if (active) setSelectedProperty(property);
        } catch (err) {
          console.warn('[Tracking] Linked listing unavailable:', err);
        }
      })
      .catch((err) => {
        if (active) console.error('[Tracking] Failed to report Mini App open:', err);
      });
    return () => { active = false; };
  }, []);

  // Navigation & Filter states
  const [activeTab, setActiveTab] = useState<ActiveTab>('feed');
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [metadata, setMetadata] = useState<FilterMetadata | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Resolve admin capability from the server (never trust client-side flags)
  useEffect(() => {
    fetchMe()
      .then((me) => setIsAdmin(me.isAdmin))
      .catch((err) => console.error('Failed to fetch user info:', err));
  }, []);

  // Restore saved filter state on mount (anti-flicker)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('homeasy_filters');
      if (saved) {
        setFilters(normalizeStoredFilters(JSON.parse(saved)));
      }
    } catch {
      // ignore
    } finally {
      setIsStorageReady(true);
    }
  }, []);

  // Persist filters on change
  useEffect(() => {
    if (isStorageReady) {
      try {
        localStorage.setItem('homeasy_filters', JSON.stringify(filters));
      } catch {
        // ignore
      }
    }
  }, [filters, isStorageReady]);

  // Property feed states
  const [properties, setProperties] = useState<PropertyDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryGeneration = useRef(0);
  const loadMoreRequest = useRef<{ id: number; generation: number } | null>(null);
  const loadMoreRequestId = useRef(0);

  // Invalidate pagination synchronously when filters change so an old request
  // cannot append results between the render and the next fetch effect.
  useLayoutEffect(() => {
    queryGeneration.current += 1;
    loadMoreRequest.current = null;
  }, [filters]);

  // Modal & Favorites
  const [mapReturnProperty, setMapReturnProperty] = useState<PropertyDTO | null>(null);
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest | null>(null);
  const [favorites, setFavorites] = useState<PropertyDTO[]>([]);

  // Feed, map and favorites contain a short photo preview. Hydrate the detail
  // modal on selection while guarding against late responses from older opens.
  const openProperty = (property: PropertyDTO) => {
    const version = ++detailRequestVersion.current;
    setSelectedProperty(property);
    fetchPropertyById(property.publicRef ?? property.id)
      .then((detail) => {
        if (detailRequestVersion.current !== version) return;
        setSelectedProperty((current) => current && current.id === property.id
          ? { ...detail, isFavorite: current.isFavorite ?? detail.isFavorite }
          : current);
      })
      .catch((err) => console.warn('[Property] Full detail unavailable:', err));
  };

  const closeProperty = () => {
    detailRequestVersion.current += 1;
    setSelectedProperty(null);
  };

  // Count active non-default filters
  const activeFilterCount = [
    filters.locations.length > 0,
    Boolean(filters.category),
    filters.type !== 'rent',
    Boolean(filters.minPrice),
    Boolean(filters.maxPrice),
    Boolean(filters.bedrooms && filters.bedrooms.length > 0),
    Boolean(filters.bathrooms && filters.bathrooms.length > 0),
    Boolean(filters.hasPool),
    Boolean(filters.minLeaseMax),
    Boolean(filters.query && filters.query.trim().length > 0),
    Boolean(filters.reviewStatus),
  ].filter(Boolean).length;

  // Load filter metadata when city changes
  useEffect(() => {
    fetchFilterMetadata(filters.city)
      .then(setMetadata)
      .catch((err) => console.error('Failed to load filter metadata:', err));
  }, [filters.city]);

  // Load favorites
  const loadFavorites = useCallback(async () => {
    try {
      const favs = await fetchFavorites();
      setFavorites(favs);
    } catch (err) {
      console.error('Failed to load favorites:', err);
    }
  }, []);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  // Fetch properties on filter change (debounced for search query)
  useEffect(() => {
    if (!isStorageReady) return;
    let active = true;
    const generation = queryGeneration.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setPage(1);

    const timer = setTimeout(
      () => {
        fetchProperties(filters, 1, 20)
          .then((res) => {
            if (!active || queryGeneration.current !== generation) return;
            setProperties(res.items);
            setTotal(res.total);
            setTotalPages(res.totalPages);
            setLoading(false);
          })
          .catch((err) => {
            if (!active || queryGeneration.current !== generation) return;
            console.error('Failed to fetch properties:', err);
            setError(err.message || 'Failed to load properties');
            setLoading(false);
          });
      },
      filters.query ? 300 : 0,
    );

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filters, isStorageReady]);

  // Load more pages
  const handleLoadMore = async () => {
    if (loadingMore || page >= totalPages) return;
    const generation = queryGeneration.current;
    if (loadMoreRequest.current?.generation === generation) return;
    const requestId = ++loadMoreRequestId.current;
    loadMoreRequest.current = { id: requestId, generation };
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const res = await fetchProperties(filters, nextPage, 20);
      if (
        queryGeneration.current !== generation ||
        loadMoreRequest.current?.id !== requestId
      ) return;
      setProperties((prev) => [...prev, ...res.items]);
      setPage(nextPage);
    } catch (err) {
      if (queryGeneration.current === generation) {
        console.error('Failed to load more:', err);
      }
    } finally {
      if (loadMoreRequest.current?.id === requestId) {
        loadMoreRequest.current = null;
        setLoadingMore(false);
      }
    }
  };

  // Admin review action (approve/reject pending listings)
  const handleReview = async (listing: PropertyDTO, action: 'approve' | 'reject') => {
    // A pending detail fetch must not replace the moderation result.
    const version = ++detailRequestVersion.current;
    try {
      const res = await reviewProperty(listing.publicRef ?? listing.id, action);
      const updated = res.property;
      if (filters.reviewStatus === 'pending' || action === 'reject') {
        setProperties((prev) => prev.filter((p) => p.id !== listing.id));
        setTotal((count) => Math.max(0, count - 1));
      } else if (updated) {
        setProperties((prev) => prev.map((p) => (p.id === listing.id
          ? { ...updated, isFavorite: p.isFavorite ?? updated.isFavorite }
          : p)));
      }
      // A close or newer selection during the review must remain untouched.
      if (detailRequestVersion.current === version) {
        setSelectedProperty((current) => current?.id === listing.id && updated
          && filters.reviewStatus !== 'pending' && action !== 'reject'
          ? { ...updated, isFavorite: current.isFavorite ?? updated.isFavorite }
          : current?.id === listing.id ? null : current);
      }
    } catch (err) {
      console.error('Review failed:', err);
      alert(err instanceof Error ? err.message : 'Review failed');
    }
  };

  // Toggle favorite
  const handleShowOnMap = (property: PropertyDTO) => {
    detailRequestVersion.current += 1;
    setMapReturnProperty(property);
    setFilters((previous) => ({ ...previous, city: property.city as FilterState['city'], locations: [], mapClusterKey: undefined }));
    setMapFocusRequest({
      propertyId: property.id,
      city: property.city as MapFocusRequest['city'],
      locationKey: property.locationKey,
      location: property.location,
      coordinates: property.coordinates,
      coordinatePrecision: property.coordinatePrecision,
    });
    setSelectedProperty(null);
    setActiveTab('map');
  };

  const handleToggleFavorite = async (identity: number | string) => {
    try {
      const result = await toggleFavorite(identity);
      const matches=(p:PropertyDTO)=>typeof identity==='string'?p.publicRef===identity:p.id===identity;
      // Update in feed
      setProperties((prev) =>
        prev.map((p) =>
          matches(p) ? { ...p, isFavorite: result.isFavorite } : p,
        ),
      );
      // Update in modal if opened
      setSelectedProperty((prev) =>
        prev && matches(prev)
          ? { ...prev, isFavorite: result.isFavorite }
          : prev,
      );
      // Refresh favorites list
      loadFavorites();
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  };

  // Shadow-mode Phase 7A: start the first-party lead flow before handing control
  // to Telegram. This best-effort request never blocks contact dispatch.
  const handleTelegramContactDispatched = useCallback((property: PropertyDTO) => {
    if (!property.publicRef) return;
    void recordTelegramContactDispatched(property.publicRef, filters)
      .catch((err) => console.error('[Interest] Failed to record Telegram contact:', err));
  }, [filters]);

  const handleSelectProperty = (property: PropertyDTO) => {
    openProperty(property);
    if (!property.publicRef) return;
    void recordListingView(property.publicRef)
      .catch((err) => console.error('[Interest] Failed to record listing view:', err));
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors">
      {/* Tracked-link request context banner (only when opened from a tracked request link) */}
      {attribution?.request_id && (
        <div className="bg-sky-500 text-white px-4 py-3 shadow-sm">
          <div className="max-w-lg mx-auto flex items-center gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm">
              ✨
            </span>
            <p className="text-sm font-medium leading-snug">
              We prepared matches based on your housing request.
            </p>
          </div>
        </div>
      )}

      {/* Top Header with City switcher & search */}
      <Header
        filters={filters}
        onFilterChange={(nextFilters) => setFilters({ ...nextFilters, mapClusterKey: undefined })}
        onOpenFilterDrawer={() => setIsFilterOpen(true)}
        activeFilterCount={activeFilterCount}
      />

      {/* Main Content Area based on Active Tab */}
      <main className="flex-1 max-w-lg w-full mx-auto pb-24">
        {activeTab === 'feed' && (
          <div className="px-4 py-3 space-y-4">
            <div className="space-y-2">
              <span id="feed-sort-label" className="px-1 text-xs font-bold uppercase tracking-wider text-zinc-400">
                Sort listings
              </span>
              <div role="group" aria-labelledby="feed-sort-label" className="grid grid-cols-3 gap-2">
                {[
                  { value: 'newest' as const, label: 'Newest' },
                  { value: 'price_asc' as const, label: 'Cheapest' },
                  { value: 'price_desc' as const, label: 'Most expensive' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={filters.sort === option.value}
                    onClick={() => setFilters((previous) => (
                      previous.sort === option.value
                        ? previous
                        : { ...previous, sort: option.value }
                    ))}
                    className={`py-2.5 rounded-xl text-xs font-semibold border transition-colors ${
                      filters.sort === option.value
                        ? 'bg-sky-500 text-white border-sky-500'
                        : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Status bar */}
            {!loading && !error && (
              <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 px-1">
                <span>
                  Found <strong className="text-zinc-800 dark:text-zinc-200">{total}</strong>{' '}
                  {filters.type === 'sale' ? 'properties for sale' : 'rentals'}
                </span>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilters({ ...INITIAL_FILTERS, city: filters.city })}
                    className="text-sky-600 dark:text-sky-400 font-medium hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 flex items-center gap-3 text-rose-700 dark:text-rose-300 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Loading skeletons */}
            {loading && (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="bg-white dark:bg-zinc-800 rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-700/60 shadow-xs animate-pulse"
                  >
                    <div className="aspect-[16/10] bg-zinc-200 dark:bg-zinc-700" />
                    <div className="p-4 space-y-3">
                      <div className="h-6 bg-zinc-200 dark:bg-zinc-700 rounded w-1/3" />
                      <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-3/4" />
                      <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Empty State */}
            {!loading && !error && properties.length === 0 && (
              <div className="py-16 px-4 text-center flex flex-col items-center">
                <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 mb-3">
                  <Inbox className="w-7 h-7" />
                </div>
                <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-200 mb-1">
                  No properties found
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-4">
                  We couldn't find any listings matching your current criteria. Try adjusting your filters or search keywords.
                </p>
                <button
                  type="button"
                  onClick={() => setFilters({ ...INITIAL_FILTERS, city: filters.city })}
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
                >
                  Reset All Filters
                </button>
              </div>
            )}

            {/* Feed Cards */}
            {!loading && !error && properties.length > 0 && (
              <div className="space-y-4">
                {properties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    onSelect={handleSelectProperty}
                    onToggleFavorite={handleToggleFavorite}
                    onTelegramContactDispatched={handleTelegramContactDispatched}
                  />
                ))}

                {/* Load More Button */}
                {page < totalPages && (
                  <div className="pt-2 pb-4 text-center">
                    <button
                      type="button"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="w-full py-3 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 text-xs font-bold rounded-xl transition-all shadow-xs flex items-center justify-center gap-2"
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-sky-500" />
                          <span>Loading more listings...</span>
                        </>
                      ) : (
                        <span>Load More Listings ({total - properties.length} remaining)</span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Map Tab */}
        {activeTab === 'map' && (
          <React.Suspense fallback={
            <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading map…
            </div>
          }>
            <MapView
              city={filters.city}
              onSelectProperty={openProperty}
              focusRequest={mapFocusRequest}
              onFocusHandled={() => setMapFocusRequest(null)}
              onBackToProperty={mapReturnProperty ? () => openProperty(mapReturnProperty) : undefined}
              onSelectLocation={(locationNames, clusterKey) => {
                // The map deliberately ignores feed filters. Start from that same
                // cohort to make the cluster count equal the resulting list total.
                setFilters({ ...INITIAL_FILTERS, city: filters.city, locations: locationNames, mapClusterKey: clusterKey ?? undefined });
                setActiveTab('feed');
              }}
            />
          </React.Suspense>
        )}

        {/* Saved / Favorites Tab */}
        {activeTab === 'saved' && (
          <div className="px-4 py-3 space-y-4">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <Heart className="w-4 h-4 text-rose-500 fill-rose-500" />
                <span>Saved Listings ({favorites.length})</span>
              </h2>
            </div>

            {favorites.length === 0 ? (
              <div className="py-20 text-center flex flex-col items-center">
                <div className="w-16 h-16 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center text-rose-500 mb-3">
                  <Heart className="w-8 h-8" />
                </div>
                <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-200 mb-1">
                  No saved properties yet
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-4">
                  Tap the heart icon on any listing card to save properties you like and compare them here.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('feed')}
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
                >
                  Explore Listings
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {favorites.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    onSelect={handleSelectProperty}
                    onToggleFavorite={handleToggleFavorite}
                    onTelegramContactDispatched={handleTelegramContactDispatched}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Property Detail Modal */}
      <PropertyDetailModal
        property={selectedProperty}
        onClose={closeProperty}
        onToggleFavorite={handleToggleFavorite}
        onShowOnMap={handleShowOnMap}
        onTelegramContactDispatched={handleTelegramContactDispatched}
        isAdmin={isAdmin}
        onReview={handleReview}
      />

      {/* Filter Drawer */}
      {isFilterOpen && (
        <FilterDrawer
          isOpen={isFilterOpen}
          onClose={() => setIsFilterOpen(false)}
          filters={filters}
          metadata={metadata}
          onApply={(newFilters) => setFilters({ ...newFilters, mapClusterKey: undefined })}
          isAdmin={isAdmin}
        />
      )}

      {/* Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={(tab) => {
          if (tab !== 'map') setMapReturnProperty(null);
          setActiveTab(tab);
        }}
        favoritesCount={favorites.length}
      />
    </div>
  );
};

export default App;
