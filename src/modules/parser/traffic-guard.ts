import type { Page, Route, Request } from 'playwright';

export interface TrafficGuardOptions {
  /** If true, allows CSS stylesheets (e.g. for login or visual rendering). Default: false (aborts stylesheets) */
  allowStylesheets?: boolean;
  /** If true, allows images (NEVER recommended on residential proxy). Default: false */
  allowImages?: boolean;
  /** Additional URL substrings to abort */
  extraBlockedPatterns?: string[];
}

/**
 * Attaches strict resource-blocking routes to a Playwright Page to eliminate unnecessary
 * data transfer over expensive residential proxies.
 *
 * 🛡️ IRONCLAD RULE: Residential proxy bandwidth is paid per GB and must never be wasted.
 * We extract text, metadata, and photo URL strings from HTML/JSON. We NEVER download image/video binaries!
 *
 * Bandwidth reduction: 90% - 98% per page load.
 */
export async function attachTrafficGuard(
  page: Page,
  options: TrafficGuardOptions = {},
): Promise<void> {
  const { allowStylesheets = false, allowImages = false, extraBlockedPatterns = [] } = options;

  await page.route('**/*', (route: Route) => {
    const req: Request = route.request();
    const type = req.resourceType();
    const url = req.url().toLowerCase();

    // 1. Block heavy binary media and fonts
    if (['media', 'font', 'other'].includes(type)) {
      return route.abort();
    }

    // 2. Block images unless explicitly requested (images are 80%+ of total page weight)
    if (!allowImages && type === 'image') {
      return route.abort();
    }

    // 3. Block stylesheets for headless scrapers (CSS is useless for DOM/JSON extraction)
    if (!allowStylesheets && type === 'stylesheet') {
      return route.abort();
    }

    // 4. Block analytics, trackers, telemetry, and logging beacons
    if (
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('doubleclick') ||
      url.includes('connect.facebook.net') ||
      url.includes('facebook.com/tr/') ||
      url.includes('facebook.com/ajax/bz') ||
      url.includes('logging_client_events') ||
      url.includes('onesignal') ||
      url.includes('pixel') ||
      url.includes('video') ||
      url.includes('audio') ||
      extraBlockedPatterns.some((pattern) => url.includes(pattern))
    ) {
      return route.abort();
    }

    return route.continue();
  });
}
