import React, { useState } from 'react';
import { Heart, MapPin, Send, Phone, Waves, Zap, Droplets, Ban, Sparkles, MessageCircle } from 'lucide-react';
import type { PropertyDTO } from '../types';
import { triggerHaptic } from '../services/telegram';
import {
  getContactDiagnostics,
  logCanaryContactDiagnostic,
  onPhoneActionClick,
  openTelegramContact,
  phoneActionHrefFromDto,
  telegramActionHrefFromDto,
} from '../services/contact-actions';
import posthog from 'posthog-js';

interface PropertyCardProps {
  property: PropertyDTO;
  onSelect: (property: PropertyDTO) => void;
  onToggleFavorite: (propertyId: number) => void;
}

function sourceLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.includes('facebook.com') || url.includes('fb.com')) return 'Facebook';
  if (url.includes('khmer24.com')) return 'Khmer24';
  return null;
}

function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (isNaN(ts)) return null;
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

export const PropertyCard: React.FC<PropertyCardProps> = ({
  property,
  onSelect,
  onToggleFavorite,
}) => {
  const carouselRef = React.useRef<HTMLDivElement>(null);
  const [photoIndex, setPhotoIndex] = useState(0);
  const photos = property.photos && property.photos.length > 0 ? property.photos : [];
  const source = sourceLabel(property.originalUrl);
  const freshness = timeAgo(property.postedAt || property.createdAt);
  const telegramHref = telegramActionHrefFromDto(property.contact.telegramLink, property.contact.phone);
  const phoneHref = phoneActionHrefFromDto(property.contact.phoneLink, property.contact.phone);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!el.clientWidth) return;
    const newIdx = Math.round(el.scrollLeft / el.clientWidth);
    if (newIdx !== photoIndex && newIdx >= 0 && newIdx < photos.length) {
      setPhotoIndex(newIdx);
    }
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic('medium');
    onToggleFavorite(property.id);
  };

  const handleTelegramClick = (e: React.MouseEvent) => {
    if (telegramHref) {
      triggerHaptic('light');
      try {
        posthog.capture('contact_lead_clicked', { propertyId: property.id, channel: 'telegram' });
      } catch {
        // ignore
      }
      logCanaryContactDiagnostic(
        getContactDiagnostics(property.contact.phone, property.contact.telegramLink, property.contact.phoneLink),
        'telegram',
      );
      openTelegramContact(telegramHref, e);
    }
  };

  return (
    <article
      onClick={() => {
        triggerHaptic('light');
        onSelect(property);
      }}
      className="bg-white dark:bg-zinc-800/90 rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-700/60 shadow-xs hover:shadow-md transition-all active:scale-[0.99] cursor-pointer flex flex-col"
    >
      {/* Photo Carousel */}
      <div className="relative aspect-[16/10] w-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
        {photos.length > 0 ? (
          <div
            ref={carouselRef}
            onScroll={handleScroll}
            className="flex overflow-x-auto snap-x snap-mandatory touch-pan-x scrollbar-hide w-full h-full"
          >
            {photos.map((photoUrl, idx) => (
              <img
                key={idx}
                src={photoUrl}
                alt={`${property.title} - photo ${idx + 1}`}
                className="snap-center shrink-0 w-full h-full object-cover select-none pointer-events-none"
                loading={idx === 0 ? 'eager' : 'lazy'}
              />
            ))}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-400 text-xs">
            No Photos Available
          </div>
        )}

        {/* Favorite Button */}
        <button
          type="button"
          onClick={handleFavoriteClick}
          className="absolute top-3 right-3 w-9 h-9 rounded-full bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md flex items-center justify-center shadow-md transition-transform active:scale-80 z-10"
          aria-label="Save to favorites"
        >
          <Heart
            className={`w-5 h-5 transition-colors ${
              property.isFavorite
                ? 'fill-rose-500 text-rose-500'
                : 'text-zinc-700 dark:text-zinc-200'
            }`}
          />
        </button>

        {/* Property Type Badge */}
        <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white px-2.5 py-1 rounded-lg text-xs font-semibold tracking-wide pointer-events-none">
          {property.propertyType}
        </div>

        {/* Admin Review Badge (visible only to admins; pending/rejected items are never served publicly) */}
        {property.reviewStatus && property.reviewStatus !== 'approved' && (
          <div
            className={`absolute top-3 left-3 mt-8 backdrop-blur-md px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide pointer-events-none ${
              property.reviewStatus === 'pending'
                ? 'bg-amber-500/80 text-white'
                : 'bg-rose-600/80 text-white'
            }`}
          >
            {property.reviewStatus}
          </div>
        )}

        {/* Photo Indicators / Dots */}
        {photos.length > 1 && (
          <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/40 backdrop-blur-md px-2 py-1 rounded-full z-10">
            {photos.slice(0, 5).map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPhotoIndex(idx);
                  if (carouselRef.current) {
                    carouselRef.current.scrollTo({
                      left: idx * carouselRef.current.clientWidth,
                      behavior: 'smooth',
                    });
                  }
                }}
                className={`w-1.5 h-1.5 rounded-full transition-all ${
                  photoIndex === idx ? 'bg-white w-3' : 'bg-white/50'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Card Content */}
      <div className="p-3.5 flex flex-col flex-1">
        {/* Price & Location Header */}
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <div className="flex items-baseline gap-1">
            {property.priceUsd > 0 ? (
              <>
                <span className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                  ${property.priceUsd}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {property.type === 'rent' ? '/month' : ''}
                </span>
              </>
            ) : (
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-700/60 px-2 py-1 rounded-lg">
                Price on request
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[50%]">
            <MapPin className="w-3.5 h-3.5 shrink-0 text-sky-500" />
            <span className="truncate">{property.location || property.city}</span>
          </div>
        </div>

        {/* Title */}
        <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200 line-clamp-2 leading-snug mb-2.5">
          {property.title}
        </h3>

        {/* Source & freshness meta */}
        {(source || freshness) && (
          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2 flex items-center gap-1">
            {source && <span>{source}</span>}
            {source && freshness && <span>·</span>}
            {freshness && <span>posted {freshness}</span>}
          </div>
        )}

        {/* Specs & Amenities Pills */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
          {property.bedrooms !== null && (
            <span className="bg-zinc-100 dark:bg-zinc-700/60 px-2 py-0.5 rounded-md">
              🛏 {property.bedrooms === 0 ? 'Studio' : `${property.bedrooms} BR`}
            </span>
          )}
          {property.bathrooms !== null && (
            <span className="bg-zinc-100 dark:bg-zinc-700/60 px-2 py-0.5 rounded-md">
              🚿 {property.bathrooms} Bath
            </span>
          )}
          {property.hasPool && (
            <span className="inline-flex items-center gap-1 bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 px-2 py-0.5 rounded-md">
              <Waves className="w-3 h-3 text-sky-500" /> Pool
            </span>
          )}
          {property.specs.electricity && (
            <span className="inline-flex items-center gap-1 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-md">
              <Zap className="w-3 h-3 text-amber-500" /> {property.specs.electricity.replace('Fixed Rate ', '')}
            </span>
          )}
          {property.specs.water && (
            <span className="inline-flex items-center gap-1 bg-cyan-50 dark:bg-cyan-950/60 text-cyan-700 dark:text-cyan-300 px-2 py-0.5 rounded-md">
              <Droplets className="w-3 h-3 text-cyan-500" /> {property.specs.water}
            </span>
          )}
          {property.specs.cleaning && (
            <span className="inline-flex items-center gap-1 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded-md">
              <Sparkles className="w-3 h-3 text-emerald-500" /> Cleaning
            </span>
          )}
          {property.specs.restrictions.length > 0 && (
            <span className="inline-flex items-center gap-1 bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded-md">
              <Ban className="w-3 h-3 text-rose-500" /> {property.specs.restrictions[0]}
            </span>
          )}
        </div>

        {/* Quick Contact Buttons */}
        {(telegramHref || property.contact.phone || property.originalUrl) && (
          <div className="mt-auto pt-2 border-t border-zinc-100 dark:border-zinc-700/50 flex items-center gap-2">
            {telegramHref ? (
              <button
                type="button"
                onClick={handleTelegramClick}
                className="flex-1 bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-xs active:scale-98"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Message Agent</span>
              </button>
            ) : property.originalUrl ? (
              <a
                href={property.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex-1 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-xs font-medium py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all"
              >
                <span>View Original Post ↗</span>
              </a>
            ) : null}

            {property.contact.whatsappLink && (
              <a
                href={property.contact.whatsappLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                  triggerHaptic('light');
                }}
                className="p-2 bg-zinc-100 dark:bg-zinc-700 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-200 rounded-xl transition-all active:scale-95 flex items-center justify-center"
                aria-label="WhatsApp Agent"
              >
                <MessageCircle className="w-4 h-4 text-emerald-500" />
              </a>
            )}

            {phoneHref && (
              <a
                href={phoneHref}
                onClick={(e) => {
                  onPhoneActionClick(e);
                  triggerHaptic('light');
                  try {
                    posthog.capture('contact_lead_clicked', { propertyId: property.id, channel: 'phone' });
                  } catch {
                    // ignore
                  }
                  logCanaryContactDiagnostic(
                    getContactDiagnostics(property.contact.phone, property.contact.telegramLink, property.contact.phoneLink),
                    'phone',
                  );
                }}
                className="p-2 bg-zinc-100 dark:bg-zinc-700 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-200 rounded-xl transition-all active:scale-95"
                aria-label="Call Agent"
              >
                <Phone className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </a>
            )}
            {property.contact.phone && (
              <span className="min-w-0 truncate text-[11px] text-zinc-500 dark:text-zinc-400 select-all" aria-label="Phone number">
                {property.contact.phone}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
};
