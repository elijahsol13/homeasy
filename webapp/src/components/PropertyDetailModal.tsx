import React, { useState } from 'react';
import {
  X,
  Heart,
  MapPin,
  Send,
  Phone,
  Waves,
  Zap,
  Droplets,
  Ban,
  Sparkles,
  ExternalLink,
  Map,
} from 'lucide-react';
import type { PropertyDTO } from '../types';
import { triggerHaptic, openExternalUrl } from '../services/telegram';
import posthog from 'posthog-js';

interface PropertyDetailModalProps {
  property: PropertyDTO | null;
  onClose: () => void;
  onToggleFavorite: (propertyId: number) => void;
}

export const PropertyDetailModal: React.FC<PropertyDetailModalProps> = ({
  property,
  onClose,
  onToggleFavorite,
}) => {
  const [activePhoto, setActivePhoto] = useState(0);

  if (!property) return null;

  const photos = property.photos && property.photos.length > 0 ? property.photos : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end sm:justify-center sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-zinc-900 w-full max-w-2xl max-h-[92vh] sm:rounded-3xl rounded-t-3xl overflow-hidden flex flex-col shadow-2xl">
        {/* Top Floating Action Bar */}
        <div className="relative aspect-[16/10] w-full bg-zinc-100 dark:bg-zinc-800 shrink-0">
          {photos.length > 0 ? (
            <img
              src={photos[activePhoto]}
              alt={property.title}
              className="w-full h-full object-cover select-none"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-400">
              No Photos
            </div>
          )}

          {/* Close & Favorite buttons */}
          <div className="absolute top-4 inset-x-4 flex items-center justify-between z-10">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/70 active:scale-95 transition-all"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium');
                onToggleFavorite(property.id);
              }}
              className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/70 active:scale-95 transition-all"
              aria-label="Favorite"
            >
              <Heart
                className={`w-5 h-5 ${
                  property.isFavorite ? 'fill-rose-500 text-rose-500' : 'text-white'
                }`}
              />
            </button>
          </div>

          {/* Photo count badge */}
          {photos.length > 1 && (
            <div className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md text-white text-xs font-semibold px-2.5 py-1 rounded-lg">
              {activePhoto + 1} / {photos.length}
            </div>
          )}
        </div>

        {/* Thumbnail strip */}
        {photos.length > 1 && (
          <div className="flex items-center gap-2 p-2 px-4 bg-zinc-50 dark:bg-zinc-800/50 overflow-x-auto no-scrollbar border-b border-zinc-100 dark:border-zinc-800 shrink-0">
            {photos.map((src, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  triggerHaptic('selection');
                  setActivePhoto(i);
                }}
                className={`w-14 h-14 rounded-lg overflow-hidden shrink-0 border-2 transition-all ${
                  activePhoto === i ? 'border-sky-500 scale-105' : 'border-transparent opacity-60'
                }`}
              >
                <img src={src} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}

        {/* Scrollable Content */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-5 flex-1">
          {/* Header Title & Price */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-sky-100 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 text-xs font-bold px-2.5 py-1 rounded-md uppercase tracking-wider">
                {property.propertyType}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">
                {property.type === 'rent' ? 'For Rent' : 'For Sale'}
              </span>
            </div>

            <h2 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
              {property.title}
            </h2>

            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-3xl font-extrabold text-zinc-900 dark:text-zinc-50">
                ${property.priceUsd}
              </span>
              <span className="text-sm text-zinc-500 dark:text-zinc-400">
                {property.type === 'rent' ? '/month' : ''}
              </span>
            </div>
          </div>

          {/* Location & Maps Button */}
          <div className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-100 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <MapPin className="w-4 h-4 text-sky-500 shrink-0" />
              <span>{property.location || property.city}, Cambodia</span>
            </div>

            {property.mapsUrl && (
              <button
                type="button"
                onClick={() => openExternalUrl(property.mapsUrl!)}
                className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:underline flex items-center gap-1"
              >
                <span>Maps</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            )}
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
            {property.depositUsd !== null && (
              <div className="p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-100 dark:border-zinc-800">
                <span className="text-xs text-zinc-400 block">Deposit</span>
                <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                  ${property.depositUsd}
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

          {/* Cambodian Utilities & Amenities */}
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
              Utilities & Amenities
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
          </div>

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
          {property.specs.landmarks.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                Nearby Landmarks
              </h3>
              <div className="flex flex-wrap gap-2">
                {property.specs.landmarks.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => openExternalUrl(l.link)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-medium hover:bg-zinc-200 transition-colors"
                  >
                    <span>🚩 {l.name}</span>
                    <ExternalLink className="w-3 h-3 text-zinc-400" />
                  </button>
                ))}
              </div>
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

          {/* Original Source Link */}
          {property.originalUrl && (
            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 text-xs text-zinc-400">
              <span>Source: </span>
              <button
                type="button"
                onClick={() => openExternalUrl(property.originalUrl)}
                className="text-sky-500 hover:underline"
              >
                View Original Listing
              </button>
            </div>
          )}
        </div>

        {/* Sticky Contact Bottom Bar */}
        <div className="p-4 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3 shrink-0">
          {property.contact.telegramLink ? (
            <button
              type="button"
              onClick={() => {
                try {
                  posthog.capture('contact_lead_clicked', { propertyId: property.id, channel: 'telegram' });
                } catch {
                  // ignore
                }
                openExternalUrl(property.contact.telegramLink!);
              }}
              className="flex-1 bg-sky-500 hover:bg-sky-600 text-white font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-2 shadow-md active:scale-98 transition-all"
            >
              <Send className="w-4 h-4" />
              <span>Chat in Telegram</span>
            </button>
          ) : property.originalUrl ? (
            <button
              type="button"
              onClick={() => openExternalUrl(property.originalUrl)}
              className="flex-1 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-2 active:scale-98 transition-all"
            >
              <span>View Original Listing ↗</span>
            </button>
          ) : null}

          {property.contact.phone && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                try {
                  posthog.capture('contact_lead_clicked', { propertyId: property.id, channel: 'phone' });
                } catch {
                  // ignore
                }
                window.location.href = property.contact.phoneLink!;
              }}
              className="p-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl shadow-md active:scale-95 transition-all flex items-center justify-center"
              aria-label="Call"
            >
              <Phone className="w-5 h-5" />
            </button>
          )}

          {property.mapsUrl && (
            <button
              type="button"
              onClick={() => openExternalUrl(property.mapsUrl!)}
              className="p-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 rounded-xl active:scale-95 transition-all flex items-center justify-center"
              aria-label="Google Maps"
            >
              <Map className="w-5 h-5 text-sky-500" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
