import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), identify: vi.fn() },
}));

import {
  openExternalUrl,
  getTelegramInitData,
  getTelegramStartParam,
} from './telegram';
import { copyPhoneNumber, onPhoneActionClick, openTelegramContact, phoneActionHref } from './contact-actions';

interface FakeTelegramWebApp {
  initData: string;
  initDataUnsafe: {
    start_param?: string;
    user?: { id: number; username?: string };
  };
  ready: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  enableClosingConfirmation: ReturnType<typeof vi.fn>;
  openLink: ReturnType<typeof vi.fn>;
  openTelegramLink: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  HapticFeedback?: {
    impactOccurred: ReturnType<typeof vi.fn>;
    notificationOccurred: ReturnType<typeof vi.fn>;
    selectionChanged: ReturnType<typeof vi.fn>;
  };
  themeParams?: Record<string, string>;
}

function setTelegramWebApp(app?: Partial<FakeTelegramWebApp>) {
  (window as unknown as { Telegram?: { WebApp?: FakeTelegramWebApp } }).Telegram = app
    ? {
        WebApp: {
          initData: '',
          initDataUnsafe: {},
          ready: vi.fn(),
          expand: vi.fn(),
          enableClosingConfirmation: vi.fn(),
          openLink: vi.fn(),
          openTelegramLink: vi.fn(),
          close: vi.fn(),
          HapticFeedback: {
            impactOccurred: vi.fn(),
            notificationOccurred: vi.fn(),
            selectionChanged: vi.fn(),
          },
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
    const tg = {
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    };
    setTelegramWebApp(tg);

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
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

  it('dispatches one Telegram contact action and stops card/modal click propagation', () => {
    const tg = {
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
      close: vi.fn(),
    };
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    setTelegramWebApp(tg);

    openTelegramContact('https://t.me/agent_sr', { preventDefault, stopPropagation } as never);

    expect(tg.openTelegramLink).toHaveBeenCalledTimes(1);
    expect(tg.openTelegramLink).toHaveBeenCalledWith('https://t.me/agent_sr');
    expect(tg.openLink).not.toHaveBeenCalled();
    expect(tg.close).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it('falls back to HTTPS when openTelegramLink throws', () => {
    const tg = {
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(() => { throw new Error('bridge failed'); }),
      close: vi.fn(),
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ opener: null } as Window);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTelegramWebApp(tg);

    openTelegramContact('https://t.me/agent_sr');

    expect(tg.openTelegramLink).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledWith('https://t.me/agent_sr', '_blank', 'noopener,noreferrer');
    expect(tg.close).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    openSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('routes other https links through openLink', () => {
    const tg = {
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    };
    setTelegramWebApp(tg);

    openExternalUrl('https://www.khmer24.com/post-adid-123');

    expect(tg.openLink).toHaveBeenCalledWith('https://www.khmer24.com/post-adid-123');
  });

  it('prepends https:// to bare domains', () => {
    const tg = {
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    };
    setTelegramWebApp(tg);

    openExternalUrl('google.com/maps?q=1,2');

    expect(tg.openLink).toHaveBeenCalledWith('https://google.com/maps?q=1,2');
  });

  it('falls back to window.open when no Telegram bridge exists', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({ opener: null }) as Window);

    openExternalUrl('https://example.com');

    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });
});

describe('phone contact actions', () => {
  it('keeps the telephone URI as a real native anchor href', () => {
    expect(phoneActionHref('tel:+85512345678')).toBe('tel:+85512345678');
    expect(phoneActionHref('tel:85512345678')).toBeNull();
    expect(phoneActionHref('tel:012345678')).toBeNull();
    expect(phoneActionHref('https://example.com')).toBeNull();
  });

  it('does not route phone actions through Telegram APIs', () => {
    const tg = {
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
      close: vi.fn(),
    };
    setTelegramWebApp(tg);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    onPhoneActionClick({ preventDefault, stopPropagation } as never);
    expect(phoneActionHref('tel:+85512345678')).toBe('tel:+85512345678');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(tg.openLink).not.toHaveBeenCalled();
    expect(tg.openTelegramLink).not.toHaveBeenCalled();
    expect(tg.close).not.toHaveBeenCalled();
  });

  it('copies the displayed phone number for clients without a dialer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await expect(copyPhoneNumber('+855 12 345 678')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('+855 12 345 678');
  });
});

describe('getTelegramInitData', () => {
  afterEach(() => {
    setTelegramWebApp();
  });

  it('falls back to the native window.Telegram.WebApp bridge', () => {
    setTelegramWebApp({
      initData: 'user=%7B%22id%22%3A123%7D&hash=abc',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    });

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
    setTelegramWebApp({
      initData: 'x',
      initDataUnsafe: { start_param: 'Ab7K2' },
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    });

    expect(getTelegramStartParam()).toBe('Ab7K2');
  });

  it('returns undefined when no start_param exists', () => {
    setTelegramWebApp({
      initData: 'x',
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    });

    expect(getTelegramStartParam()).toBeUndefined();
  });

  it('returns undefined outside Telegram', () => {
    expect(getTelegramStartParam()).toBeUndefined();
  });
});
