import {
  toHighResImageUrl,
  KHMER24_TARGETS,
  buildFeedPageUrl,
  parseKhmer24FeedNuxtData,
  isKhmer24BrowserClosedError,
  scrapeTargetWithRecovery,
} from '../src/modules/parser/khmer24.scraper';
import type { Browser } from 'playwright';
import type { CamoufoxBrowser } from '../src/modules/parser/camoufox-server';
import { isStaleKhmer24Original, khmer24OriginalPostedAt, khmer24PublishedAt, khmer24SourceLocation, parseKhmer24DetailHtml } from '../src/modules/parser/khmer24-http';

function detailPostFixture(id: string, overrides: Record<string, unknown> = {}): string {
  const nodes: unknown[] = [];
  const add = (value: unknown): number => nodes.push(value) - 1;
  const pin = add({ latitude: add('13.351234'), longitude: add('103.864567') });
  const district = add({ latitude: add('13.351200'), longitude: add('103.864500') });
  add({ id: add(id), posted_date: add('2026-10-01 08:00:00'), map: pin,
    location: district, ...overrides });
  return JSON.stringify(nodes);
}

function nuxtFeedFixture(posts: Array<{ link: string; province?: string; category?: string }>): string {
  const raw: unknown[] = [];
  const add = (value: unknown): number => raw.push(value) - 1;
  const wrappers = posts.map((post) => {
    const location = post.province ? add({ slug: add(post.province) }) : undefined;
    const category = add({ slug: add(post.category ?? 'house-for-rent') });
    const data = add({ link: add(post.link), location, category });
    return add({ type: add('item'), data });
  });
  const data = add(wrappers);
  add({ total: add(posts.length), limit: add(30), data });
  return JSON.stringify(raw);
}

describe('Khmer24 API Scraper', () => {
  describe('crashed browser recovery', () => {
    const deadHandle = (): CamoufoxBrowser => ({
      browser: { newContext: jest.fn(async () => {
        throw new Error('browserContext.newPage: page.close: page.goto: Browser closed');
      }) } as unknown as Browser,
      close: jest.fn(async () => {}),
    });
    const healthyHandle = (): CamoufoxBrowser => {
      const page = { route: jest.fn(async () => {}), goto: jest.fn(async () => {}),
        title: jest.fn(async () => ''), evaluate: jest.fn(async () => ''),
        close: jest.fn(async () => {}) };
      const context = { newPage: jest.fn(async () => page), close: jest.fn(async () => {}) };
      return { browser: { newContext: jest.fn(async () => context) } as unknown as Browser,
        close: jest.fn(async () => {}) };
    };

    test('restarts a dead browser once, then finishes and releases both processes', async () => {
      const dead = deadHandle();
      const healthy = healthyHandle();
      const launch = jest.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(healthy);
      await expect(scrapeTargetWithRecovery(KHMER24_TARGETS[2], 2, launch)).resolves.toEqual([]);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(dead.close).toHaveBeenCalledTimes(1);
      expect(healthy.close).toHaveBeenCalledTimes(1);
    });

    test('never loops indefinitely after a second browser crash', async () => {
      const first = deadHandle();
      const second = deadHandle();
      const launch = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      await expect(scrapeTargetWithRecovery(KHMER24_TARGETS[2], 2, launch)).rejects.toThrow('Browser closed');
      expect(launch).toHaveBeenCalledTimes(2);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(second.close).toHaveBeenCalledTimes(1);
    });

    test('only retries a disconnected browser, not arbitrary detail failures', () => {
      expect(isKhmer24BrowserClosedError(new Error('page.goto: Browser closed'))).toBe(true);
      expect(isKhmer24BrowserClosedError(new Error('Target page, context or browser has been closed'))).toBe(true);
      expect(isKhmer24BrowserClosedError(new Error('Cloudflare blocked access'))).toBe(false);
      expect(isKhmer24BrowserClosedError(new Error('Timeout 25000ms exceeded'))).toBe(false);
    });
  });

  describe('30-day original publication freshness', () => {
    const now = Date.parse('2026-10-20T10:00:00+07:00');
    test('skips a bumped old original from the last-7-days feed', () => {
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      const source = detailPostFixture('14071624', {
        posted_date: '2026-08-30 12:00:00', renew_date: '2026-10-20 09:00:00',
      });
      // Renewals are irrelevant to original publication age.
      expect(isStaleKhmer24Original(khmer24OriginalPostedAt(source, url), now)).toBe(true);
    });
    test('handles Khmer local dates and explicit timezone offsets at the 30-day boundary', () => {
      expect(isStaleKhmer24Original('2026-09-20 10:00:00', now)).toBe(false);
      expect(isStaleKhmer24Original('2026-09-20 09:59:59', now)).toBe(true);
      expect(isStaleKhmer24Original('2026-09-20T03:00:00Z', now)).toBe(false);
      expect(isStaleKhmer24Original('2026-09-20T02:59:59Z', now)).toBe(true);
      expect(isStaleKhmer24Original('2026-10-19', now)).toBe(false);
    });
    test('does not infer staleness for missing or invalid dates', () => {
      expect(isStaleKhmer24Original(undefined, now)).toBe(false);
      expect(isStaleKhmer24Original('3 days ago', now)).toBe(false);
    });
  });
  describe('toHighResImageUrl', () => {
    test('replaces /thumbs/ with /uploads/', () => {
      expect(toHighResImageUrl('https://images.khmer24.co/thumbs/sample.jpg')).toBe(
        'https://images.khmer24.co/uploads/sample.jpg',
      );
    });

    test('replaces /s/ (small) with /l/ (large)', () => {
      // Real Khmer24 CDN uses /s/ as a sub-path separator
      expect(toHighResImageUrl('https://images.khmer24.co/26-06-05/s/villa-front-b.jpg')).toBe(
        'https://images.khmer24.co/26-06-05/l/villa-front-b.jpg',
      );
    });

    test('replaces /m/ (medium) with /l/ (large)', () => {
      expect(toHighResImageUrl('https://images.khmer24.co/m/villa-pool.jpg')).toBe(
        'https://images.khmer24.co/l/villa-pool.jpg',
      );
    });

    test('leaves already full-resolution URLs unchanged', () => {
      const url = 'https://images.khmer24.co/26-06-05/villa-front-b.jpg';
      expect(toHighResImageUrl(url)).toBe(url);
    });
  });

  describe('HTTP detail parser', () => {
    test('does not mistake Khmer24 administrative location.map for a property pin', () => {
      const nodes: unknown[] = [];
      const add = (value: unknown): number => nodes.push(value) - 1;
      const map = add({ x: add('13.35789016603966'), y: add('103.86067953898747'), z: add(15) });
      const location = add({ slug: add('siem-reap'), address: add('603 Wat Bo Rd, Krong Siem Reap'), map });
      add({ id: add('14071624'), posted_date: add('2026-10-01 15:49:55'), location });
      const payload = JSON.stringify(nodes);
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      expect(khmer24SourceLocation(payload, url, 'siem_reap')).toEqual({});
      expect(khmer24SourceLocation(payload, url.replace('14071624', '999'), 'siem_reap')).toEqual({});
      expect(khmer24SourceLocation(payload, url, 'phnom_penh')).toEqual({});
      // The same area centroid appeared in unrelated source ads (14132405,
      // 14132401, 14132396) and must not become a precise property marker.
      const specific = 'https://maps.google.com/maps?q=13.352345,103.865432';
      expect(khmer24SourceLocation(payload, url, 'siem_reap', `Property location: ${specific}`))
        .toEqual({ latitude: 13.352345, longitude: 103.865432, maps_url: specific });
    });

    test('extracts only the matching post map pin, ignoring seller and district coordinates', () => {
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      const payload = detailPostFixture('14071624');
      expect(khmer24SourceLocation(payload, url, 'siem_reap')).toEqual({
        latitude: 13.351234, longitude: 103.864567,
      });
      expect(khmer24SourceLocation(payload, url.replace('14071624', '999'), 'siem_reap')).toEqual({});
      expect(khmer24SourceLocation('{', url, 'siem_reap')).toEqual({});
      expect(khmer24SourceLocation(detailPostFixture('14071624', { map: undefined }), url, 'siem_reap'))
        .toEqual({}); // district coordinates must never become a property pin

      const html = `<script id="__NUXT_DATA__" type="application/json">${payload}</script>
        <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Villa',
          offers: { price: 700, seller: { address: { streetAddress: 'Sala Kamreuk', latitude: 11.55, longitude: 104.92 } } },
        })}</script>`;
      expect(parseKhmer24DetailHtml(html, url, { category: 'house', city: 'siem_reap' }))
        .toMatchObject({ location: 'Sala Kamreuk', latitude: 13.351234, longitude: 103.864567 });
    });

    test('rejects coarse, out-of-city and contradictory coordinates; accepts explicit Google Maps property links', () => {
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      expect(khmer24SourceLocation(detailPostFixture('14071624', {
        latitude: '11.5564', longitude: '104.9282', map: undefined,
      }), url, 'siem_reap')).toEqual({});
      expect(khmer24SourceLocation(detailPostFixture('14071624', {
        latitude: '13.35', longitude: '103.86', map: undefined,
      }), url, 'siem_reap')).toEqual({});
      const propertyMap = 'https://www.google.com/maps/search/?api=1&query=13.352345%2C103.865432';
      expect(khmer24SourceLocation(detailPostFixture('14071624', { map: undefined, maps_url: propertyMap }), url, 'siem_reap'))
        .toMatchObject({ latitude: 13.352345, longitude: 103.865432, maps_url: propertyMap });
      expect(khmer24SourceLocation(detailPostFixture('14071624', {
        map_url: 'https://maps.google.com/?q=11.556400,104.928200',
      }), url, 'siem_reap')).toMatchObject({ latitude: 13.351234, longitude: 103.864567 });
      expect(khmer24SourceLocation(detailPostFixture('14071624', {
        map_url: 'https://maps.google.com/?q=13.389999,103.899999',
      }), url, 'siem_reap').maps_url).toBeUndefined();
    });

    test('does not promote advertising landmarks into coordinates', () => {
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      const emptyPin = detailPostFixture('14071624', { map: undefined });
      const link = 'https://maps.google.com/?q=13.352345,103.865432';
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', `5 minutes to Pub Street ${link}`)).toEqual({});
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', `Near Pub Street: ${link}`)).toEqual({});
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', link)).toEqual({});
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', `Pub Street location: ${link}`)).toEqual({});
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', 'Property location: https://google.evil.com/maps?q=13.352345,103.865432'))
        .toEqual({});
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', `House for rent\nProperty location: ${link}`))
        .toMatchObject({ latitude: 13.352345, longitude: 103.865432, maps_url: link });
      expect(khmer24SourceLocation(emptyPin, url, 'siem_reap', `ទីតាំងផ្ទះ៖ ${link}`))
        .toMatchObject({ latitude: 13.352345, longitude: 103.865432 });
    });

    test('does not mistake a Google Maps camera centre or coarse map query for the house pin', () => {
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      const noPin = detailPostFixture('14071624', { map: undefined });
      const cameraOnly = 'https://www.google.com/maps/place/Villa/@13.351234,103.864567,17z';
      const coarseQuery = 'https://maps.google.com/?q=13.35,103.86';
      expect(khmer24SourceLocation(noPin, url, 'siem_reap', `Property location: ${cameraOnly}`)).toEqual({});
      expect(khmer24SourceLocation(noPin, url, 'siem_reap', `Property location: ${coarseQuery}`)).toEqual({});
      expect(khmer24SourceLocation(detailPostFixture('14071624', { maps_url: cameraOnly }), url, 'siem_reap'))
        .toEqual({ latitude: 13.351234, longitude: 103.864567 });
      const llCameraOnly = 'https://maps.google.com/maps?ll=13.352345,103.865432';
      expect(khmer24SourceLocation(noPin, url, 'siem_reap', `Property location: ${llCameraOnly}`)).toEqual({});
      const selectedPlace = 'https://www.google.com/maps/place/Villa/@13.390000,103.890000,17z/data=!3d13.352345!4d103.865432';
      expect(khmer24SourceLocation(noPin, url, 'siem_reap', `Property location: ${selectedPlace}`))
        .toMatchObject({ latitude: 13.352345, longitude: 103.865432, maps_url: selectedPlace });
      const conflictingPlace = 'https://www.google.com/maps/place/Villa/@13.351234,103.864567,17z/data=!3d13.390000!4d103.890000';
      expect(khmer24SourceLocation(detailPostFixture('14071624', { maps_url: conflictingPlace }), url, 'siem_reap'))
        .toEqual({ latitude: 13.351234, longitude: 103.864567 });
    });

    test('falls back to a property-labelled map link when the Nuxt map is unusable', () => {
      const url = 'https://www.khmer24.com/en/post-adid-14071624';
      const correctMap = 'https://maps.google.com/?q=13.352345,103.865432';
      const description = `House for rent\nProperty location: ${correctMap}`;
      const wrongCity = 'https://maps.google.com/?q=11.556400,104.928200';
      const camera = 'https://www.google.com/maps/place/Somewhere/@13.351234,103.864567,17z';
      for (const sourceMap of [wrongCity, camera, 'https://maps.app.goo.gl/shortid']) {
        const result = khmer24SourceLocation(detailPostFixture('14071624', {
          map: undefined, maps_url: sourceMap,
        }), url, 'siem_reap', description);
        expect(result).toEqual({ latitude: 13.352345, longitude: 103.865432, maps_url: correctMap });
      }

      // An explicit Nuxt pin wins; text GPS that disagrees must not override it.
      expect(khmer24SourceLocation(detailPostFixture('14071624', {
        maps_url: wrongCity,
      }), url, 'siem_reap', `House location: https://maps.google.com/?q=13.390000,103.890000`))
        .toEqual({ latitude: 13.351234, longitude: 103.864567 });
      // Without GPS evidence, a recognized shortlink remains navigable but is not exact.
      expect(khmer24SourceLocation(detailPostFixture('14071624', {
        map: undefined, maps_url: 'https://maps.app.goo.gl/shortid',
      }), url, 'siem_reap')).toEqual({ maps_url: 'https://maps.app.goo.gl/shortid' });
    });
    test('uses the matching Nuxt original posted_date, never renew_date or another ad date', () => {
      const values: unknown[] = [];
      const add = (value: unknown): number => values.push(value) - 1;
      const otherId = add('99999999');
      const unrelated = add('2026-10-17 11:00:00');
      const requestedId = add('13600381');
      const original = add('2026-06-03 09:19:42');
      const renewal = add('2026-10-10 09:58:30');
      add({ id: otherId, posted_date: unrelated });
      add({ id: requestedId, posted_date: original, renew_date: renewal });
      const payload = JSON.stringify(values);
      const url = 'https://www.khmer24.com/en/house-for-rent-adid-13600381';
      expect(khmer24OriginalPostedAt(payload, url)).toBe('2026-06-03 09:19:42');
      expect(khmer24OriginalPostedAt(payload, 'https://www.khmer24.com/en/house-adid-500')).toBeUndefined();
      expect(khmer24OriginalPostedAt('{', url)).toBeUndefined();
      expect(khmer24OriginalPostedAt(payload, 'https://example.com/house')).toBeUndefined();

      const html = `<script id="__NUXT_DATA__" type="application/json">${payload}</script>
        <meta property="article:published_time" content="2026-10-12T12:00:00Z">
        <meta property="article:modified_time" content="2026-10-17T12:00:00Z">
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'Product', name: 'House for rent', datePublished: '2026-10-10 09:58:30',
          description: 'House', offers: { price: '400', priceCurrency: 'USD' },
        })}</script>`;
      const target = { category: 'house' as const, city: 'siem_reap' as const, type: 'rent' as const };
      expect(parseKhmer24DetailHtml(html, url, target).posted_at).toBe('2026-06-03 09:19:42');
      expect(parseKhmer24DetailHtml(html, 'https://www.khmer24.com/en/house-adid-500', target).posted_at)
        .toBe('2026-10-10 09:58:30');
    });

    test('extracts a listing from Product JSON-LD', () => {
      const html = `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Apartment for rent',
        description: 'Central apartment',
        image: ['https://images.khmer24.co/a.jpg'],
        offers: {
          price: '350.00',
          priceCurrency: 'USD',
          seller: { telephone: ['012345678'], address: { streetAddress: 'BKK1' } },
        },
      })}</script>`;
      const listing = parseKhmer24DetailHtml(html, 'https://www.khmer24.com/en/test-adid-1', {
        category: 'apartment',
        city: 'phnom_penh',
        type: 'rent',
      });
      expect(listing).toMatchObject({
        title: 'Apartment for rent', source_title: 'Apartment for rent',
        price: 350, source_price: 350, source_price_currency: 'USD',
        source_price_origin: 'khmer24_json_ld_offer', phone: '012345678', location: 'BKK1',
      });
    });

    test('preserves a Product publication date instead of a page modification date', () => {
      const html = `<meta property="article:modified_time" content="2026-10-16T13:00:00+07:00">
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'Product', name: 'House for rent', datePublished: '2025-07-04 10:44:28',
          description: 'House', offers: { price: '400', priceCurrency: 'USD' },
        })}</script>`;
      const listing = parseKhmer24DetailHtml(html, 'https://www.khmer24.com/en/house-adid-11874025', {
        category: 'house', city: 'siem_reap', type: 'rent',
      });
      expect(listing.posted_at).toBe('2025-07-04 10:44:28');
    });

    test('accepts an explicit publication meta tag and rejects relative/invalid timestamps', () => {
      const html = `<meta property="article:published_time" content="2026-10-16T10:47:49+07:00">
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'Product', name: 'House for rent', description: 'House', offers: { price: '450' },
        })}</script>`;
      const listing = parseKhmer24DetailHtml(html, 'https://www.khmer24.com/en/house-adid-12931590', {
        category: 'house', city: 'siem_reap', type: 'rent',
      });
      expect(listing.posted_at).toBe('2026-10-16T10:47:49+07:00');
      expect(listing.source_price).toBe(450);
      expect(listing.source_price_currency).toBeUndefined();
      expect(listing.source_price_origin).toBe('khmer24_json_ld_offer');
      expect(khmer24PublishedAt('yesterday')).toBeUndefined();
      expect(khmer24PublishedAt('2026-10-16T10:47:49+07:00')).toBe('2026-10-16T10:47:49+07:00');
    });
  });

  describe('KHMER24_TARGETS configuration', () => {
    test('has three Siem Reap monthly-rental targets for the MVP', () => {
      expect(KHMER24_TARGETS).toHaveLength(3);
      expect(KHMER24_TARGETS.every((target) => target.city === 'siem_reap' && target.type === 'rent')).toBe(true);
    });

    test('covers house, apartment, and room categories', () => {
      const categories = KHMER24_TARGETS.map((t) => t.category);
      expect(categories).toContain('house');
      expect(categories).toContain('apartment');
      expect(categories).toContain('room');
    });

    test('category slugs match expected Khmer24 API slugs', () => {
      const slugs = KHMER24_TARGETS.map((t) => t.categorySlug);
      expect(slugs).toContain('house-for-rent');
      expect(slugs).toContain('apartment-for-rent');
      expect(slugs).toContain('room-for-rent');
      expect(slugs.some((slug) => slug.includes('sale'))).toBe(false);
    });

    test('filters Khmer24 by province, not the ignored location parameter', () => {
      const url = new URL(buildFeedPageUrl(KHMER24_TARGETS[0]));
      expect(url.searchParams.get('province')).toBe('siem-reap');
      expect(url.searchParams.has('location')).toBe(false);
      expect(url.searchParams.get('sortby')).toBe('newads');
      expect(url.searchParams.get('date')).toBe('last-7-days');
    });
  });

  describe('Nuxt feed province filtering', () => {
    test('skips promoted posts from other provinces BEFORE applying the page limit', () => {
      const payload = nuxtFeedFixture([
        { link: '/post-adid-1', province: 'phnom-penh' },
        { link: '/post-adid-2', province: 'preah-sihanouk' },
        { link: '/post-adid-3', province: 'phnom-penh' },
        { link: '/post-adid-4', province: 'phnom-penh' },
        { link: '/post-adid-5', province: 'siem-reap' },
        { link: '/post-adid-6', province: 'siem-reap' },
        { link: '/post-adid-7', province: 'siem-reap' },
      ]);
      expect(parseKhmer24FeedNuxtData(payload, KHMER24_TARGETS[0], 2)).toEqual([
        'https://www.khmer24.com/post-adid-5',
        'https://www.khmer24.com/post-adid-6',
      ]);
    });

    test('rejects missing or wrong province/category, duplicate URLs, and off-site links', () => {
      const payload = nuxtFeedFixture([
        { link: '/post-adid-1' },
        { link: '/post-adid-2', province: 'siem-reap', category: 'room-for-rent' },
        { link: 'https://example.com/post-adid-3', province: 'siem-reap' },
        { link: '/post-adid-4?ref=feed', province: 'siem-reap' },
        { link: '/post-adid-4', province: 'siem-reap' },
      ]);
      expect(parseKhmer24FeedNuxtData(payload, KHMER24_TARGETS[0], 10)).toEqual([
        'https://www.khmer24.com/post-adid-4',
      ]);
      expect(parseKhmer24FeedNuxtData('{', KHMER24_TARGETS[0], 10)).toEqual([]);
      expect(parseKhmer24FeedNuxtData('', KHMER24_TARGETS[0], 10)).toEqual([]);
    });
  });
});
