/**
 * Opt-in, anonymous usage analytics for both Homeasy surfaces.
 *
 * Only allow-listed action properties leave the app. PostHog's own automatic
 * URL/referrer/campaign enrichment is stripped again immediately before send.
 * The public PostHog project key is optional and never blocks the UI.
 */
type PostHogClient = typeof import('posthog-js')['default'];
import { isWebSurface } from './platform';
export type AnalyticsConsent = 'unknown' | 'accepted' | 'declined';

const CONSENT_KEY = 'homeasy_analytics_consent_v1';
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.-]{0,79}$/i;
const SAFE_CITY = /^[a-z][a-z _-]{0,47}$/i;
const SAFE_DOMAIN = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;
const NUMERIC_KEYS = new Set([
  'propertyId', 'count', 'total', 'page', 'position', 'selectedCount',
  'selected_count', 'duration', 'durationMs', 'duration_ms', 'results_count',
  'location_count', 'has_price',
]);
const TOKEN_KEYS = new Set([
  'listingRef', 'listing_ref', 'source', 'channel', 'filter_type', 'sort',
  'stage', 'code', 'error_code', 'status', 'active_tab', 'property_type', 'page_type',
]);
const BOOLEAN_KEYS = new Set(['isFavorite', 'has_results']);
const CONTACT_CHANNELS = new Set(['telegram', 'whatsapp', 'phone']);

let consentOverride: AnalyticsConsent | undefined;
let clientPromise: Promise<PostHogClient | null> | undefined;
let appOpened = false;
let lastPageKey: string | undefined;
let attribution: Record<string, string> | undefined;

export function isAnalyticsConfigured(): boolean {
  return Boolean(import.meta.env.VITE_POSTHOG_API_KEY?.trim());
}

export function getAnalyticsConsent(): AnalyticsConsent {
  if (consentOverride) return consentOverride;
  try {
    const saved = typeof window === 'undefined' ? null : window.localStorage.getItem(CONSENT_KEY);
    return saved === 'accepted' || saved === 'declined' ? saved : 'unknown';
  } catch {
    return 'unknown';
  }
}

function canTrack(): boolean {
  return isAnalyticsConfigured() && getAnalyticsConsent() === 'accepted';
}

function surface(): 'web' | 'telegram' {
  return isWebSurface() ? 'web' : 'telegram';
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

function landing(): string {
  if (typeof window === 'undefined') return 'unknown';
  if (/^\/listing\/[^/]+\/?$/.test(window.location.pathname)) return 'listing';
  if (window.location.pathname === '/') return 'catalog';
  return /^\/(map|saved|privacy)\/?$/.exec(window.location.pathname)?.[1] ?? 'other';
}

function initialAttribution(): Record<string, string> {
  if (attribution) return attribution;
  const result: Record<string, string> = { landing: landing() };
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    for (const name of UTM_KEYS) {
      const token = safeToken(params.get(name));
      if (token) result[name] = token;
    }
    try {
      const referrer = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : '';
      if (SAFE_DOMAIN.test(referrer) && referrer.length <= 253) {
        result.referrer_domain = referrer;
      }
    } catch {
      // Malformed referrer is ignored.
    }
  }
  result.entry_point = surface() === 'telegram' ? 'telegram'
    : UTM_KEYS.some((key) => key in result) ? 'campaign'
      : result.referrer_domain ? 'referral' : 'direct';
  attribution = result;
  return result;
}

/** Public catalog IDs are safe; caller-supplied free text, URLs and contact data are not. */
function actionProperties(properties: Record<string, unknown>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (NUMERIC_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      result[key] = value;
    } else if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
      result[key] = value;
    } else if (key === 'city' && typeof value === 'string' && SAFE_CITY.test(value)) {
      result[key] = value;
    } else if (TOKEN_KEYS.has(key)) {
      const token = safeToken(value);
      if (token && (key !== 'channel' || CONTACT_CHANNELS.has(token))) result[key] = token;
    }
  }
  return result;
}

/** Second privacy boundary: PostHog may add automatic properties after capture(). */
function beforeSend<T extends { properties?: Record<string, unknown> } | null>(event: T): T {
  if (!event?.properties) return event;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties)) {
    // PostHog requires its own configured project token on every event.
    if (key === 'token') {
      if (value === import.meta.env.VITE_POSTHOG_API_KEY) properties[key] = value;
    } else if (['distinct_id', '$distinct_id', '$session_id', '$window_id'].includes(key)) {
      const id = safeToken(value);
      if (id) properties[key] = id;
    } else if (key === '$device_type') {
      const device = safeToken(value);
      if (device && ['Desktop', 'Mobile', 'Tablet'].includes(device)) properties[key] = device;
    } else if (NUMERIC_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      properties[key] = value;
    } else if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
      properties[key] = value;
    } else if (key === 'city' && typeof value === 'string' && SAFE_CITY.test(value)) {
      properties[key] = value;
    } else if (key === 'referrer_domain' && typeof value === 'string' && SAFE_DOMAIN.test(value) && value.length <= 253) {
      properties[key] = value;
    } else if (TOKEN_KEYS.has(key) || ['surface', 'release', 'consent', 'entry_point', 'landing', ...UTM_KEYS].includes(key)) {
      const token = safeToken(value);
      if (token && (key !== 'channel' || CONTACT_CHANNELS.has(token))) properties[key] = token;
    }
  }
  return { ...event, properties };
}

function getClient(): Promise<PostHogClient | null> {
  if (!canTrack()) return Promise.resolve(null);
  const key = import.meta.env.VITE_POSTHOG_API_KEY as string;
  clientPromise ??= import('posthog-js')
    .then(({ default: posthog }) => {
      if (!canTrack()) {
        clientPromise = undefined;
        return null;
      }
      posthog.init(key, {
        api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        person_profiles: 'never',
        persistence: 'localStorage',
        opt_out_capturing_by_default: true,
        opt_out_persistence_by_default: true,
        save_campaign_params: false,
        save_referrer: false,
        mask_personal_data_properties: true,
        disable_surveys: true,
        disable_external_dependency_loading: true,
        advanced_disable_feature_flags: true,
        advanced_disable_decide: true,
        ip: false,
        before_send: beforeSend,
      });
      if (!canTrack()) {
        posthog.opt_out_capturing();
        return null;
      }
      posthog.opt_in_capturing();
      return posthog;
    })
    .catch(() => {
      console.warn('[PostHog] Analytics unavailable');
      return null;
    });
  return clientPromise;
}

/** Persist an explicit choice; opt-out stops all further capture immediately. */
export function setAnalyticsConsent(choice: 'accepted' | 'declined'): void {
  const previous = getAnalyticsConsent();
  consentOverride = choice;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Private browsing may prohibit storage; the choice still works this visit.
  }

  if (choice === 'declined') {
    appOpened = false;
    lastPageKey = undefined;
    if (clientPromise) {
      void clientPromise.then((client) => {
        try { client?.opt_out_capturing(); } catch { /* never break the UI */ }
      });
    }
  } else if (previous !== 'accepted') {
    if (clientPromise) {
      void clientPromise.then((client) => {
        try { if (canTrack()) client?.opt_in_capturing(); } catch { /* optional */ }
      });
    }
    initializeAnalytics();
  }
}

/** Called on entry; safe to call repeatedly, including with React StrictMode. */
export function initializeAnalytics(): void {
  if (!canTrack()) return;
  if (!appOpened) {
    appOpened = true;
    captureEvent('app_opened', {});
  }
  capturePageView();
}

/** Call when an actual SPA route changes. Repeated effects for the same URL are ignored. */
export function capturePageView(): void {
  if (!canTrack()) return;
  const route = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
  if (route === lastPageKey) return;
  lastPageKey = route;
  captureEvent('$pageview', { page_type: landing() });
}

/**
 * Telegram SDK still calls this entry point; intentionally keep guests and
 * Telegram users anonymous. Numeric Telegram IDs and profile data never leave.
 */
export function identifyTelegramUser(_user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}): void {
  // Anonymous PostHog identity is generated only after explicit opt-in.
}

/** Only allow-listed data is sent; PostHog failure is never propagated to callers. */
export function captureEvent(event: string, properties: Record<string, unknown> = {}): void {
  if (!canTrack() || !/^\$?[a-z][a-z0-9_]{1,63}$/.test(event)) return;
  const safe = {
    ...actionProperties(properties),
    ...initialAttribution(),
    surface: surface(),
    release: safeToken(import.meta.env.VITE_RELEASE) || 'unversioned',
    consent: 'accepted',
  };
  void getClient().then((posthog) => {
    if (!canTrack() || !posthog) return;
    try {
      posthog.capture(event, safe);
    } catch {
      console.warn('[PostHog] Capture unavailable');
    }
  });
}
