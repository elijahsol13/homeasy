import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), identify: vi.fn() },
}));

import { openExternalUrl, openPhoneUrl, getTelegramInitData } from './telegram';

interface FakeTelegramWebApp {
  initData: string;
  openLink: ReturnType<typeof vi.fn>;
  openTelegramLink: ReturnType<typeof vi.fn>;
}

function setTelegramWebApp(app?: Partial<FakeTelegramWebApp>) {
  (window as unknown as { Telegram?: { WebApp?: FakeTelegramWebApp } }).Telegram = app
    ? {
        WebApp: {
          initData: '',
          openLink: vi.fn(),
          openTelegramLink: vi.fn(),
          ...app,
        } as FakeTelegramWebApp,
      }
    : undefined;
}

describe('openExternalUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTelegramWebApp();
  });

  afterEach(() => {
    setTelegramWebApp();
  });

  it('routes t.me links through openTelegramLink', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn() };
    setTelegramWebApp(tg);

    openExternalUrl('https://t.me/agent_name');

    expect(tg.openTelegramLink).toHaveBeenCalledWith('https://t.me/agent_name');
    expect(tg.openLink).not.toHaveBeenCalled();
  });

  it('routes other https links through openLink', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn() };
    setTelegramWebApp(tg);

    openExternalUrl('https://www.khmer24.com/post-adid-123');

    expect(tg.openLink).toHaveBeenCalledWith('https://www.khmer24.com/post-adid-123');
  });

  it('prepends https:// to bare domains', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn() };
    setTelegramWebApp(tg);

    openExternalUrl('google.com/maps?q=1,2');

    expect(tg.openLink).toHaveBeenCalledWith('https://google.com/maps?q=1,2');
  });

  it('falls back to window.open when no Telegram bridge exists', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    openExternalUrl('https://example.com');

    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });
});

describe('openPhoneUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTelegramWebApp();
  });

  afterEach(() => {
    setTelegramWebApp();
  });

  it('passes tel: links to openLink unmodified (no https:// prefix)', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn() };
    setTelegramWebApp(tg);

    openPhoneUrl('tel:+85512345678');

    expect(tg.openLink).toHaveBeenCalledWith('tel:+85512345678');
  });

  it('falls back to a synthetic anchor click without a Telegram bridge', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    openPhoneUrl('tel:+855999');

    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('does nothing for empty links', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn() };
    setTelegramWebApp(tg);

    openPhoneUrl(undefined);
    openPhoneUrl(null);
    openPhoneUrl('');

    expect(tg.openLink).not.toHaveBeenCalled();
  });
});

describe('getTelegramInitData', () => {
  afterEach(() => {
    setTelegramWebApp();
  });

  it('falls back to the native window.Telegram.WebApp bridge', () => {
    setTelegramWebApp({ initData: 'user=%7B%22id%22%3A123%7D&hash=abc' });

    expect(getTelegramInitData()).toBe('user=%7B%22id%22%3A123%7D&hash=abc');
  });

  it('returns empty string outside Telegram', () => {
    expect(getTelegramInitData()).toBe('');
  });
});
