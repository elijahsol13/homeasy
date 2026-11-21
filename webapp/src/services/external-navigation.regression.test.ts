import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), identify: vi.fn() },
}));

import { openTelegramContact } from './contact-actions';
import { openExternalUrl } from './telegram';

describe('external navigation when noopener makes window.open return null', () => {
  const open = vi.fn(() => null);
  const assign = vi.fn();
  const changeHref = vi.fn();

  beforeEach(() => {
    open.mockClear();
    assign.mockClear();
    changeHref.mockClear();
    vi.stubGlobal('window', {
      Telegram: undefined,
      open,
      location: {
        assign,
        get href() { return 'https://homeasy.example/'; },
        set href(value: string) { changeHref(value); },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a Telegram contact once without redirecting the current tab', () => {
    openTelegramContact('https://t.me/agent');

    expect(open).toHaveBeenCalledExactlyOnceWith('https://t.me/agent', '_blank', 'noopener,noreferrer');
    expect(assign).not.toHaveBeenCalled();
    expect(changeHref).not.toHaveBeenCalled();
  });

  it('opens an external URL once without redirecting the current tab', () => {
    openExternalUrl('https://example.com/listing');

    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/listing', '_blank', 'noopener,noreferrer');
    expect(assign).not.toHaveBeenCalled();
    expect(changeHref).not.toHaveBeenCalled();
  });

  it('prevents an anchor from opening the same link again when window.open returns null', () => {
    const event = { preventDefault: vi.fn() };

    openExternalUrl('https://example.com/listing', event as never);

    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/listing', '_blank', 'noopener,noreferrer');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
    expect(changeHref).not.toHaveBeenCalled();
  });

  it('falls back to a same-tab Telegram navigation only if window.open throws', () => {
    open.mockImplementationOnce(() => { throw new Error('open unavailable'); });

    openTelegramContact('https://t.me/agent');

    expect(open).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://t.me/agent');
  });

  it('retains same-tab fallback for an external URL if window.open throws', () => {
    open.mockImplementationOnce(() => { throw new Error('open unavailable'); });

    openExternalUrl('https://example.com/listing');

    expect(open).toHaveBeenCalledOnce();
    expect(changeHref).toHaveBeenCalledExactlyOnceWith('https://example.com/listing');
  });
});
