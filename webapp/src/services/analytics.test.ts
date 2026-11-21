import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const client = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: client }));

async function initialized() {
  await vi.waitFor(() => expect(client.init).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(client.capture).toHaveBeenCalled());
}

describe('privacy-safe PostHog analytics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    history.replaceState({}, '', '/');
    vi.stubEnv('VITE_POSTHOG_API_KEY', 'test-key');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://analytics.example.test');
    vi.stubEnv('VITE_RELEASE', '2026-11-10');
    vi.stubEnv('MODE', 'web');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete window.Telegram;
  });

  it('does nothing before explicit consent', async () => {
    const analytics = await import('./analytics');
    expect(analytics.getAnalyticsConsent()).toBe('unknown');
    analytics.initializeAnalytics();
    analytics.identifyTelegramUser({ id: 42, first_name: 'Alice', username: 'private' });
    analytics.captureEvent('contact_lead_clicked', { channel: 'phone' });
    analytics.capturePageView();
    await Promise.resolve();
    expect(client.init).not.toHaveBeenCalled();
    expect(client.identify).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('does nothing without an API key even with consent', async () => {
    vi.stubEnv('VITE_POSTHOG_API_KEY', '');
    const analytics = await import('./analytics');
    expect(analytics.isAnalyticsConfigured()).toBe(false);
    analytics.setAnalyticsConsent('accepted');
    analytics.captureEvent('contact_lead_clicked', { channel: 'phone' });
    await Promise.resolve();
    expect(client.init).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('initializes after consent, sends safe campaign metadata, and never identifies Telegram PII', async () => {
    history.replaceState({}, '', '/listing/HM-123?utm_source=facebook&utm_medium=social&utm_campaign=launch&utm_content=alice%40example.com');
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://news.example.org/path?secret=123');
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    analytics.initializeAnalytics();
    analytics.identifyTelegramUser({ id: 42, username: 'secret', first_name: 'Alice' });
    await initialized();
    expect(client.init).toHaveBeenCalledWith('test-key', expect.objectContaining({
      autocapture: false, capture_pageview: false, capture_pageleave: false,
      disable_session_recording: true, person_profiles: 'never',
      save_referrer: false, save_campaign_params: false,
    }));
    expect(client.identify).not.toHaveBeenCalled();
    expect(client.capture).toHaveBeenCalledWith('app_opened', expect.objectContaining({
      surface: 'web', release: '2026-11-10', consent: 'accepted', landing: 'listing',
      referrer_domain: 'news.example.org', entry_point: 'campaign',
      utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'launch',
    }));
    expect(client.capture).toHaveBeenCalledWith('$pageview', expect.objectContaining({ page_type: 'listing' }));
    const all = JSON.stringify(client.capture.mock.calls);
    expect(all).not.toMatch(/Alice|secret=|private|alice%40|@example|https:/);
  });

  it.each([
    ['/map', 'map'],
    ['/saved/', 'saved'],
    ['/privacy?utm_source=directory', 'privacy'],
  ])('classifies %s as %s in anonymous pageviews and entry attribution', async (path, pageType) => {
    history.replaceState({}, '', path);
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    expect(client.capture).toHaveBeenCalledWith('$pageview', expect.objectContaining({ page_type: pageType }));
    expect(client.capture).toHaveBeenCalledWith('app_opened', expect.objectContaining({ landing: pageType }));
  });

  it('deduplicates StrictMode and same-route pageviews but tracks actual SPA navigation', async () => {
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    analytics.initializeAnalytics();
    analytics.capturePageView();
    history.pushState({}, '', '/listing/abc?utm_source=one');
    analytics.capturePageView();
    analytics.capturePageView();
    history.pushState({}, '', '/');
    analytics.capturePageView();
    await vi.waitFor(() => expect(client.capture.mock.calls.filter(([name]) => name === '$pageview')).toHaveLength(3));
    expect(client.capture.mock.calls.filter(([name]) => name === '$pageview').map(([, props]) => props.page_type))
      .toEqual(['catalog', 'listing', 'catalog']);
    expect(client.capture.mock.calls.filter(([name]) => name === 'app_opened')).toHaveLength(1);
  });

  it('retains existing contact properties and removes unknown, PII, or caller-forged fields', async () => {
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    client.capture.mockClear();
    analytics.captureEvent('contact_lead_clicked', {
      propertyId: 30, listingRef: 'HM-123', channel: 'whatsapp', source: 'detail',
      surface: 'telegram', release: 'forged', first_name: 'Alice', username: 'secret',
      phone: '+85512345678', url: 'https://facebook.com/person', query: 'personal search',
      city: 'Phnom Penh',
    });
    await vi.waitFor(() => expect(client.capture).toHaveBeenCalledOnce());
    expect(client.capture).toHaveBeenCalledWith('contact_lead_clicked', expect.objectContaining({
      propertyId: 30, listingRef: 'HM-123', channel: 'whatsapp', source: 'detail',
      surface: 'web', release: '2026-11-10', city: 'Phnom Penh',
    }));
    const props = client.capture.mock.calls[0][1];
    for (const key of ['first_name', 'username', 'phone', 'url', 'query']) {
      expect(props).not.toHaveProperty(key);
    }
  });

  it('keeps safe filter counts without sending the visitor\'s search or price values', async () => {
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    client.capture.mockClear();
    analytics.captureEvent('filter_applied', {
      city: 'Siem Reap', location_count: 2, has_price: 1,
      minPrice: 250, maxPrice: 800, query: 'private apartment search',
    });
    await vi.waitFor(() => expect(client.capture).toHaveBeenCalledOnce());
    expect(client.capture).toHaveBeenCalledWith('filter_applied', expect.objectContaining({
      city: 'Siem Reap', location_count: 2, has_price: 1,
    }));
    expect(client.capture.mock.calls[0][1]).not.toHaveProperty('minPrice');
    expect(client.capture.mock.calls[0][1]).not.toHaveProperty('maxPrice');
    expect(client.capture.mock.calls[0][1]).not.toHaveProperty('query');
  });

  it('sanitizes PostHog-added URL, referrer, raw UTM and identity fields before sending', async () => {
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    const config = client.init.mock.calls[0][1] as {
      before_send: (event: { event: string; properties: Record<string, unknown> }) => { properties: Record<string, unknown> };
    };
    const event = config.before_send({ event: 'contact_lead_clicked', properties: {
      '$current_url': 'https://example.com/?private=1',
      '$referrer': 'https://search.example/?name=Alice',
      '$initial_current_url': 'https://example.com/?q=Alice',
      '$initial_utm_campaign': 'alice@example.com',
      '$user_id': 42, '$device_type': 'Desktop',
      '$session_id': '019a76ce-2dcf-73a1-a85c-e27a5482d995',
      arbitrary_metadata: 'user@example.com',
      geolocation: 'exact home address',
      '$custom_profile_blob': 'secret',
      distinct_id: '01a1c548-de74-77e0-9b40-61de29dfb670',
      utm_source: 'alice@example.com', surface: 'web', listingRef: 'HM-123',
    } });
    expect(event.properties).toEqual({
      '$device_type': 'Desktop', surface: 'web', listingRef: 'HM-123',
      '$session_id': '019a76ce-2dcf-73a1-a85c-e27a5482d995',
      distinct_id: '01a1c548-de74-77e0-9b40-61de29dfb670',
    });
  });

  it('keeps the SDK-required public project token while dropping any unrecognized token', async () => {
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    const config = client.init.mock.calls[0][1] as {
      before_send: (event: { event: string; properties: Record<string, unknown> }) => { properties: Record<string, unknown> };
    };
    const valid = config.before_send({ event: 'app_opened', properties: {
      token: 'test-key', surface: 'web', '$current_url': 'https://example.com/private',
    } });
    expect(valid.properties).toEqual({ token: 'test-key', surface: 'web' });
    const invalid = config.before_send({ event: 'app_opened', properties: {
      token: 'forged-key', surface: 'web', '$current_url': 'https://example.com/private',
    } });
    expect(invalid.properties).toEqual({ surface: 'web' });
  });

  it('immediately opts out and can resume after re-opt-in', async () => {
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    client.capture.mockClear();
    analytics.setAnalyticsConsent('declined');
    analytics.captureEvent('contact_lead_clicked', { channel: 'phone' });
    await vi.waitFor(() => expect(client.opt_out_capturing).toHaveBeenCalledOnce());
    expect(client.capture).not.toHaveBeenCalled();
    expect(analytics.getAnalyticsConsent()).toBe('declined');
    expect(localStorage.getItem('homeasy_analytics_consent_v1')).toBe('declined');
    analytics.setAnalyticsConsent('accepted');
    await vi.waitFor(() => expect(client.opt_in_capturing).toHaveBeenCalled());
    await vi.waitFor(() => expect(client.capture.mock.calls.some(([name]) => name === '$pageview')).toBe(true));
    expect(client.init).toHaveBeenCalledOnce();
  });

  it('fails closed without interrupting UI actions if PostHog is blocked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.init.mockImplementationOnce(() => { throw new Error('blocked'); });
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    analytics.captureEvent('contact_lead_clicked', { channel: 'phone' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('marks Telegram builds without transmitting Telegram identity', async () => {
    vi.stubEnv('MODE', 'telegram');
    window.Telegram = { WebApp: { initData: 'telegram-session', ready: () => {}, expand: () => {} } };
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    expect(client.capture).toHaveBeenCalledWith('app_opened', expect.objectContaining({ surface: 'telegram' }));
    expect(client.identify).not.toHaveBeenCalled();
  });

  it('reports browser fallback as web when the Telegram build has no initData', async () => {
    vi.stubEnv('MODE', 'telegram');
    const analytics = await import('./analytics');
    analytics.setAnalyticsConsent('accepted');
    await initialized();
    expect(client.capture).toHaveBeenCalledWith('app_opened', expect.objectContaining({
      surface: 'web', entry_point: 'direct',
    }));
  });

  it('shows a clear opt-in choice only when analytics is configured and undecided', async () => {
    const { AnalyticsPrivacy } = await import('../components/AnalyticsPrivacy');
    expect(renderToStaticMarkup(createElement(AnalyticsPrivacy))).toContain('Allow analytics');
    expect(renderToStaticMarkup(createElement(AnalyticsPrivacy))).toContain('No thanks');
    expect(renderToStaticMarkup(createElement(AnalyticsPrivacy))).toContain('random browser ID');
    localStorage.setItem('homeasy_analytics_consent_v1', 'declined');
    expect(renderToStaticMarkup(createElement(AnalyticsPrivacy))).toBe('');
    localStorage.removeItem('homeasy_analytics_consent_v1');
    vi.stubEnv('VITE_POSTHOG_API_KEY', '');
    expect(renderToStaticMarkup(createElement(AnalyticsPrivacy))).toBe('');
  });
});
