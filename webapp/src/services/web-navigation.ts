/** Browser-only listing navigation for the public Homeasy site. No router or Telegram SDK required. */

const LISTING_PATH = /^\/listing\/([^/]+)\/?$/;
const LISTING_HISTORY_KEY = '__homeasyListingHistoryPath';
const NAVIGATION_EVENT = 'homeasy:listing-navigation';

export type PublicTab = 'feed' | 'map' | 'saved';

/** Public sections are addressable without introducing a router into the Mini App. */
export function readPublicTab(pathname: string = window.location.pathname): PublicTab {
  if (/^\/map\/?$/u.test(pathname)) return 'map';
  if (/^\/saved\/?$/u.test(pathname)) return 'saved';
  return 'feed';
}

/** Move between browser tabs, preserving attribution and notifying the existing URL subscriber. */
export function navigateToPublicTab(tab: PublicTab, options: { replace?: boolean } = {}): void {
  const path = tab === 'feed' ? '/' : `/${tab}`;
  if (window.location.pathname === path && !window.location.hash) return;

  const oldState: unknown = window.history.state;
  const state: Record<string, unknown> = oldState && typeof oldState === 'object' && !Array.isArray(oldState)
    ? { ...oldState } : {};
  delete state[LISTING_HISTORY_KEY];
  window.history[options.replace ? 'replaceState' : 'pushState'](
    state, '', `${path}${window.location.search}`,
  );
  notifyNavigation();
}

function validPublicRef(ref: string): boolean {
  if (!ref.trim() || ref === '.' || ref === '..' || /[/\\]/u.test(ref)) return false;
  for (const char of ref) {
    const code = char.codePointAt(0)!;
    if (code < 32 || code === 127) return false;
  }
  try {
    encodeURIComponent(ref); // Also reject malformed UTF-16 (unpaired surrogates).
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a publicRef from `/listing/:publicRef`. Returns null for the catalog,
 * unrelated routes, invalid escapes, or an unsafe/empty path segment.
 * With no argument, reads the current window.location.pathname.
 */
export function parseListingPath(pathname: string = window.location.pathname): string | null {
  const match = LISTING_PATH.exec(pathname);
  if (!match || /[?#]/u.test(match[1])) return null;

  try {
    const ref = decodeURIComponent(match[1]);
    return validPublicRef(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** Build an origin-independent, percent-encoded `/listing/:publicRef` pathname. */
export function buildListingPath(publicRef: string): string {
  if (!validPublicRef(publicRef)) throw new TypeError('Invalid listing publicRef');
  try {
    return `/listing/${encodeURIComponent(publicRef)}`;
  } catch {
    // encodeURIComponent rejects malformed UTF-16, e.g. an unpaired surrogate.
    throw new TypeError('Invalid listing publicRef');
  }
}

function notifyNavigation(): void {
  // pushState/replaceState do not trigger native popstate.
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * Push an in-app listing entry, preserving current search (including UTM and
 * filters) and hash. The same selected ref is a no-op to avoid duplicate Back
 * steps. Subscribers are notified immediately after the history change.
 */
export function openListingInHistory(publicRef: string): void {
  const path = buildListingPath(publicRef);
  if (parseListingPath() === publicRef) return;

  const previousState: unknown = window.history.state;
  const state = previousState && typeof previousState === 'object' && !Array.isArray(previousState)
    ? previousState
    : {};
  window.history.pushState(
    { ...state, [LISTING_HISTORY_KEY]: path },
    '',
    `${path}${window.location.search}${window.location.hash}`,
  );
  notifyNavigation();
}

/**
 * Close the current listing. If this helper pushed the active entry, go Back
 * to the preceding feed/map/route. For direct visits, replace the URL with
 * `/` (retaining query/hash) so Back never unexpectedly exits the site.
 * Browser Back completes asynchronously and emits its own native popstate.
 */
export function closeListingInHistory(): void {
  const ref = parseListingPath();
  if (ref === null) return;

  const state: unknown = window.history.state;
  if (state && typeof state === 'object'
      && (state as Record<string, unknown>)[LISTING_HISTORY_KEY] === buildListingPath(ref)) {
    window.history.back();
    return;
  }

  window.history.replaceState(state, '', `/${window.location.search}${window.location.hash}`);
  notifyNavigation();
}

/**
 * Subscribe to listing URL changes: receives the current ref (or null) once
 * immediately, then on native popstate (Back/Forward) and helper-driven
 * push/replace changes. Returns a cleanup function for React useEffect.
 * Consumers should fetch/show detail by ref; this helper never fetches data.
 */
export function subscribeToListingNavigation(onChange: (publicRef: string | null) => void): () => void {
  const update = () => onChange(parseListingPath());
  window.addEventListener('popstate', update);
  window.addEventListener(NAVIGATION_EVENT, update);
  update();
  return () => {
    window.removeEventListener('popstate', update);
    window.removeEventListener(NAVIGATION_EVENT, update);
  };
}
