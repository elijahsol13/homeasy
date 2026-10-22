/**
 * Optional local browser integration smoke (no live data/services).
 * Run: node tests/mini-app-browser-smoke.cjs
 * Requires loopback listeners and a locally installed Chrome/Chromium.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

require('ts-node/register/transpile-only');

const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createContainer } = require('../src/container');
const { env } = require('../src/config/env');
const { runMigrations } = require('../src/database/migrate');
const { SourceIngestionRepository } = require('../src/database/repositories/source-ingestion.repo');
const { CanonicalShadowService } = require('../src/modules/parser/canonical-dedupe');
const { buildApiServer } = require('../src/modules/api/server');

const projectRoot = path.resolve(__dirname, '..');
const webRoot = path.join(projectRoot, 'webapp');
const cases = [
  { rooms: 2, price: 200 },
  { rooms: 3, price: 300 },
  { rooms: 4, price: 400 },
  { rooms: 5, price: 500 },
  { rooms: 6, price: 600 },
  { rooms: null, price: 700 },
];

async function main() {
  const oldReadPath = env.LISTING_READ_PATH;
  const oldShadow = env.LISTING_READ_SHADOW;
  const oldViteApi = process.env.VITE_API_URL;
  let api;
  let vite;
  let browser;
  let db;

  try {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    const container = createContainer({ db });
    const sources = new SourceIngestionRepository(db);
    const sourceId = sources.upsertSource({
      sourceType: 'FACEBOOK_GROUP', externalSourceId: 'mini-app-browser-smoke', name: 'Browser smoke fixtures',
    });
    for (const [i, offer] of cases.entries()) {
      const title = `Integration ${i} ${offer.rooms ?? 'unknown'} bedrooms`;
      sources.upsertSourceItemDetailed(sourceId, {
        sourceType: 'FACEBOOK_GROUP', externalId: `browser-${i}`,
        sourceUrl: `https://facebook.com/groups/mini-app-browser-smoke/posts/${i}`,
        contentHash: `browser-${i}`,
        rawText: `${title}: separate Siem Reap rental for $${offer.price}/month`,
        classification: 'HOUSING_SUPPLY',
        rawPayload: { listingExtraction: {
          title_en: title, description_en: `Apartment ${i} in Siem Reap`,
          price: offer.price, currency: 'USD', category: 'apartment',
          bedrooms: offer.rooms, bathrooms: 1, city: 'siem_reap',
          sangkat: 'Wat Bo', offer_type: 'rent', min_lease_months: 6,
        }, photos: [] },
      });
    }
    new CanonicalShadowService(db).run({ dryRun: false });
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved'").run();
    db.prepare("UPDATE canonical_listings SET bedrooms=NULL, price=0 WHERE title LIKE 'Integration 5 %'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM canonical_listings').get().n, 6);

    env.LISTING_READ_PATH = 'canonical';
    env.LISTING_READ_SHADOW = false;
    api = await buildApiServer({ container, logger: false });
    const apiAddress = await api.listen({ host: '127.0.0.1', port: 0 });
    process.env.VITE_API_URL = `${apiAddress}/api/v1`;

    const viteModule = require.resolve('vite', { paths: [webRoot] });
    const { createServer } = await import(pathToFileURL(viteModule).href);
    vite = await createServer({
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    await vite.listen();
    const uiAddress = `http://127.0.0.1:${vite.httpServer.address().port}`;

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    // Keep the test offline: only the two temporary loopback listeners may be contacted.
    await page.route('**/*', (route) => {
      try {
        if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
      } catch { /* abort an unparsable address */ }
      return route.abort();
    });
    const cardTitles = () => page.locator('h3').filter({ hasText: /^Integration \d/ }).allTextContents();

    await page.goto(uiAddress);
    await page.waitForFunction(() => [...document.querySelectorAll('h3')]
      .filter((el) => /^Integration \d/.test(el.textContent || '')).length === 6);
    assert.equal((await cardTitles()).length, 6, 'first launch should render six SQLite listings');
    assert.equal(await page.getByRole('button', { name: 'Newest', exact: true }).getAttribute('aria-pressed'), 'true');
    console.log('PASS: real browser initial React feed from HTTP + SQLite (A)');

    const filteredResponse = page.waitForResponse((response) => response.url().includes('/properties?')
      && new URL(response.url()).searchParams.get('bedrooms') === '4');
    await page.getByRole('button', { name: 'Open Filters' }).click();
    await page.getByRole('button', { name: '4+ BR' }).click();
    await page.getByRole('button', { name: 'Show Listings' }).click();
    const filtered = await (await filteredResponse).json();
    assert.deepEqual(filtered.items.map((item) => item.bedrooms).sort((a, b) => a - b), [4, 5, 6]);
    await page.waitForFunction(() => [...document.querySelectorAll('h3')]
      .filter((el) => /^Integration \d/.test(el.textContent || '')).length === 3);
    console.log('PASS: FilterDrawer 4+ BR excludes unknown bedrooms in rendered cards (B, C)');

    const sortedResponse = page.waitForResponse((response) => response.url().includes('/properties?')
      && new URL(response.url()).searchParams.get('sort') === 'price_desc');
    await page.getByRole('button', { name: 'Most expensive' }).click();
    const sorted = await (await sortedResponse).json();
    assert.deepEqual(sorted.items.map((item) => item.priceUsd), [600, 500, 400]);
    await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent?.includes('Most expensive'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent?.includes('Most expensive'));
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('homeasy_filters') || '{}'));
    assert.deepEqual(persisted.bedrooms, [4]);
    assert.equal(persisted.sort, 'price_desc');
    console.log('PASS: real sort, reload and restored 4+ BR selection (D, F)');

    // Verify the map inherits the applied bedroom filter through a real browser request.
    const filteredMapResponse = page.waitForResponse((response) => response.url().includes('/properties/map?')
      && new URL(response.url()).searchParams.get('bedrooms') === '4');
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    const filteredMap = await filteredMapResponse;
    assert.equal(filteredMap.status(), 200);
    const mapBody = await filteredMap.json();
    assert.ok(mapBody.markers.every((marker) => marker.bedrooms == null || marker.bedrooms >= 4));
    const visibleOffers = mapBody.markers.reduce((count, marker) => count + (marker.count ?? 1), 0);
    assert.equal(visibleOffers, 3, 'map exact pins and cluster counts must represent the same filtered cohort');
    await page.getByRole('button', { name: 'Explore', exact: true }).click();
    console.log('PASS: applied bedroom filters reach the map API in a real browser (G)');

    await page.evaluate(() => localStorage.setItem('homeasy_filters', '{broken-json'));
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll('h3')]
      .filter((el) => /^Integration \d/.test(el.textContent || '')).length === 6);
    assert.equal(await page.getByRole('button', { name: 'Newest', exact: true }).getAttribute('aria-pressed'), 'true');
    const bad = await fetch(`${apiAddress}/api/v1/properties?bedrooms=4&max_price=invalid`);
    assert.equal(bad.status, 400);
    console.log('PASS: malformed storage recovery and real HTTP 400 (F, H)');

    const mapResponse = page.waitForResponse((response) => response.url().includes('/properties/map?'));
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    const mapResult = await mapResponse;
    assert.equal(mapResult.status(), 200);
    await page.locator('.leaflet-container').waitFor();
    console.log('PASS: live React map tab makes a successful HTTP map request (G)');

    const firstPin = page.locator('.leaflet-marker-icon').first();
    if (await firstPin.count()) {
      await firstPin.click();
      const viewAsList = page.getByRole('button', { name: /View as list/ });
      if (await viewAsList.count()) {
        const clusterResponse = page.waitForResponse((response) => response.url().includes('/properties?')
          && new URL(response.url()).searchParams.has('map_cluster_key'));
        await viewAsList.click();
        assert.equal((await clusterResponse).status(), 200);
        console.log('PASS: district map cluster → real HTTP filtered feed (G)');
      } else {
        await page.getByRole('button', { name: 'Explore', exact: true }).click();
        console.log('INFO: selected map pin did not expose a district cluster');
      }
    } else {
      await page.getByRole('button', { name: 'Explore', exact: true }).click();
      console.log('INFO: map fixture returned no clickable pin in the default viewport');
    }

    // Fault injection exercises the real browser's error UI without stopping
    // the temporary API or risking production services.
    const listRoute = '**/api/v1/properties?*';
    await page.route(listRoute, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ message: 'Injected server failure' }),
    }));
    await page.getByRole('button', { name: 'Cheapest' }).click();
    await page.getByText('Failed to fetch properties: Internal Server Error').waitFor();
    assert.equal((await cardTitles()).length, 0, 'failed refresh must hide previous listings');
    await page.unroute(listRoute);
    await page.getByRole('button', { name: 'Newest', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('h3')]
      .some((el) => /^Integration \d/.test(el.textContent || '')));

    await page.route(listRoute, (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Cheapest' }).click();
    await page.getByText('Failed to fetch').waitFor();
    assert.equal((await cardTitles()).length, 0, 'network failure must hide previous listings');
    await page.unroute(listRoute);
    await page.getByRole('button', { name: 'Newest', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('h3')]
      .some((el) => /^Integration \d/.test(el.textContent || '')));
    console.log('PASS: browser HTTP 500/network fault injection hides stale cards and recovers (H)');
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (api) await api.close();
    if (db) db.close();
    env.LISTING_READ_PATH = oldReadPath;
    env.LISTING_READ_SHADOW = oldShadow;
    if (oldViteApi === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = oldViteApi;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
