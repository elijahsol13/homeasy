import React, { useState } from 'react';
import {
  X,
  Heart,
  MapPin,
  Send,
  Waves,
  Zap,
  Droplets,
  Ban,
  Sparkles,
  ExternalLink,
  Map,
  MessageCircle,
  Phone,
  Copy,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { PropertyDTO } from '../types';
import { triggerHaptic, openExternalUrl } from '../services/telegram';
import { copyPhoneNumber, onPhoneActionClick, openTelegramContact, phoneActionHref } from '../services/contact-actions';
import { captureEvent } from '../services/analytics';
import { formatPropertyTypeLabel } from '../formatters';
import { PhotoWithFallback } from './PhotoWithFallback';

interface PropertyDetailModalProps {
  property: PropertyDTO | null;
  onClose: () => void;
  onToggleFavorite: (identity: number | string) => void;
  onShowOnMap: (property: PropertyDTO) => void;
  onTelegramContactDispatched?: (property: PropertyDTO) => void;
  isAdmin?: boolean;
  onReview?: (property: PropertyDTO, action: 'approve' | 'reject') => Promise<void>;
}

type Landmark = PropertyDTO['specs']['landmarks'][number];
type DisplayLandmark = Landmark & { sourceClaim?: string };

// The stored arrays preserve the model's original claims. Only derive presentation
// groups here; a proximity phrase is not, by itself, an advertising claim.
const touristDestination = (text: string): string[] => {
  const destinations: string[] = [];
  if (/\b(?:pub\s*[- ]?\s*street|pa[pt]\s*street|pup\s*street)\b/i.test(text)) destinations.push('pub street');
  if (/\b(?:old\s+(?:pub\s+)?market)\b|ផ្សារចាស់/i.test(text)) destinations.push('old market');
  if (/\bnight\s+market\b/i.test(text)) destinations.push('night market');
  if (/\bangkor\s+wat\b/i.test(text)) destinations.push('angkor wat');
  return destinations;
};

const placeKey = (text: string) => text.replace(/\s*\([^)]*\broad\)\s*$/i, '').normalize('NFKD').toLowerCase()
  .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const isGenericPlace = (value: string) => /^(?:(?:near|next\s+to|close\s+to|behind)\s+)?(?:the\s+)?(?:river(?:\s*side)?|city\s+center|siem\s+reap(?:\s+city)?\s+center|local\s+market|market|school|hotel|university|supermarket|showroom|airport|bridge|shops?|restaurants?)$/i.test(value.trim());

function specificNonTouristPlace(raw: string): string | null {
  // Remove ONLY recognizable proximity wording. Unrecognized claims remain in
  // the original source; don't fabricate a POI or map a generic facility.
  let name = raw.trim()
    .replace(/^(?:close\s+to|next\s+to|near|behind|south\s+of)\s+/i, '')
    .replace(/^(?:(?:approximately|about|around|only)\s+)?\d+(?:[.,]\d+)?\s*(?:km|kilometers?|met(?:er|re)s?|mins?|minutes?)\s*(?:\([^)]*\)\s*)?(?:(?:walk|drive|driving|by\s+\w+|south|north|east|west)\s*)?(?:(?:away|distance)\s*)?(?:(?:to|from|of|near)\s+)?/i, '')
    .replace(/\s*(?::|–|-)\s*\d+(?:[.,]\d+)?\s*(?:km|m|minutes?|mins?)\s*$/i, '')
    .replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*(?:km|m)\s*\)\s*$/i, '')
    .trim();
  // Some ads use "3 minutes south of ..."; leave the original description
  // intact, while linking only to the explicitly named place.
  name = name.replace(/^(?:south|north|east|west)\s+of\s+/i, '');
  const named = /\b(?:university|hotel|supermarket|showroom|shrine|airport|bridge|national\s+road\s*\d+|borey|phsar\s+[a-z]+|(?:angkor|central|russian|kralanh|leu|choa\s+sanghok)\s+market(?:\s*\d+)?)\b/i;
  if (!named.test(name) || isGenericPlace(name) || /\b(?:shops|caf[eé]s|daily necessities|restaurants)\b/i.test(name)) return null;
  return name;
}

function visibleLandmarks(specs: PropertyDTO['specs'], city: string) {
  const nearby: DisplayLandmark[] = [];
  const advertised: Landmark[] = [];
  const nearbyKeys = new Set<string>();
  const advertisedKeys = new Set<string>();
  const promotedDestinations = new Set(specs.marketingLandmarks.flatMap((l) => touristDestination(l.name)));

  const addNearby = (place: DisplayLandmark) => {
    const key = placeKey(place.name);
    if (key && !nearbyKeys.has(key)) { nearbyKeys.add(key); nearby.push({ ...place }); }
  };
  for (const place of specs.landmarks) {
    const targets = touristDestination(place.name);
    if (!isGenericPlace(place.name) && !(targets.length && targets.every((destination) => promotedDestinations.has(destination)))) {
      addNearby(place);
    }
  }
  for (const place of specs.marketingLandmarks) {
    const sourceClaim = place.name.trim();
    if (!sourceClaim) continue;
    if (touristDestination(sourceClaim).length) {
      const key = placeKey(sourceClaim);
      if (!advertisedKeys.has(key)) { advertisedKeys.add(key); advertised.push(place); }
      continue;
    }
    const name = specificNonTouristPlace(sourceClaim);
    if (!name) continue;
    const key = placeKey(name);
    if (nearbyKeys.has(key)) {
      const existing = nearby.find((item) => placeKey(item.name) === key);
      if (existing && !existing.sourceClaim) existing.sourceClaim = sourceClaim;
    } else {
      addNearby({
        ...place,
        name,
        sourceClaim,
        link: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${city === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap'}, Cambodia`)}`,
      });
    }
  }
  return { nearby, advertised };
}

export const PropertyDetailModal: React.FC<PropertyDetailModalProps> = ({
  property,
  onClose,
  onToggleFavorite,
  onShowOnMap,
  onTelegramContactDispatched,
  isAdmin = false,
  onReview,
}) => {
  const [activePhoto, setActivePhoto] = useState(0);
  const [reviewBusy, setReviewBusy] = useState<'approve' | 'reject' | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const carouselRef = React.useRef<HTMLDivElement>(null);
  const lightboxRef = React.useRef<HTMLDivElement>(null);
  const propertyId = property?.id;

  React.useEffect(() => {
    setActivePhoto(0);
    setReviewBusy(null);
    setLightboxOpen(false);
  }, [propertyId]);

  // Sync lightbox scroll position to the photo that was tapped
  React.useEffect(() => {
    if (lightboxOpen && lightboxRef.current) {
      lightboxRef.current.scrollTo({ left: activePhoto * lightboxRef.current.clientWidth });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxOpen]);

  const scrollCarouselTo = (ref: React.RefObject<HTMLDivElement | null>, index: number) => {
    const el = ref.current;
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
  };

  const handleCarouselScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!el.clientWidth) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    const total = property?.photos?.length ?? 0;
    if (idx !== activePhoto && idx >= 0 && idx < total) setActivePhoto(idx);
  };

  const handleReview = (action: 'approve' | 'reject') => {
    if (!onReview || reviewBusy) return;
    setReviewBusy(action);
    void onReview(property!, action).finally(() => setReviewBusy(null));
  };

  if (!property) return null;

  const photos = property.photos && property.photos.length > 0 ? property.photos : [];
  const { nearby: nearbyLandmarks, advertised: advertisedLandmarks } = visibleLandmarks(property.specs, property.city);

  const effectiveMapsUrl =
    property.mapsUrl ||
    (property.coordinates
      ? `https://www.google.com/maps/search/?api=1&query=${property.coordinates.lat},${property.coordinates.lng}`
      : property.location
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            `${property.location}, ${property.city === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap'}, Cambodia`,
          )}`
        : null);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end sm:justify-center sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-zinc-900 w-full max-w-2xl max-h-[92vh] sm:rounded-3xl rounded-t-3xl overflow-hidden flex flex-col shadow-2xl relative">
        {/* Fixed Close & Favorite buttons — stay visible while content scrolls */}
        <div className="absolute top-4 inset-x-4 flex items-center justify-between z-20 pointer-events-none">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/70 active:scale-95 transition-all pointer-events-auto"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('medium');
              onToggleFavorite(property.publicRef ?? property.id);
            }}
            className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/70 active:scale-95 transition-all pointer-events-auto"
            aria-label="Favorite"
          >
            <Heart
              className={`w-5 h-5 ${
                property.isFavorite ? 'fill-rose-500 text-rose-500' : 'text-white'
              }`}
            />
          </button>
        </div>

        {/* Scrollable Content — photo carousel scrolls away with the body */}
        <div className="overflow-y-auto flex-1">
          {/* Swipeable Photo Carousel */}
          <div className="relative aspect-[16/10] w-full bg-zinc-100 dark:bg-zinc-800">
            {photos.length > 0 ? (
              <>
                <div
                  ref={carouselRef}
                  onScroll={handleCarouselScroll}
                  className="flex overflow-x-auto snap-x snap-mandatory touch-pan-x scrollbar-hide w-full h-full"
                >
                  {photos.map((src, idx) => (
                    <PhotoWithFallback
                      key={idx}
                      src={src}
                      alt={`${property.title} - photo ${idx + 1}`}
                      onClick={() => {
                        triggerHaptic('light');
                        setActivePhoto(idx);
                        setLightboxOpen(true);
                      }}
                      className="snap-center shrink-0 w-full h-full object-cover select-none cursor-zoom-in"
                      draggable={false}
                    />
                  ))}
                </div>

                {/* Desktop arrows */}
                {photos.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => scrollCarouselTo(carouselRef, Math.max(0, activePhoto - 1))}
                      className="hidden sm:flex absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md text-white items-center justify-center hover:bg-black/70 transition-all"
                      aria-label="Previous photo"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollCarouselTo(carouselRef, Math.min(photos.length - 1, activePhoto + 1))}
                      className="hidden sm:flex absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md text-white items-center justify-center hover:bg-black/70 transition-all"
                      aria-label="Next photo"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </>
                )}

                {/* Photo count badge */}
                {photos.length > 1 && (
                  <div className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md text-white text-xs font-semibold px-2.5 py-1 rounded-lg pointer-events-none">
                    {activePhoto + 1} / {photos.length}
                  </div>
                )}
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-zinc-400">
                No Photos
              </div>
            )}
          </div>

          {/* Thumbnail strip */}
          {photos.length > 1 && (
            <div className="flex items-center gap-2 p-2 px-4 bg-zinc-50 dark:bg-zinc-800/50 overflow-x-auto no-scrollbar border-b border-zinc-100 dark:border-zinc-800">
              {photos.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    setActivePhoto(i);
                    scrollCarouselTo(carouselRef, i);
                  }}
                  className={`w-14 h-14 rounded-lg overflow-hidden shrink-0 border-2 transition-all ${
                    activePhoto === i ? 'border-sky-500 scale-105' : 'border-transparent opacity-60'
                  }`}
                >
                  <PhotoWithFallback src={src} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <div className="p-4 sm:p-6 space-y-5">
          {/* Header Title & Price */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-sky-100 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 text-xs font-bold px-2.5 py-1 rounded-md uppercase tracking-wider">
                {formatPropertyTypeLabel(property.propertyType)}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">
                {property.type === 'rent' ? 'For Rent' : 'For Sale'}
              </span>
            </div>

            <h2 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
              {property.title}
            </h2>

            <div className="flex items-baseline gap-2 mt-2">
              {property.priceUsd > 0 ? (
                <>
                  <span className="text-3xl font-extrabold text-zinc-900 dark:text-zinc-50">
                    ${property.priceUsd}
                  </span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    {property.type === 'rent' ? '/month' : ''}
                  </span>
                </>
              ) : (
                <span className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded-lg">
                  Price not specified
                </span>
              )}
            </div>
          </div>

          {/* Location & Maps Button */}
          <div className="p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-100 dark:border-zinc-800 space-y-3">
            <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <MapPin className="w-4 h-4 text-sky-500 shrink-0" />
              <div>
                <div>{property.location || property.city}, Cambodia</div>
                <div className="text-[11px] text-zinc-400">
                  {property.coordinatePrecision === 'exact'
                    ? 'Exact location supplied'
                    : property.coordinatePrecision === 'district'
                      ? 'Approximate district location'
                      : 'City-level only · area not confirmed'}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('medium');
                  onShowOnMap(property);
                }}
                className="flex-1 px-3 py-2 bg-sky-500 hover:bg-sky-600 text-white text-xs font-bold rounded-lg active:scale-95 transition-all flex items-center justify-center gap-1.5"
              >
                <Map className="w-4 h-4" />
                HomEasy Map
              </button>
              {effectiveMapsUrl && (
                <a
                  href={effectiveMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => openExternalUrl(effectiveMapsUrl, e)}
                  className="px-3 py-2 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-xs font-bold rounded-lg active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  External
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>

          {/* Quick Specs Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {property.bedrooms !== null && (
              <div className="p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-100 dark:border-zinc-800">
                <span className="text-xs text-zinc-400 block">Bedrooms</span>
                <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                  {property.bedrooms === 0 ? 'Studio' : `${property.bedrooms} BR`}
                </span>
              </div>
            )}
            {property.bathrooms !== null && (
              <div className="p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-100 dark:border-zinc-800">
                <span className="text-xs text-zinc-400 block">Bathrooms</span>
                <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                  {property.bathrooms} Bath
                </span>
              </div>
            )}
          </div>

          {/* State only verified rental terms; a one-month deposit does not imply a cash amount. */}
          {(property.depositUsd !== null || property.depositMonths != null || property.minLeaseMonths !== null) && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">Rental Terms</h3>
              <div className="grid grid-cols-2 gap-2.5">
                {(property.depositUsd !== null || property.depositMonths != null) && (
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-100 dark:border-zinc-800">
                    <span className="text-xs text-zinc-400 block">Deposit</span>
                    <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                      {property.depositUsd !== null ? `$${property.depositUsd}` : `${property.depositMonths} ${property.depositMonths === 1 ? 'month' : 'months'}`}
                    </span>
                  </div>
                )}
                {property.minLeaseMonths !== null && (
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-100 dark:border-zinc-800">
                    <span className="text-xs text-zinc-400 block">Min. Lease</span>
                    <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                      {property.minLeaseMonths} months
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Utility charging terms are key rental costs, shown apart from amenity/filter chips. */}
          {(property.specs.electricity || property.specs.water) && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Utility Rates
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {property.specs.electricity && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-50/70 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200">
                    <Zap className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>Electricity: {property.specs.electricity}</span>
                  </div>
                )}
                {property.specs.water && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-cyan-50/70 dark:bg-cyan-950/40 text-cyan-900 dark:text-cyan-200">
                    <Droplets className="w-4 h-4 text-cyan-500 shrink-0" />
                    <span>Water: {property.specs.water}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Other amenities remain separate from rental charges. */}
          {(property.hasPool || property.specs.cleaning || property.specs.amenities.length > 0) && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Amenities & Services
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {property.hasPool && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-sky-50/70 dark:bg-sky-950/40 text-sky-900 dark:text-sky-200">
                    <Waves className="w-4 h-4 text-sky-500 shrink-0" />
                    <span>Swimming Pool</span>
                  </div>
                )}
                {property.specs.cleaning && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200">
                    <Sparkles className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>{property.specs.cleaning}</span>
                  </div>
                )}
              </div>

              {/* Amenities chips */}
              {property.specs.amenities.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {property.specs.amenities.map((a, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-[11px] font-medium"
                    >
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* House Rules & Restrictions */}
          {property.specs.restrictions.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Restrictions
              </h3>
              <div className="flex flex-wrap gap-2">
                {property.specs.restrictions.map((res, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 text-xs font-semibold"
                  >
                    <Ban className="w-3.5 h-3.5 text-rose-500" />
                    <span>{res}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Landmarks */}
          {nearbyLandmarks.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Nearby Landmarks
              </h3>
              <div className="flex flex-wrap gap-2">
                {nearbyLandmarks.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => openExternalUrl(l.link)}
                    title={l.sourceClaim ? `Unverified advertiser wording: ${l.sourceClaim}` : undefined}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-medium hover:bg-zinc-200 transition-colors"
                  >
                    <span>🚩 {l.name}</span>
                    <ExternalLink className="w-3 h-3 text-zinc-400" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Advertised Nearby (marketing claims — unverified) */}
          {advertisedLandmarks.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Advertised Nearby
              </h3>
              <div className="flex flex-wrap gap-2">
                {advertisedLandmarks.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => openExternalUrl(l.link)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    <span>📣 {l.name}</span>
                    <ExternalLink className="w-3 h-3 text-zinc-400" />
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-400">
                Proximity claimed by the advertiser — not verified.
              </p>
            </div>
          )}

          {/* Full Description */}
          {property.description && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Description
              </h3>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed whitespace-pre-line">
                {property.description}
              </p>
            </div>
          )}

          {/* Admin review info — non-approved items are only served to admins */}
          {property.reviewStatus && property.reviewStatus !== 'approved' && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-1.5">
              <h3 className="text-xs font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider">
                Moderation Info
              </h3>
              {property.reviewStatus && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Status: <strong>{property.reviewStatus}</strong>
                </p>
              )}
              {property.reviewReason && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Reason: {property.reviewReason}
                </p>
              )}
              {property.parseWarnings && property.parseWarnings.length > 0 && (
                <ul className="text-[11px] text-amber-600 dark:text-amber-400 list-disc list-inside">
                  {property.parseWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {isAdmin && property.reviewStatus === 'pending' && onReview && (
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    disabled={reviewBusy !== null}
                    onClick={() => handleReview('approve')}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white text-xs font-bold py-2 px-3 rounded-xl transition-all active:scale-98"
                  >
                    {reviewBusy === 'approve' ? 'Approving…' : 'Approve & Publish'}
                  </button>
                  <button
                    type="button"
                    disabled={reviewBusy !== null}
                    onClick={() => handleReview('reject')}
                    className="flex-1 bg-rose-500 hover:bg-rose-600 disabled:opacity-60 text-white text-xs font-bold py-2 px-3 rounded-xl transition-all active:scale-98"
                  >
                    {reviewBusy === 'reject' ? 'Rejecting…' : 'Reject'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Original Source Link */}
          {property.originalUrl && (
            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 text-xs text-zinc-400 flex items-center gap-1.5">
              <span>Source:</span>
              <a
                href={property.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => openExternalUrl(property.originalUrl!, e)}
                className="text-sky-500 hover:underline font-medium flex items-center gap-1 cursor-pointer"
              >
                <span>View Original Listing</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
          </div>
        </div>

        {/* Fullscreen photo lightbox */}
        {lightboxOpen && photos.length > 0 && (
          <div
            className="absolute inset-0 z-30 bg-black/95 flex flex-col"
            onClick={() => setLightboxOpen(false)}
          >
            <div className="flex items-center justify-between p-4 shrink-0">
              <span className="text-white/80 text-sm font-semibold">
                {activePhoto + 1} / {photos.length}
              </span>
              <button
                type="button"
                onClick={() => setLightboxOpen(false)}
                className="w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-all"
                aria-label="Close photos"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div
              ref={lightboxRef}
              onScroll={handleCarouselScroll}
              onClick={(e) => e.stopPropagation()}
              className="flex overflow-x-auto snap-x snap-mandatory touch-pan-x scrollbar-hide flex-1 items-center"
            >
              {photos.map((src, idx) => (
                <div key={idx} className="snap-center shrink-0 w-full h-full flex items-center justify-center px-2">
                  <PhotoWithFallback
                    src={src}
                    alt={`${property.title} - photo ${idx + 1}`}
                    className="max-w-full max-h-full object-contain select-none"
                    draggable={false}
                  />
                </div>
              ))}
            </div>
            {photos.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollCarouselTo(lightboxRef, Math.max(0, activePhoto - 1));
                  }}
                  className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 transition-all"
                  aria-label="Previous photo"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollCarouselTo(lightboxRef, Math.min(photos.length - 1, activePhoto + 1));
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 transition-all"
                  aria-label="Next photo"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}
          </div>
        )}

        {/* Sticky Contact Bottom Bar */}
        <div className="shrink-0 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800">
          {property.contact.phone && (
            <div className="px-4 pt-3 flex items-center justify-between gap-3 text-sm">
              <span className="text-zinc-700 dark:text-zinc-200 select-all">{property.contact.phone}</span>
              <button
                type="button"
                onClick={(e) => void copyPhoneNumber(property.contact.phone, e)}
                className="inline-flex items-center gap-1.5 text-sky-600 dark:text-sky-400 font-medium"
                aria-label="Copy phone number"
              >
                <Copy className="w-4 h-4" /> Copy
              </button>
            </div>
          )}
          <div className="p-4 flex items-center gap-3">
          {property.contact.telegramLink ? (
            <button
              type="button"
              onClick={(e) => {
                triggerHaptic('light');
                try {
                  captureEvent('contact_lead_clicked', { propertyId: property.id, channel: 'telegram' });
                } catch {
                  // ignore
                }
                onTelegramContactDispatched?.(property);
                openTelegramContact(property.contact.telegramLink!, e);
              }}
              className="flex-1 bg-sky-500 hover:bg-sky-600 text-white font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-2 shadow-md active:scale-98 transition-all"
            >
              <Send className="w-4 h-4" />
              <span>Chat in Telegram</span>
            </button>
          ) : property.originalUrl ? (
            <a
              href={property.originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => openExternalUrl(property.originalUrl!, e)}
              className="flex-1 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-2 active:scale-98 transition-all text-sm cursor-pointer"
            >
              <span>View Original Listing ↗</span>
            </a>
          ) : null}

          {property.contact.whatsappLink && (
            <a
              href={property.contact.whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                triggerHaptic('light');
                try {
                  captureEvent('contact_lead_clicked', { propertyId: property.id, channel: 'whatsapp' });
                } catch {
                  // ignore
                }
                openExternalUrl(property.contact.whatsappLink!, e);
              }}
              className="p-3 bg-emerald-50 dark:bg-emerald-950/50 hover:bg-emerald-100 text-emerald-600 dark:text-emerald-400 rounded-xl shadow-xs active:scale-95 transition-all flex items-center justify-center cursor-pointer"
              aria-label="WhatsApp"
            >
              <MessageCircle className="w-5 h-5" />
            </a>
          )}

          {property.contact.phoneLink && phoneActionHref(property.contact.phoneLink) && (
            <a
              href={phoneActionHref(property.contact.phoneLink)!}
              onClick={(e) => {
                onPhoneActionClick(e);
                triggerHaptic('light');
                try {
                  captureEvent('contact_lead_clicked', { propertyId: property.id, channel: 'phone' });
                } catch {
                  // ignore
                }
              }}
              className="p-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl shadow-md active:scale-95 transition-all flex items-center justify-center"
              aria-label="Call"
            >
              <Phone className="w-5 h-5" />
            </a>
          )}

          {effectiveMapsUrl && (
            <a
              href={effectiveMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => openExternalUrl(effectiveMapsUrl, e)}
              className="p-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 rounded-xl active:scale-95 transition-all flex items-center justify-center cursor-pointer"
              aria-label="Google Maps"
            >
              <Map className="w-5 h-5 text-sky-500" />
            </a>
          )}
          </div>
        </div>
      </div>
    </div>
  );
};
