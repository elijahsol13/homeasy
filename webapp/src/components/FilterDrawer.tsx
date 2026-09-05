import React, { useState } from 'react';
import { X, RotateCcw, Check, Waves } from 'lucide-react';
import type { FilterMetadata, FilterState } from '../types';
import { triggerHaptic } from '../services/telegram';

interface FilterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  filters: FilterState;
  metadata: FilterMetadata | null;
  onApply: (newFilters: FilterState) => void;
}

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  isOpen,
  onClose,
  filters,
  metadata,
  onApply,
}) => {
  const [draft, setDraft] = useState<FilterState>(filters);

  if (!isOpen) return null;

  const handleCategoryClick = (catId?: string) => {
    triggerHaptic('selection');
    setDraft((prev) => ({
      ...prev,
      category: prev.category === catId ? undefined : catId,
    }));
  };

  const handleTypeClick = (type: 'rent' | 'sale') => {
    triggerHaptic('selection');
    setDraft((prev) => ({ ...prev, type }));
  };

  const handleBedroomsClick = (bed: number) => {
    triggerHaptic('selection');
    setDraft((prev) => {
      const current = prev.bedrooms || [];
      const next = current.includes(bed)
        ? current.filter((b) => b !== bed)
        : [...current, bed];
      return { ...prev, bedrooms: next.length > 0 ? next : undefined };
    });
  };

  const handleLocationToggle = (locName: string) => {
    triggerHaptic('selection');
    setDraft((prev) => {
      const current = prev.locations || [];
      const next = current.includes(locName)
        ? current.filter((l) => l !== locName)
        : [...current, locName];
      return { ...prev, locations: next };
    });
  };

  const handleReset = () => {
    triggerHaptic('warning');
    const resetState: FilterState = {
      city: filters.city,
      locations: [],
      category: undefined,
      type: 'rent',
      minPrice: undefined,
      maxPrice: undefined,
      bedrooms: undefined,
      hasPool: undefined,
      minLeaseMax: undefined,
      query: undefined,
      sort: 'newest',
    };
    setDraft(resetState);
    onApply(resetState);
    onClose();
  };

  const handleSaveAndApply = () => {
    triggerHaptic('success');
    onApply(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end flex-col animate-in fade-in duration-150">
      <div className="bg-white dark:bg-zinc-900 w-full max-h-[85vh] rounded-t-3xl overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
              Filters
            </h2>
            <button
              type="button"
              onClick={handleReset}
              className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 flex items-center gap-1 ml-2"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filter Sections */}
        <div className="p-5 overflow-y-auto space-y-6">
          {/* Deal Type (Rent / Sale) */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 block mb-2">
              Deal Type
            </label>
            <div className="grid grid-cols-2 gap-2 bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
              <button
                type="button"
                onClick={() => handleTypeClick('rent')}
                className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                  draft.type !== 'sale'
                    ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'text-zinc-500'
                }`}
              >
                For Rent
              </button>
              <button
                type="button"
                onClick={() => handleTypeClick('sale')}
                className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                  draft.type === 'sale'
                    ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'text-zinc-500'
                }`}
              >
                For Sale
              </button>
            </div>
          </div>

          {/* Property Category */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 block mb-2">
              Category
            </label>
            <div className="flex flex-wrap gap-2">
              {metadata?.categories.map((cat) => {
                const isSelected = draft.category === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handleCategoryClick(cat.id)}
                    className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                      isSelected
                        ? 'bg-sky-500 text-white border-sky-500 shadow-xs'
                        : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700/60'
                    }`}
                  >
                    <span>{cat.label}</span>
                    {cat.count > 0 && (
                      <span className={`ml-1.5 text-[10px] ${isSelected ? 'text-white/80' : 'text-zinc-400'}`}>
                        {cat.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Budget Max Slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                Max Budget
              </label>
              <span className="text-sm font-bold text-sky-600 dark:text-sky-400">
                {draft.maxPrice ? `$${draft.maxPrice}` : 'Any Price'}
              </span>
            </div>
            <div className="flex gap-2 mb-2">
              {[250, 400, 600, 1000, 2000].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    setDraft((p) => ({ ...p, maxPrice: p.maxPrice === preset ? undefined : preset }));
                  }}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border ${
                    draft.maxPrice === preset
                      ? 'bg-sky-50 dark:bg-sky-950 text-sky-600 dark:text-sky-400 border-sky-500'
                      : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  ${preset}
                </button>
              ))}
            </div>
          </div>

          {/* Bedrooms */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 block mb-2">
              Bedrooms
            </label>
            <div className="flex gap-2">
              {[
                { val: 0, label: 'Studio' },
                { val: 1, label: '1 BR' },
                { val: 2, label: '2 BR' },
                { val: 3, label: '3 BR' },
                { val: 4, label: '4+ BR' },
              ].map((opt) => {
                const isSelected = draft.bedrooms?.includes(opt.val);
                return (
                  <button
                    key={opt.val}
                    type="button"
                    onClick={() => handleBedroomsClick(opt.val)}
                    className={`flex-1 py-2 rounded-xl text-xs font-semibold border transition-all ${
                      isSelected
                        ? 'bg-sky-500 text-white border-sky-500 shadow-xs'
                        : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700/60'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pool Toggle */}
          <div>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('selection');
                setDraft((p) => ({ ...p, hasPool: p.hasPool ? undefined : true }));
              }}
              className={`w-full p-3 rounded-xl border flex items-center justify-between transition-all ${
                draft.hasPool
                  ? 'bg-sky-50 dark:bg-sky-950/60 border-sky-500 text-sky-700 dark:text-sky-300'
                  : 'bg-zinc-50 dark:bg-zinc-800/40 border-zinc-200 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Waves className="w-4 h-4 text-sky-500" />
                <span>Swimming Pool Required</span>
              </div>
              {draft.hasPool && <Check className="w-4 h-4 text-sky-600 dark:text-sky-400" />}
            </button>
          </div>

          {/* Sangkats / Locations Chips */}
          {metadata?.locations && metadata.locations.length > 0 && (
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 block mb-2">
                Locations & Sangkats
              </label>
              <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
                {metadata.locations.map((loc) => {
                  const isSelected = draft.locations?.includes(loc.name);
                  return (
                    <button
                      key={loc.name}
                      type="button"
                      onClick={() => handleLocationToggle(loc.name)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                        isSelected
                          ? 'bg-sky-500 text-white border-sky-500 shadow-xs'
                          : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700/60'
                      }`}
                    >
                      <span>{loc.name}</span>
                      <span className={`ml-1 text-[10px] ${isSelected ? 'text-white/80' : 'text-zinc-400'}`}>
                        ({loc.count})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Sort Order */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 block mb-2">
              Sort By
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { val: 'newest' as const, label: 'Newest' },
                { val: 'price_asc' as const, label: 'Price: Low' },
                { val: 'price_desc' as const, label: 'Price: High' },
              ].map((s) => (
                <button
                  key={s.val}
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    setDraft((p) => ({ ...p, sort: s.val }));
                  }}
                  className={`py-2 rounded-xl text-xs font-semibold border ${
                    draft.sort === s.val
                      ? 'bg-sky-500 text-white border-sky-500'
                      : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Apply Bar */}
        <div className="p-4 bg-white dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="button"
            onClick={handleSaveAndApply}
            className="w-full bg-sky-500 hover:bg-sky-600 text-white font-bold py-3.5 px-4 rounded-xl shadow-md transition-all active:scale-98 text-sm"
          >
            Show Listings
          </button>
        </div>
      </div>
    </div>
  );
};
