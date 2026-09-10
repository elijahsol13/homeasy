import React from 'react';
import { Search, SlidersHorizontal, MapPin } from 'lucide-react';
import type { CityKey, FilterState } from '../types';
import { triggerHaptic } from '../services/telegram';

interface HeaderProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  onOpenFilterDrawer: () => void;
  activeFilterCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  filters,
  onFilterChange,
  onOpenFilterDrawer,
  activeFilterCount,
}) => {
  const handleCitySwitch = (city: CityKey) => {
    triggerHaptic('selection');
    onFilterChange({
      ...filters,
      city,
      locations: [], // Reset sangkats when switching city
    });
  };

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFilterChange({
      ...filters,
      query: e.target.value,
    });
  };

  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800 px-4 pt-3 pb-2 shadow-xs transition-colors">
      {/* City Switcher Tabs */}
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
          <button
            type="button"
            onClick={() => handleCitySwitch('siem_reap')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filters.city === 'siem_reap'
                ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-xs'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            <span>Siem Reap</span>
          </button>
          <button
            type="button"
            onClick={() => handleCitySwitch('phnom_penh')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filters.city === 'phnom_penh'
                ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-xs'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            <span>Phnom Penh</span>
          </button>
        </div>

        <div className="text-right">
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
            HomEasy
          </span>
        </div>
      </div>

      {/* Search Bar & Filter Trigger */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            placeholder="Search pool, condo, villa, Wat Bo..."
            value={filters.query || ''}
            onChange={handleSearchInput}
            className="w-full bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm pl-9 pr-3 py-2 rounded-xl border border-transparent focus:border-sky-500 focus:bg-white dark:focus:bg-zinc-800 outline-none transition-all placeholder:text-zinc-400"
          />
        </div>

        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            onOpenFilterDrawer();
          }}
          className={`relative p-2 rounded-xl border transition-all flex items-center justify-center ${
            activeFilterCount > 0
              ? 'bg-sky-500 text-white border-sky-500 shadow-xs'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200'
          }`}
          aria-label="Open Filters"
        >
          <SlidersHorizontal className="w-4 h-4" />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shadow-xs">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};

