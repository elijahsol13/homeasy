import type { MouseEvent } from 'react';
import { ArrowUpRight, Heart, House, MapPinned, SlidersHorizontal } from 'lucide-react';
import type { ActiveTab } from '../types';
import '../public-shell.css';

interface PublicHeaderProps {
  activeTab: ActiveTab;
  savedCount: number;
  filterCount: number;
  onHome: () => void;
  onBrowse: () => void;
  onMap: () => void;
  onSaved: () => void;
  onAbout: () => void;
  onOpenFilters: () => void;
}

function navigateOnPlainClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

export function PublicHeader({
  activeTab,
  savedCount,
  filterCount,
  onHome,
  onBrowse,
  onMap,
  onSaved,
  onAbout,
  onOpenFilters,
}: PublicHeaderProps) {
  return (
    <>
      <a className="public-skip-link" href="#main-content">Skip to main content</a>
      <div className="public-eyebrow-bar">
        <div className="public-header-container">
          <span>LOCAL HOMES · SIEM REAP, CAMBODIA</span>
          <span className="public-eyebrow-bar-note">Find a place that feels like yours.</span>
        </div>
      </div>
      <header className="public-header">
        <div className="public-header-container public-header-row">
          <a href="/" className="public-brand" onClick={(event) => navigateOnPlainClick(event, onHome)} aria-label="Homeasy home">
            <span className="public-brand-mark"><House size={22} strokeWidth={2.1} aria-hidden="true" /></span>
            <span className="public-brand-name">home<span>asy</span><span className="public-brand-period">.</span></span>
          </a>

          <nav className="public-desktop-links" aria-label="Public website navigation">
            <a href="/#listings" className={activeTab === 'feed' ? 'is-active' : ''} aria-current={activeTab === 'feed' ? 'page' : undefined} onClick={(event) => navigateOnPlainClick(event, onBrowse)}>Explore homes</a>
            <a href="/map" className={activeTab === 'map' ? 'is-active' : ''} aria-current={activeTab === 'map' ? 'page' : undefined} onClick={(event) => navigateOnPlainClick(event, onMap)}>Map view</a>
            <a href="/saved" className={activeTab === 'saved' ? 'is-active' : ''} aria-current={activeTab === 'saved' ? 'page' : undefined} onClick={(event) => navigateOnPlainClick(event, onSaved)}>Saved homes {savedCount > 0 && <span className="public-nav-count">{savedCount}</span>}</a>
            <a href="/#about" onClick={(event) => navigateOnPlainClick(event, onAbout)}>How it works</a>
          </nav>

          <div className="public-header-actions">
            <button type="button" className="public-filter-action" onClick={onOpenFilters} aria-label={`Open property filters${filterCount > 0 ? `, ${filterCount} active` : ''}`}>
              <SlidersHorizontal size={18} aria-hidden="true" />
              <span>Filters</span>
              {filterCount > 0 && <span className="public-filter-count">{filterCount}</span>}
            </button>
            <a href="/#listings" className="public-header-cta" onClick={(event) => navigateOnPlainClick(event, onBrowse)}>
              View listings <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          </div>
        </div>
        <nav className="public-mobile-links" aria-label="Public mobile navigation">
          <a href="/#listings" onClick={(event) => navigateOnPlainClick(event, onBrowse)} aria-current={activeTab === 'feed' ? 'page' : undefined} className={activeTab === 'feed' ? 'is-active' : ''}><House size={16} aria-hidden="true" /> Explore</a>
          <a href="/map" onClick={(event) => navigateOnPlainClick(event, onMap)} aria-current={activeTab === 'map' ? 'page' : undefined} className={activeTab === 'map' ? 'is-active' : ''}><MapPinned size={16} aria-hidden="true" /> Map</a>
          <a href="/saved" onClick={(event) => navigateOnPlainClick(event, onSaved)} aria-current={activeTab === 'saved' ? 'page' : undefined} className={activeTab === 'saved' ? 'is-active' : ''}><Heart size={16} aria-hidden="true" /> Saved {savedCount > 0 && <span>{savedCount}</span>}</a>
          <a href="/#about" onClick={(event) => navigateOnPlainClick(event, onAbout)}>About</a>
        </nav>
      </header>
    </>
  );
}
