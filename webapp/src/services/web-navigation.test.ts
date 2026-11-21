// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildListingPath,
  closeListingInHistory,
  openListingInHistory,
  parseListingPath,
  readPublicTab,
  navigateToPublicTab,
  subscribeToListingNavigation,
} from './web-navigation';

const ROOT = '/';

describe('listing URL paths', () => {
  it('parses a listing path, including UTF-8 and percent-encoded characters', () => {
    expect(parseListingPath('/listing/lst_123')).toBe('lst_123');
    expect(parseListingPath('/listing/caf%C3%A9%20%26%20tea%3F')).toBe('café & tea?');
    expect(parseListingPath('/listing/lst_123/')).toBe('lst_123');
  });

  it.each([
    '/', '/listings/lst_123', '/listing', '/listing/', '/listing/foo/bar',
    '/listing/%', '/listing/%E0%A4%A', '/listing/%2F', '/listing/a%5Cb',
    '/listing/%2E%2E', '/listing/%20%20', '/listing/%00bad',
    '/listing/foo?utm_source=search', '/LISTING/lst_123',
  ])('rejects invalid or non-listing paths: %s', (pathname) => {
    expect(parseListingPath(pathname)).toBeNull();
  });

  it('builds exactly one encoded pathname segment and round-trips it', () => {
    const ref = 'café & tea? #100%';
    const path = buildListingPath(ref);
    expect(path).toBe('/listing/caf%C3%A9%20%26%20tea%3F%20%23100%25');
    expect(parseListingPath(path)).toBe(ref);
  });

  it.each(['', ' ', '.', '..', 'foo/bar', 'foo\\bar', 'x\ny', '\uD800'])(
    'rejects unsafe publicRefs before building a URL: %s', (ref) => {
      expect(() => buildListingPath(ref)).toThrow(TypeError);
    },
  );

  it('reads the active browser pathname by default', () => {
    window.history.replaceState(null, '', '/listing/lst_current?utm_source=ad');
    expect(parseListingPath()).toBe('lst_current');
  });
});

describe('browser listing navigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', ROOT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', ROOT);
  });

  it('opens via pushState without dropping search params or fragment', () => {
    window.history.replaceState({ other: 'state' }, '', '/?utm_source=fb&query=pool#results');
    const push = vi.spyOn(window.history, 'pushState');

    openListingInHistory('lst_123');

    expect(push).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/listing/lst_123');
    expect(window.location.search).toBe('?utm_source=fb&query=pool');
    expect(window.location.hash).toBe('#results');
    expect(window.history.state.other).toBe('state');
  });

  it('does not add another history entry when opening the same listing', () => {
    window.history.replaceState(null, '', '/listing/lst_123?utm_medium=link');
    const push = vi.spyOn(window.history, 'pushState');

    openListingInHistory('lst_123');

    expect(push).not.toHaveBeenCalled();
  });

  it('keeps the original URL when an invalid publicRef is supplied', () => {
    window.history.replaceState(null, '', '/?utm_source=fb');
    const push = vi.spyOn(window.history, 'pushState');

    expect(() => openListingInHistory('bad/ref')).toThrow(TypeError);
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
  });

  it('uses browser back for a listing opened by the helper', () => {
    window.history.replaceState(null, '', '/?utm_source=ad');
    openListingInHistory('lst_123');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const replace = vi.spyOn(window.history, 'replaceState');

    closeListingInHistory();

    expect(back).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it('closes a direct listing URL to the catalog without leaving the site', () => {
    window.history.replaceState(null, '', '/listing/lst_direct?utm_campaign=winter&sort=recent#photos');
    const back = vi.spyOn(window.history, 'back');

    closeListingInHistory();

    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?utm_campaign=winter&sort=recent');
    expect(window.location.hash).toBe('#photos');
  });

  it('does nothing when no listing is open', () => {
    const back = vi.spyOn(window.history, 'back');
    const replace = vi.spyOn(window.history, 'replaceState');

    closeListingInHistory();

    expect(back).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('emits the current path and updates listeners on push and direct-link close', () => {
    const onChange = vi.fn();
    const stop = subscribeToListingNavigation(onChange);

    expect(onChange).toHaveBeenCalledWith(null);
    openListingInHistory('lst_first');
    expect(onChange).toHaveBeenLastCalledWith('lst_first');

    // A fresh direct arrival has no helper-created history entry.
    window.history.replaceState(null, '', '/listing/lst_direct?utm_source=fb');
    closeListingInHistory();
    expect(onChange).toHaveBeenLastCalledWith(null);

    stop();
    openListingInHistory('lst_after_unsubscribe');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('handles native popstate including Back, Forward and invalid routes', () => {
    const onChange = vi.fn();
    const stop = subscribeToListingNavigation(onChange);

    window.history.replaceState(null, '', '/listing/lst_back');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.history.replaceState(null, '', '/invalid/path');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onChange.mock.calls).toEqual([[null], ['lst_back'], [null], [null]]);
    stop();
  });

  it('follows real browser Back and Forward history traversal', async () => {
    const onChange = vi.fn();
    const stop = subscribeToListingNavigation(onChange);
    openListingInHistory('lst_traversal');

    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(onChange).toHaveBeenLastCalledWith(null);

    window.history.forward();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/listing/lst_traversal'));
    expect(onChange).toHaveBeenLastCalledWith('lst_traversal');
    stop();
  });
});

describe('public website routes', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('recognizes direct web map and saved routes with trailing slashes', () => {
    expect(readPublicTab('/map')).toBe('map');
    expect(readPublicTab('/saved/')).toBe('saved');
    expect(readPublicTab('/')).toBe('feed');
    expect(readPublicTab('/listing/lst_123')).toBe('feed');
  });

  it('pushes tab routes, keeps query attribution, and avoids duplicate entries', () => {
    window.history.replaceState(null, '', '/?utm_source=fb#listings');
    const push = vi.spyOn(window.history, 'pushState');
    navigateToPublicTab('map');
    expect(window.location.pathname).toBe('/map');
    expect(window.location.search).toBe('?utm_source=fb');
    expect(window.location.hash).toBe('');
    navigateToPublicTab('map');
    expect(push).toHaveBeenCalledTimes(1);
    navigateToPublicTab('saved');
    expect(window.location.pathname).toBe('/saved');
    push.mockRestore();
  });

  it('can replace a listing URL with the map without leaving a stale listing marker', () => {
    window.history.replaceState(null, '', '/map');
    openListingInHistory('lst_123');
    navigateToPublicTab('map', { replace: true });
    expect(window.location.pathname).toBe('/map');
    const back = vi.spyOn(window.history, 'back');
    closeListingInHistory();
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });
});
