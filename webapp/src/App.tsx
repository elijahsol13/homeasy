import React, { useState, useEffect, useCallback } from 'react';
import type {
  ActiveTab,
  FilterMetadata,
  FilterState,
  PropertyDTO,
} from './types';
import {
  fetchProperties,
  fetchFilterMetadata,
  fetchFavorites,
  toggleFavorite,
} from './services/api';
import { initTelegramWebApp } from './services/telegram';
import { Header } from './components/Header';
import { PropertyCard } from './components/PropertyCard';
import { PropertyDetailModal } from './components/PropertyDetailModal';
import { FilterDrawer } from './components/FilterDrawer';
import { MapView } from './components/MapView';
import { BottomNav } from './components/BottomNav';
import { Loader2, AlertCircle, Heart, Inbox } from 'lucide-react';

const INITIAL_FILTERS: FilterState = {
  city: 'siem_reap',
  locations: [],
  type: 'rent',
  sort: 'newest',
};

export const App: React.FC = () => {
  // Telegram initialization
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  // Navigation & Filter states
  const [activeTab, setActiveTab] = useState<ActiveTab>('feed');
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [metadata, setMetadata] = useState<FilterMetadata | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  // Restore saved filter state on mount (anti-flicker)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('homeasy_filters');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          setFilters((prev) => ({ ...prev, ...parsed }));
        }
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

  // Modal & Favorites
  const [selectedProperty, setSelectedProperty] = useState<PropertyDTO | null>(null);
  const [favorites, setFavorites] = useState<PropertyDTO[]>([]);

  // Count active non-default filters
  const activeFilterCount = [
    filters.locations.length > 0,
    Boolean(filters.category),
    filters.type !== 'rent',
    Boolean(filters.minPrice),
    Boolean(filters.maxPrice),
    Boolean(filters.bedrooms && filters.bedrooms.length > 0),
    Boolean(filters.hasPool),
    Boolean(filters.minLeaseMax),
    Boolean(filters.query && filters.query.trim().length > 0),
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
    setLoading(true);
    setError(null);
    setPage(1);

    const timer = setTimeout(
      () => {
        fetchProperties(filters, 1, 20)
          .then((res) => {
            if (!active) return;
            setProperties(res.items);
            setTotal(res.total);
            setTotalPages(res.totalPages);
            setLoading(false);
          })
          .catch((err) => {
            if (!active) return;
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
  }, [filters]);

  // Load more pages
  const handleLoadMore = async () => {
    if (loadingMore || page >= totalPages) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const res = await fetchProperties(filters, nextPage, 20);
      setProperties((prev) => [...prev, ...res.items]);
      setPage(nextPage);
    } catch (err) {
      console.error('Failed to load more:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Toggle favorite
  const handleToggleFavorite = async (propertyId: number) => {
    try {
      const result = await toggleFavorite(propertyId);
      // Update in feed
      setProperties((prev) =>
        prev.map((p) =>
          p.id === propertyId ? { ...p, isFavorite: result.isFavorite } : p,
        ),
      );
      // Update in modal if opened
      setSelectedProperty((prev) =>
        prev && prev.id === propertyId
          ? { ...prev, isFavorite: result.isFavorite }
          : prev,
      );
      // Refresh favorites list
      loadFavorites();
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors">
      {/* Top Header with City switcher & search */}
      <Header
        filters={filters}
        onFilterChange={setFilters}
        onOpenFilterDrawer={() => setIsFilterOpen(true)}
        activeFilterCount={activeFilterCount}
      />

      {/* Main Content Area based on Active Tab */}
      <main className="flex-1 max-w-lg w-full mx-auto pb-24">
        {activeTab === 'feed' && (
          <div className="px-4 py-3 space-y-4">
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
            {!loading && properties.length > 0 && (
              <div className="space-y-4">
                {properties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    onSelect={setSelectedProperty}
                    onToggleFavorite={handleToggleFavorite}
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
          <MapView
            city={filters.city}
            onSelectProperty={setSelectedProperty}
            onSelectLocation={(locationName) => {
              setFilters((prev) => ({ ...prev, locations: [locationName] }));
              setActiveTab('feed');
            }}
          />
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
                    onSelect={setSelectedProperty}
                    onToggleFavorite={handleToggleFavorite}
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
        onClose={() => setSelectedProperty(null)}
        onToggleFavorite={handleToggleFavorite}
      />

      {/* Filter Drawer */}
      <FilterDrawer
        isOpen={isFilterOpen}
        onClose={() => setIsFilterOpen(false)}
        filters={filters}
        metadata={metadata}
        onApply={(newFilters) => setFilters(newFilters)}
      />

      {/* Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        favoritesCount={favorites.length}
      />
    </div>
  );
};

export default App;
