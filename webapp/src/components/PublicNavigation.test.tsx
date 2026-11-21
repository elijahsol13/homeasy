// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveTab } from '../types';
import { PublicHeader } from './PublicHeader';
import { PublicFooter } from './PublicFooter';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function link(selector: string): HTMLAnchorElement {
  const match = host.querySelector<HTMLAnchorElement>(selector);
  if (!match) throw new Error(`Missing link: ${selector}`);
  return match;
}

function click(anchor: HTMLAnchorElement, options: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options });
  let preventedByComponent = false;
  // Inspect the result after React handled the click, then suppress jsdom's native navigation.
  host.addEventListener('click', (observed) => {
    preventedByComponent = observed.defaultPrevented;
    observed.preventDefault();
  }, { once: true });
  act(() => { anchor.dispatchEvent(event); });
  return preventedByComponent;
}

function header(activeTab: ActiveTab = 'map') {
  const props = { activeTab, savedCount: 3, filterCount: 2,
    onHome: vi.fn(), onBrowse: vi.fn(), onMap: vi.fn(),
    onSaved: vi.fn(), onAbout: vi.fn(), onOpenFilters: vi.fn() };
  act(() => root.render(<PublicHeader {...props} />));
  return props;
}
function footer() {
  const props = { onBrowse: vi.fn(), onMap: vi.fn(), onSaved: vi.fn() };
  act(() => root.render(<PublicFooter {...props} />));
  return props;
}

describe('PublicHeader navigation links', () => {
  it('has real destinations and preserves active, saved-count and filter controls', () => {
    header();
    const hrefs = [
      ['a.public-brand', '/'], ['.public-desktop-links a:nth-child(1)', '/#listings'],
      ['.public-desktop-links a:nth-child(2)', '/map'], ['.public-desktop-links a:nth-child(3)', '/saved'],
      ['.public-desktop-links a:nth-child(4)', '/#about'], ['a.public-header-cta', '/#listings'],
      ['.public-mobile-links a:nth-child(1)', '/#listings'], ['.public-mobile-links a:nth-child(2)', '/map'],
      ['.public-mobile-links a:nth-child(3)', '/saved'], ['.public-mobile-links a:nth-child(4)', '/#about'],
    ] as const;
    for (const [selector, href] of hrefs) expect(link(selector).getAttribute('href'), selector).toBe(href);
    expect(link('.public-desktop-links a:nth-child(2)').getAttribute('aria-current')).toBe('page');
    expect(link('.public-mobile-links a:nth-child(2)').classList.contains('is-active')).toBe(true);
    expect(link('.public-desktop-links a:nth-child(1)').hasAttribute('aria-current')).toBe(false);
    expect(link('.public-desktop-links a:nth-child(3)').textContent).toContain('3');
    expect(host.querySelector<HTMLButtonElement>('.public-filter-action')?.type).toBe('button');
  });

  it('intercepts ordinary clicks to call the existing handlers', () => {
    const p = header('feed');
    const targets = [
      ['a.public-brand', p.onHome], ['.public-desktop-links a:nth-child(1)', p.onBrowse],
      ['.public-desktop-links a:nth-child(2)', p.onMap], ['.public-desktop-links a:nth-child(3)', p.onSaved],
      ['.public-desktop-links a:nth-child(4)', p.onAbout], ['a.public-header-cta', p.onBrowse],
      ['.public-mobile-links a:nth-child(1)', p.onBrowse], ['.public-mobile-links a:nth-child(2)', p.onMap],
      ['.public-mobile-links a:nth-child(3)', p.onSaved], ['.public-mobile-links a:nth-child(4)', p.onAbout],
    ] as const;
    for (const [selector, handler] of targets) {
      const before = handler.mock.calls.length;
      expect(click(link(selector)), selector).toBe(true);
      expect(handler.mock.calls.length, selector).toBe(before + 1);
    }
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }])(
    'lets the browser handle modified and non-primary clicks: %o', (options) => {
      const p = header();
      expect(click(link('.public-desktop-links a:nth-child(2)'), options)).toBe(false);
      expect(p.onMap).not.toHaveBeenCalled();
    },
  );
});

describe('PublicFooter navigation links', () => {
  it('has real home, listings, map, saved and privacy URLs', () => {
    footer();
    expect(link('a.pf-logo').getAttribute('href')).toBe('/');
    expect(link('a.pf-cta').getAttribute('href')).toBe('/#listings');
    expect(link('.pf-navigation__links a:nth-child(1)').getAttribute('href')).toBe('/#listings');
    expect(link('.pf-navigation__links a:nth-child(2)').getAttribute('href')).toBe('/map');
    expect(link('.pf-navigation__links a:nth-child(3)').getAttribute('href')).toBe('/saved');
    expect(link('.pf-bottom a').getAttribute('href')).toBe('/privacy');
  });

  it('keeps SPA callbacks for ordinary links and CTA', () => {
    const p = footer();
    const targets = [
      ['a.pf-cta', p.onBrowse], ['.pf-navigation__links a:nth-child(1)', p.onBrowse],
      ['.pf-navigation__links a:nth-child(2)', p.onMap], ['.pf-navigation__links a:nth-child(3)', p.onSaved],
    ] as const;
    for (const [selector, handler] of targets) {
      const before = handler.mock.calls.length;
      expect(click(link(selector)), selector).toBe(true);
      expect(handler.mock.calls.length, selector).toBe(before + 1);
    }
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { button: 1 }])(
    'keeps browser navigation for modified clicks: %o', (options) => {
      const p = footer();
      expect(click(link('.pf-navigation__links a:nth-child(2)'), options)).toBe(false);
      expect(p.onMap).not.toHaveBeenCalled();
    },
  );
});
