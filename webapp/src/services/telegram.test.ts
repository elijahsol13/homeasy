import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), identify: vi.fn() },
}));

import { getTelegramInitData, getTelegramStartParam, openExternalUrl } from './telegram';
import { onPhoneActionClick, openTelegramContact, phoneActionHref } from './contact-actions';

interface FakeTelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string };
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
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    setTelegramWebApp(tg);

    openExternalUrl('https://t.me/agent_name');

    expect(tg.openTelegramLink).toHaveBeenCalledWith('https://t.me/agent_name');
    expect(tg.openTelegramLink).toHaveBeenCalledTimes(1);
    expect(tg.openLink).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('falls back to HTTPS when openTelegramLink throws', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn(() => { throw new Error('bridge failed'); }), close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ opener: null } as Window);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTelegramWebApp(tg);

    openTelegramContact('https://t.me/agent_name');

    expect(tg.openTelegramLink).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('https://t.me/agent_name', '_blank', 'noopener,noreferrer');
    expect(tg.close).not.toHaveBeenCalled();
    openSpy.mockRestore();
    warnSpy.mockRestore();
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

describe('phone contact actions', () => {
  it('accepts only E.164 telephone links', () => {
    expect(phoneActionHref('tel:+85512345678')).toBe('tel:+85512345678');
    expect(phoneActionHref('tel:85512345678')).toBeNull();
    expect(phoneActionHref('tel:012345678')).toBeNull();
  });

  it('keeps native call navigation and avoids Telegram APIs', () => {
    const tg = { initData: 'x', openLink: vi.fn(), openTelegramLink: vi.fn() };
    setTelegramWebApp(tg);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    onPhoneActionClick({ preventDefault, stopPropagation } as never);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(tg.openLink).not.toHaveBeenCalled();
    expect(tg.openTelegramLink).not.toHaveBeenCalled();
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

describe('getTelegramStartParam', () => {
  afterEach(() => {
    setTelegramWebApp();
  });

  it('returns start_param from initDataUnsafe', () => {
    setTelegramWebApp({ initData: 'x', initDataUnsafe: { start_param: 'Ab7K2' } });
    expect(getTelegramStartParam()).toBe('Ab7K2');
  });

  it('returns undefined when no start_param exists', () => {
    setTelegramWebApp({ initData: 'x', initDataUnsafe: {} });
    expect(getTelegramStartParam()).toBeUndefined();
  });

  it('returns undefined outside Telegram', () => {
    expect(getTelegramStartParam()).toBeUndefined();
  });
});
