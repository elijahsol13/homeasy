import React, { useState } from 'react';
import { Heart, MapPin, Send, Phone, Waves, Zap, Droplets, Ban, Sparkles } from 'lucide-react';
import type { PropertyDTO } from '../types';
import { triggerHaptic, openExternalUrl } from '../services/telegram';
import posthog from 'posthog-js';

interface PropertyCardProps {
  property: PropertyDTO;
  onSelect: (property: PropertyDTO) => void;
  onToggleFavorite: (propertyId: number) => void;
}

export const PropertyCard: React.FC<PropertyCardProps> = ({
  property,
  onSelect,
  onToggleFavorite,
}) => {
  const [photoIndex, setPhotoIndex] = useState(0);
  const photos = property.photos && property.photos.length > 0 ? property.photos : [];

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic('medium');
    onToggleFavorite(property.id);
  };

  const handleTelegramClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (property.contact.telegramLink) {
      try {
        posthog.capture('contact_lead_clicked', { propertyId: property.id, channel: 'telegram' });
      } catch {
        // ignore
      }
      openExternalUrl(property.contact.telegramLink);
    }
  };

  const handlePhoneClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (property.contact.phoneLink) {
      triggerHaptic('light');
      try {
        posthog.capture('contact_lead_clicked', { propertyId: property.id, channel: 'phone' });
      } catch {
        // ignore
      }
      window.location.href = property.contact.phoneLink;
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
          <img
            src={photos[photoIndex]}
            alt={property.title}
            className="w-full h-full object-cover select-none pointer-events-none"
            loading="lazy"
          />
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
        <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white px-2.5 py-1 rounded-lg text-xs font-semibold tracking-wide">
          {property.propertyType}
        </div>

        {/* Photo Indicators / Dots */}
        {photos.length > 1 && (
          <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/40 backdrop-blur-md px-2 py-1 rounded-full">
            {photos.slice(0, 5).map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPhotoIndex(idx);
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
            <span className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
              ${property.priceUsd}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {property.type === 'rent' ? '/month' : ''}
            </span>
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
        <div className="mt-auto pt-2 border-t border-zinc-100 dark:border-zinc-700/50 flex items-center gap-2">
          {property.contact.telegramLink ? (
            <button
              type="button"
              onClick={handleTelegramClick}
              className="flex-1 bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-xs active:scale-98"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Message Agent</span>
            </button>
          ) : (
            <span className="text-[11px] text-zinc-400 italic">No Telegram specified</span>
          )}

          {property.contact.phone && (
            <button
              type="button"
              onClick={handlePhoneClick}
              className="p-2 bg-zinc-100 dark:bg-zinc-700 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-200 rounded-xl transition-all active:scale-95"
              aria-label="Call Agent"
            >
              <Phone className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
};

