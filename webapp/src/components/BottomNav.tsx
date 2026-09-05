import React from 'react';
import { Compass, Map, Heart } from 'lucide-react';
import type { ActiveTab } from '../types';
import { triggerHaptic } from '../services/telegram';

interface BottomNavProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  favoritesCount: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onTabChange,
  favoritesCount,
}) => {
  const handleTabClick = (tab: ActiveTab) => {
    triggerHaptic('selection');
    onTabChange(tab);
  };

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border-t border-zinc-200 dark:border-zinc-800 px-6 py-2 shadow-lg max-w-lg mx-auto">
      <div className="flex items-center justify-around">
        {/* Explore / Feed Tab */}
        <button
          type="button"
          onClick={() => handleTabClick('feed')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all ${
            activeTab === 'feed'
              ? 'text-sky-600 dark:text-sky-400 font-bold scale-105'
              : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 font-medium'
          }`}
        >
          <Compass className="w-5 h-5" />
          <span className="text-[10px]">Explore</span>
        </button>

        {/* Map Tab */}
        <button
          type="button"
          onClick={() => handleTabClick('map')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all ${
            activeTab === 'map'
              ? 'text-sky-600 dark:text-sky-400 font-bold scale-105'
              : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 font-medium'
          }`}
        >
          <Map className="w-5 h-5" />
          <span className="text-[10px]">Map</span>
        </button>

        {/* Saved / Favorites Tab */}
        <button
          type="button"
          onClick={() => handleTabClick('saved')}
          className={`relative flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all ${
            activeTab === 'saved'
              ? 'text-rose-500 font-bold scale-105'
              : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 font-medium'
          }`}
        >
          <div className="relative">
            <Heart className="w-5 h-5" />
            {favoritesCount > 0 && (
              <span className="absolute -top-1 -right-2 bg-rose-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {favoritesCount}
              </span>
            )}
          </div>
          <span className="text-[10px]">Saved</span>
        </button>
      </div>
    </nav>
  );
};
