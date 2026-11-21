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
import { isWebSurface } from './services/platform';
import { captureEvent, capturePageView } from './services/analytics';
import { readWebSavedRefs, setWebSavedRef } from './services/saved-store';
import {
  buildListingPath, closeListingInHistory, navigateToPublicTab, openListingInHistory,
  readPublicTab, subscribeToListingNavigation,
} from './services/web-navigation';
import { Header } from './components/Header';
import { PropertyCard } from './components/PropertyCard';
import { PropertyDetailModal } from './components/PropertyDetailModal';
import { FilterDrawer } from './components/FilterDrawer';
import { BottomNav } from './components/BottomNav';
import { PublicHeader } from './components/PublicHeader';
import { PublicHero } from './components/PublicHero';
import { PublicInfoSections } from './components/PublicInfoSections';
import { PublicFooter } from './components/PublicFooter';
import { Loader2, AlertCircle, Heart, Inbox, SlidersHorizontal } from 'lucide-react';
import { INITIAL_FILTERS, normalizeStoredFilters } from './filter-storage';

// Leaflet is only needed on the map tab, never on the initial feed load.
const MapView = React.lazy(async () => ({
  default: (await import('./components/MapView')).MapView,
}));

export const App: React.FC = () => {
  const isWeb = isWebSurface();
  // Telegram initialization + tracked-link attribution bootstrap
  // Reuse the in-flight request across React StrictMode effect replays.
  // Each effect attaches its own cancellable UI continuation.
  const trackingBootstrap = useRef<ReturnType<typeof trackMiniAppOpen> | null>(null);
  const [attribution, setAttribution] = useState<TrackingAttribution | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<PropertyDTO | null>(null);
  const detailRequestVersion = useRef(0);
  const lastNavigatedRef = useRef<string | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => isWeb ? readPublicTab() : 'feed');

  useEffect(() => {
    if (isWeb) return;
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
  }, [isWeb]);

  // In browser mode the address bar owns listing navigation, including direct
  // visits and Back/Forward. In Telegram the established tracked-link flow wins.
  useEffect(() => {
    if (!isWeb) return;
    let active = true;
    const unsubscribe = subscribeToListingNavigation((ref) => {
      capturePageView();
      const version = ++detailRequestVersion.current;
      setListingError(null);
      if (!ref) {
        setActiveTab(readPublicTab());
        lastNavigatedRef.current = null;
        setListingLoading(false);
        setSelectedProperty(null);
        return;
      }
      // A direct URL change may arrive while the previous detail is visible.
      // Keep the optimistic card on an in-app open only if it matches this URL.
      setSelectedProperty((current) => current?.publicRef === ref ? current : null);
      setListingLoading(true);
      if (lastNavigatedRef.current !== ref) {
        captureEvent('listing_opened', { listing_ref: ref, source: 'direct' });
        lastNavigatedRef.current = ref;
      }
      fetchPropertyById(ref)
        .then((property) => {
          if (!active || version !== detailRequestVersion.current) return;
          setSelectedProperty({ ...property, isFavorite: readWebSavedRefs().includes(ref) });
          setListingLoading(false);
        })
        .catch((err: unknown) => {
          if (!active || version !== detailRequestVersion.current) return;
          setSelectedProperty(null);
          setListingLoading(false);
          setListingError((err as { status?: number })?.status === 404
            ? 'This listing is no longer available.'
            : 'Could not open this listing. Please try again.');
        });
    });
    return () => { active = false; unsubscribe(); };
  }, [isWeb]);

  // Navigation & Filter states
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [metadata, setMetadata] = useState<FilterMetadata | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Resolve admin capability from the server (never trust client-side flags)
  useEffect(() => {
    if (isWeb) return;
    fetchMe()
      .then((me) => setIsAdmin(me.isAdmin))
      .catch((err) => console.error('Failed to fetch user info:', err));
  }, [isWeb]);

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
  const [retryRequest, setRetryRequest] = useState(0);
  const queryGeneration = useRef(0);
  const initialCatalogTracked = useRef(false);
  const loadMoreRequest = useRef<{ id: number; generation: number } | null>(null);
  const loadMoreRequestId = useRef(0);

  // Invalidate pagination synchronously when filters change so an old request
  // cannot append results between the render and the next fetch effect.
  useLayoutEffect(() => {
    queryGeneration.current += 1;
    loadMoreRequest.current = null;
  }, [filters, retryRequest]);

  // Modal & Favorites
  const [mapReturnProperty, setMapReturnProperty] = useState<PropertyDTO | null>(null);
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest | null>(null);
  const [favorites, setFavorites] = useState<PropertyDTO[]>([]);
  const [webSavedRefs, setWebSavedRefs] = useState<string[]>(() => isWeb ? readWebSavedRefs() : []);
  const [savedLoading, setSavedLoading] = useState(isWeb && readWebSavedRefs().length > 0);
  const savedRefSet = new Set(webSavedRefs);
  const withSaved = (property: PropertyDTO): PropertyDTO => isWeb && property.publicRef
    ? { ...property, isFavorite: savedRefSet.has(property.publicRef) }
    : property;

  useEffect(() => {
    if (!isWeb) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'homeasy_web_saved_v1') setWebSavedRefs(readWebSavedRefs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isWeb]);

  useEffect(() => {
    if (!isWeb) return;
    if (webSavedRefs.length === 0) {
      setFavorites([]);
      setSavedLoading(false);
      return;
    }
    let active = true;
    setSavedLoading(true);
    void Promise.allSettled(webSavedRefs.map((ref) => fetchPropertyById(ref)))
      .then((results) => {
        if (!active) return;
        const staleRefs: string[] = [];
        const resolved: PropertyDTO[] = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            resolved.push({ ...result.value, isFavorite: true });
          } else if ([404, 410].includes((result.reason as { status?: number })?.status ?? 0)) {
            staleRefs.push(webSavedRefs[index]);
          }
        });
        setFavorites(resolved);
        setSavedLoading(false);
        if (staleRefs.length) {
          for (const ref of staleRefs) setWebSavedRef(ref, false);
          setWebSavedRefs(readWebSavedRefs());
        }
      });
    return () => { active = false; };
  }, [isWeb, webSavedRefs]);

  // Feed, map and favorites contain a short photo preview. Hydrate the detail
  // modal on selection while guarding against late responses from older opens.
  const openProperty = (property: PropertyDTO) => {
    if (isWeb && property.publicRef) {
      setSelectedProperty(withSaved(property));
      setListingError(null);
      openListingInHistory(property.publicRef);
      return;
    }
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
    setListingError(null);
    setListingLoading(false);
    if (isWeb) closeListingInHistory();
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
    if (isWeb) return;
    try {
      const favs = await fetchFavorites();
      setFavorites(favs);
    } catch (err) {
      console.error('Failed to load favorites:', err);
    }
  }, [isWeb]);

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
            if (res.page === 1 && !initialCatalogTracked.current) {
              initialCatalogTracked.current = true;
              captureEvent('catalog_loaded', { city: filters.city, count: res.total });
            }
          })
          .catch((err) => {
            if (!active || queryGeneration.current !== generation) return;
            console.error('Failed to fetch properties:', err);
            const networkFailure = err instanceof TypeError
              && /failed to fetch|load failed|networkerror|network request failed/i.test(err.message);
            setError(networkFailure
              ? 'Could not connect to the server. Check your connection and try again.'
              : err instanceof Error ? err.message : 'Could not load properties. Please try again.');
            setLoading(false);
            captureEvent('client_error', { stage: 'catalog', code: networkFailure ? 'network' : 'request' });
          });
      },
      filters.query ? 300 : 0,
    );

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filters, isStorageReady, retryRequest]);

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
    if (isWeb) navigateToPublicTab('map', { replace: true });
    setActiveTab('map');
    captureEvent('map_opened', { city: property.city });
  };

  const handleToggleFavorite = async (identity: number | string) => {
    if (isWeb) {
      const matches = (p: PropertyDTO) => typeof identity === 'string'
        ? p.publicRef === identity : p.id === identity;
      const item = [selectedProperty, ...properties, ...favorites].find((p) => p && matches(p));
      const ref = item?.publicRef ?? (typeof identity === 'string' ? identity : null);
      if (!ref) return;
      const nextSaved = !webSavedRefs.includes(ref);
      const nextRefs = setWebSavedRef(ref, nextSaved);
      if (nextRefs.includes(ref) !== nextSaved) return;
      setWebSavedRefs(nextRefs);
      const updated = (p: PropertyDTO) => matches(p) ? { ...p, isFavorite: nextSaved } : p;
      setProperties((prev) => prev.map(updated));
      setFavorites((prev) => nextSaved
        ? prev.some(matches) ? prev.map(updated) : item ? [...prev, updated(item)] : prev
        : prev.filter((p) => !matches(p)));
      setSelectedProperty((prev) => prev && matches(prev) ? updated(prev) : prev);
      captureEvent(nextSaved ? 'favorite_added' : 'favorite_removed', { listing_ref: ref });
      return;
    }
    try {
      const result = await toggleFavorite(identity);
      captureEvent(result.isFavorite ? 'favorite_added' : 'favorite_removed', {
        listing_ref: typeof identity === 'string' ? identity : undefined,
      });
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
    if (isWeb) return;
    if (!property.publicRef) return;
    void recordTelegramContactDispatched(property.publicRef, filters)
      .catch((err) => console.error('[Interest] Failed to record Telegram contact:', err));
  }, [filters, isWeb]);

  const handleSelectProperty = (property: PropertyDTO, source: 'feed' | 'map' | 'saved' = 'feed') => {
    if (property.publicRef) {
      lastNavigatedRef.current = property.publicRef;
      if (source === 'map') captureEvent('map_marker_clicked', { listing_ref: property.publicRef });
      captureEvent('listing_opened', { listing_ref: property.publicRef, source });
    }
    openProperty(property);
    if (!property.publicRef || isWeb) return;
    void recordListingView(property.publicRef)
      .catch((err) => console.error('[Interest] Failed to record listing view:', err));
  };

  const handleShare = async (property: PropertyDTO) => {
    if (!property.publicRef) return;
    const shareUrl = new URL(buildListingPath(property.publicRef),
      isWeb ? window.location.origin : 'https://homeasy.rustycat.cc').href;
    try {
      if (navigator.share) {
        await navigator.share({ title: property.title, url: shareUrl });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        window.alert('Listing link copied to clipboard.');
      } else {
        window.prompt('Copy listing link:', shareUrl);
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') console.warn('Could not share:', error);
    }
  };

  const navigatePublic = (tab: ActiveTab, target = 'public-top') => {
    if (tab !== 'map') setMapReturnProperty(null);
    if (isWeb) navigateToPublicTab(tab);
    setActiveTab(tab);
    if (tab === 'map') captureEvent('map_opened', { city: filters.city });
    if (tab === 'saved') captureEvent('saved_opened', { count: favorites.length });
    // The destination may only mount after the tab changes.
    window.setTimeout(() => {
      const element = document.getElementById(target);
      element?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  return (
    <div id={isWeb ? 'public-top' : undefined} className={isWeb
      ? 'homeasy-public min-h-screen flex flex-col font-sans'
      : 'min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors'}>
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
      {isWeb ? (
        <PublicHeader
          activeTab={activeTab}
          savedCount={webSavedRefs.length}
          filterCount={activeFilterCount}
          onHome={() => navigatePublic('feed')}
          onBrowse={() => navigatePublic('feed', 'listings')}
          onMap={() => navigatePublic('map')}
          onSaved={() => navigatePublic('saved')}
          onAbout={() => navigatePublic('feed', 'about')}
          onOpenFilters={() => setIsFilterOpen(true)}
        />
      ) : (
        <Header
          wide={false}
          filters={filters}
          onFilterChange={(nextFilters) => setFilters({ ...nextFilters, mapClusterKey: undefined })}
          onOpenFilterDrawer={() => setIsFilterOpen(true)}
          activeFilterCount={activeFilterCount}
        />
      )}

      {/* Main Content Area based on Active Tab */}
      <main id={isWeb ? 'main-content' : undefined} tabIndex={isWeb ? -1 : undefined} className={isWeb ? 'public-main flex-1 w-full' : 'flex-1 w-full mx-auto pb-24 max-w-lg'}>
        {isWeb && activeTab === 'feed' && (
          <PublicHero
            filters={filters}
            onQueryChange={(query) => setFilters((previous) => ({ ...previous, query, mapClusterKey: undefined }))}
            onBrowse={() => navigatePublic('feed', 'listings')}
            onSearch={() => captureEvent('search_used', { source: 'hero' })}
            onMap={() => navigatePublic('map')}
            onOpenFilters={() => setIsFilterOpen(true)}
            total={total}
            loading={loading}
          />
        )}
        {activeTab === 'feed' && (
          <div id={isWeb ? 'listings' : undefined} className={isWeb ? 'public-listing-section space-y-5' : 'px-4 py-3 space-y-4'}>
            {isWeb && (
              <div className="public-catalog-heading">
                <div>
                  <span className="public-section-eyebrow">Thoughtfully sorted, freely explored</span>
                  <h2 className="public-section-title">Your next chapter starts here.</h2>
                  <p className="public-section-description">
                    Explore the latest property advertisements, save what catches your eye, and reach out when you find a match.
                  </p>
                </div>
                <button className="public-catalog-filter" type="button" onClick={() => setIsFilterOpen(true)}>
                  <SlidersHorizontal size={17} aria-hidden="true" /> Refine your search
                  {activeFilterCount > 0 && <span>({activeFilterCount})</span>}
                </button>
              </div>
            )}
            <div className={isWeb ? 'public-sort-toolbar' : 'space-y-2'}>
              <span id="feed-sort-label" className="px-1 text-xs font-bold uppercase tracking-wider text-zinc-400">
                Sort listings
              </span>
              <div role="group" aria-labelledby="feed-sort-label" className={isWeb ? 'public-sort-options' : 'grid grid-cols-3 gap-2'}>
                {[
                  { value: 'newest' as const, label: 'Newest' },
                  { value: 'price_asc' as const, label: 'Cheapest' },
                  { value: 'price_desc' as const, label: 'Most expensive' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={filters.sort === option.value}
                    onClick={() => {
                      if (filters.sort !== option.value) captureEvent('sort_changed', { sort: option.value });
                      setFilters((previous) => (previous.sort === option.value
                        ? previous : { ...previous, sort: option.value }));
                    }}
                    className={`${isWeb ? '' : 'py-2.5 rounded-xl text-xs font-semibold border transition-colors'} ${
                      isWeb ? '' : (
                      filters.sort === option.value
                        ? 'bg-sky-500 text-white border-sky-500'
                        : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                      )
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Status bar */}
            {!loading && !error && (
              <div className={isWeb ? 'public-results-line flex items-center justify-between' : 'flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 px-1'}>
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
              <div role="alert" className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 flex items-start gap-3 text-rose-700 dark:text-rose-300 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div className="space-y-3">
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={() => setRetryRequest((previous) => previous + 1)}
                    className="px-4 py-2 rounded-lg bg-rose-700 dark:bg-rose-500 text-white font-semibold hover:bg-rose-800 dark:hover:bg-rose-400"
                  >
                    Try again
                  </button>
                </div>
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
              <div className={isWeb ? 'grid gap-6 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-4'}>
                {properties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={withSaved(property)}
                    onSelect={(p) => handleSelectProperty(p, 'feed')}
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
                      className={`${isWeb ? 'public-load-more' : 'bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 text-xs rounded-xl shadow-xs'} w-full py-3 border font-bold transition-all flex items-center justify-center gap-2`}
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

        {isWeb && activeTab === 'feed' && (
          <PublicInfoSections
            onBrowse={() => navigatePublic('feed', 'listings')}
            onMap={() => navigatePublic('map')}
          />
        )}

        {/* Map Tab */}
        {activeTab === 'map' && (
          <div className={isWeb ? 'public-content-tab' : undefined}>
            {isWeb && (
              <div className="public-tab-intro">
                <span className="public-section-eyebrow">Discover the city</span>
                <h2 className="public-tab-title">Explore homes by location.</h2>
                <p className="public-section-description">Browse the neighbourhoods and see where available listings are located.</p>
              </div>
            )}
            <React.Suspense fallback={
              <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading map…
              </div>
            }>
              <MapView
                filters={filters}
                onSelectProperty={(p) => handleSelectProperty(p, 'map')}
                focusRequest={mapFocusRequest}
                onFocusHandled={() => setMapFocusRequest(null)}
                onBackToProperty={mapReturnProperty ? () => handleSelectProperty(mapReturnProperty, 'map') : undefined}
                onSelectLocation={(locationNames, clusterKey) => {
                  // Keep the map's filtered cohort and intersect it with this cluster.
                  // Location aliases are a fallback when the API has no cluster key.
                  setFilters((previous) => ({
                    ...previous,
                    locations: previous.locations.length > 0 ? previous.locations : locationNames,
                    mapClusterKey: clusterKey ?? undefined,
                  }));
                  if (isWeb) navigatePublic('feed', 'listings');
                  else setActiveTab('feed');
                }}
              />
            </React.Suspense>
          </div>
        )}

        {/* Saved / Favorites Tab */}
        {activeTab === 'saved' && (
          <div className={isWeb ? 'public-content-tab space-y-6' : 'px-4 py-3 space-y-4'}>
            <div className={isWeb ? 'public-tab-intro' : 'flex items-center justify-between px-1'}>
              {isWeb && <span className="public-section-eyebrow">Keep the good ones close</span>}
              <h2 className={isWeb ? 'public-tab-title flex items-center gap-3' : 'text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2'}>
                <Heart className="w-4 h-4 text-rose-500 fill-rose-500" />
                <span>{isWeb ? 'Your saved homes' : 'Saved Listings'} ({favorites.length})</span>
              </h2>
              {isWeb && <p className="public-section-description">Your shortlist stays in this browser, ready for another look.</p>}
            </div>

            {savedLoading ? (
              <div role="status" className="py-16 text-center text-sm text-zinc-500">Loading saved listings…</div>
            ) : favorites.length === 0 ? (
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
                  onClick={() => isWeb ? navigatePublic('feed', 'listings') : setActiveTab('feed')}
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
                >
                  Explore Listings
                </button>
              </div>
            ) : (
              <div className={isWeb ? 'grid gap-6 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-4'}>
                {favorites.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={withSaved(property)}
                    onSelect={(p) => handleSelectProperty(p, 'saved')}
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
      {isWeb && listingLoading && !selectedProperty && (
        <div role="status" className="fixed z-40 inset-x-4 top-24 max-w-md mx-auto p-5 rounded-2xl bg-white dark:bg-zinc-800 shadow-xl flex items-center gap-3">
          <Loader2 aria-hidden="true" className="w-5 h-5 animate-spin text-sky-600" />
          Opening listing...
        </div>
      )}
      {listingError && (
        <div role="alert" className="fixed z-40 inset-x-4 top-24 max-w-md mx-auto p-5 rounded-2xl bg-white dark:bg-zinc-800 border border-rose-300 shadow-xl">
          <p className="mb-3">{listingError}</p>
          <button type="button" className="text-sky-600 font-semibold" onClick={closeProperty}>Return to listings</button>
        </div>
      )}
      <PropertyDetailModal
        property={selectedProperty ? withSaved(selectedProperty) : null}
        onClose={closeProperty}
        onToggleFavorite={handleToggleFavorite}
        onShowOnMap={handleShowOnMap}
        onTelegramContactDispatched={handleTelegramContactDispatched}
        isAdmin={isAdmin}
        onReview={handleReview}
        onShare={handleShare}
      />

      {/* Filter Drawer */}
      {isFilterOpen && (
        <FilterDrawer
          isOpen={isFilterOpen}
          onClose={() => setIsFilterOpen(false)}
          filters={filters}
          metadata={metadata}
          onApply={(newFilters) => {
            captureEvent('filter_applied', {
              city: newFilters.city,
              location_count: newFilters.locations.length,
              has_price: Number(Boolean(newFilters.minPrice || newFilters.maxPrice)),
            });
            setFilters({ ...newFilters, mapClusterKey: undefined });
          }}
          isAdmin={isAdmin}
        />
      )}

      {isWeb ? (
        <PublicFooter
          onBrowse={() => navigatePublic('feed', 'listings')}
          onMap={() => navigatePublic('map')}
          onSaved={() => navigatePublic('saved')}
        />
      ) : (
        <>
          <BottomNav
            wide={false}
            activeTab={activeTab}
            onTabChange={(tab) => {
              if (tab !== 'map') setMapReturnProperty(null);
              setActiveTab(tab);
              if (tab === 'map') captureEvent('map_opened', { city: filters.city });
              if (tab === 'saved') captureEvent('saved_opened', { count: favorites.length });
            }}
            favoritesCount={favorites.length}
          />
          <footer className="pb-24 text-center text-xs text-zinc-500 dark:text-zinc-400 max-w-lg w-full mx-auto">
            <a className="underline underline-offset-4 hover:text-sky-600" href="/privacy">
              Privacy &amp; analytics settings
            </a>
          </footer>
        </>
      )}
    </div>
  );
};

export default App;
