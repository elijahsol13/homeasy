import { ArrowRight, ArrowUpRight, MapPin, Search, SlidersHorizontal } from 'lucide-react';
import type { FormEvent } from 'react';
import type { FilterState } from '../types';
import { PhotoWithFallback } from './PhotoWithFallback';
import '../public-hero.css';

interface PublicHeroProps {
  filters: FilterState;
  onQueryChange: (query: string) => void;
  onBrowse: () => void;
  onSearch: () => void;
  onMap: () => void;
  onOpenFilters: () => void;
  total: number;
  loading: boolean;
}

export function PublicHero({
  filters,
  onQueryChange,
  onBrowse,
  onSearch,
  onMap,
  onOpenFilters,
  total,
  loading,
}: PublicHeroProps) {
  const heroImages = [
    '/images/homeasy-hero-living-room.webp',
    '/images/homeasy-hero-apartment-kitchen.webp',
    '/images/homeasy-hero-villa-courtyard.webp',
  ];

  const browseLabel = !loading && Number.isFinite(total) && total > 0
    ? `Explore ${total.toLocaleString('en-US')} listings`
    : 'Explore listings';

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch();
    onBrowse();
  }

  return (
    <section className="public-hero" aria-labelledby="public-hero-heading">
      <div className="public-hero__grain" aria-hidden="true" />
      <div className="public-hero__inner">
        <div className="public-hero__content">
          <div className="public-hero__eyebrow">
            <span className="public-hero__eyebrow-mark" aria-hidden="true" />
            HOMES & SPACES IN SIEM REAP
          </div>

          <h1 className="public-hero__title" id="public-hero-heading">
            Find your place<br />
            <em>in Siem Reap.</em>
          </h1>

          <p className="public-hero__description">
            Discover houses, apartments and more in Siem Reap. Search by neighbourhood,
            explore the map, and get in touch with advertisers directly.
          </p>

          <form className="public-hero__search" role="search" onSubmit={submitSearch}>
            <label className="public-hero__search-label" htmlFor="public-hero-query">
              Search for your next home
            </label>
            <div className="public-hero__search-row">
              <span className="public-hero__search-icon" aria-hidden="true"><Search size={20} strokeWidth={1.7} /></span>
              <input
                id="public-hero-query"
                className="public-hero__input"
                type="search"
                name="query"
                placeholder="Try Wat Bo, villa, pool…"
                autoComplete="off"
                enterKeyHint="search"
                value={filters.query ?? ''}
                onChange={(event) => onQueryChange(event.target.value)}
              />
              <button className="public-hero__search-submit" type="submit">
                <span>Search</span>
                <ArrowRight size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </form>

          <div className="public-hero__actions">
            <button className="public-hero__action-primary" type="button" onClick={onBrowse}>
              {browseLabel} <ArrowUpRight size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button className="public-hero__action-secondary" type="button" onClick={onMap}>
              <MapPin size={18} strokeWidth={1.75} aria-hidden="true" /> Explore the map
            </button>
            <button className="public-hero__action-secondary" type="button" onClick={onOpenFilters}>
              <SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true" /> All filters
            </button>
          </div>

          <p className="public-hero__footnote">
            Browse listings <span aria-hidden="true">·</span> Save your favourites <span aria-hidden="true">·</span> Contact advertisers
          </p>
        </div>

        <div className="public-hero__visual" aria-hidden="true">
          <div className="public-hero__visual-outline" aria-hidden="true" />
          <div className="public-hero__collage">
            {heroImages.map((image, index) => (
              <figure
                key={image}
                className={'public-hero__tile public-hero__tile--' + (index + 1)}
              >
                <PhotoWithFallback
                  src={image}
                  alt=""
                  className="public-hero__photo"
                  loading={index === 0 ? 'eager' : 'lazy'}
                />
              </figure>
            ))}
          </div>
          <div className="public-hero__visual-note">
            <span className="public-hero__visual-note-dot" aria-hidden="true" />
            <span>Explore Siem Reap, one address at a time.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
