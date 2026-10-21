import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: client }));

describe('deferred analytics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITE_POSTHOG_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not initialize or emit events without a configured key', async () => {
    const analytics = await import('./analytics');
    analytics.initializeAnalytics();
    analytics.identifyTelegramUser({ id: 42 });
    analytics.captureEvent('contact_lead_clicked', { channel: 'phone' });
    await Promise.resolve();

    expect(client.init).not.toHaveBeenCalled();
    expect(client.identify).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('loads once, initializes before the queued identity and contact events', async () => {
    vi.stubEnv('VITE_POSTHOG_API_KEY', 'test-key');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://analytics.example.test');
    const order: string[] = [];
    client.init.mockImplementation(() => { order.push('init'); });
    client.identify.mockImplementation(() => { order.push('identify'); });
    client.capture.mockImplementation(() => { order.push('capture'); });

    const analytics = await import('./analytics');
    analytics.initializeAnalytics();
    analytics.identifyTelegramUser({ id: 42, username: 'test' });
    analytics.captureEvent('contact_lead_clicked', { channel: 'telegram' });

    await vi.waitFor(() => expect(client.capture).toHaveBeenCalledTimes(1));
    expect(client.init).toHaveBeenCalledOnce();
    expect(client.init).toHaveBeenCalledWith('test-key', {
      api_host: 'https://analytics.example.test',
      autocapture: false,
      capture_pageview: true,
    });
    expect(client.identify).toHaveBeenCalledWith('42', {
      username: 'test', first_name: undefined, last_name: undefined, language_code: undefined,
    });
    expect(client.capture).toHaveBeenCalledWith('contact_lead_clicked', { channel: 'telegram' });
    expect(order).toEqual(['init', 'identify', 'capture']);
  });

  it('treats initialization failure as nonfatal to contact actions', async () => {
    vi.stubEnv('VITE_POSTHOG_API_KEY', 'bad-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.init.mockImplementationOnce(() => { throw new Error('blocked'); });
    const analytics = await import('./analytics');
    analytics.initializeAnalytics();
    analytics.captureEvent('contact_lead_clicked', { channel: 'phone' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(client.capture).not.toHaveBeenCalled();
  });
});
