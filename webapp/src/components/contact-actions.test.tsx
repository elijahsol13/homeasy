import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyDTO } from '../types';

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), identify: vi.fn() },
}));
vi.mock('../services/analytics', () => ({
  captureEvent: vi.fn(),
  identifyTelegramUser: vi.fn(),
}));

import { captureEvent } from '../services/analytics';
import { PropertyCard } from './PropertyCard';
import { PropertyDetailModal } from './PropertyDetailModal';

const property: PropertyDTO = {
  id: 1,
  publicRef: 'lst_contact_action_fixture',
  title: 'Apartment in Wat Bo',
  description: 'For rent',
  priceUsd: 300,
  currency: 'USD',
  type: 'rent',
  category: 'apartment',
  propertyType: 'Apartment',
  bedrooms: 1,
  bathrooms: 1,
  depositUsd: null,
  minLeaseMonths: null,
  hasPool: false,
  location: 'Wat Bo',
  locationKey: 'wat_bo',
  city: 'siem_reap',
  coordinatePrecision: 'district',
  mapsUrl: null,
  coordinates: null,
  photos: [],
  thumbnail: null,
  sourceUrl: null,
  originalUrl: 'https://www.khmer24.com/post-adid-1',
  postedAt: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  specs: {
    electricity: null,
    water: null,
    cleaning: null,
    restrictions: [],
    amenities: [],
    landmarks: [],
    marketingLandmarks: [],
  },
  contact: {
    phone: '012 345 678',
    phoneLink: 'tel:+85512345678',
    whatsappLink: 'https://wa.me/85512345678',
    telegram: '@agent_sr',
    telegramLink: 'https://t.me/agent_sr',
  },
};

describe('contact controls in listing UI', () => {
  let root: Root;
  let host: HTMLDivElement;
  let openTelegramLink: ReturnType<typeof vi.fn>;
  let closeMiniApp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(captureEvent).mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    openTelegramLink = vi.fn();
    closeMiniApp = vi.fn();
    (window as unknown as { Telegram: { WebApp: unknown } }).Telegram = {
      WebApp: { openTelegramLink, close: closeMiniApp },
    };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (window as unknown as { Telegram?: unknown }).Telegram;
  });

  it.each([
    ['telegram', 'button', 'Message Agent'],
    ['whatsapp', 'a[aria-label="Try WhatsApp Agent"]', ''],
    ['phone', 'a[aria-label="Call Agent"]', ''],
  ])('tracks %s contact from the feed with only public event fields', async (channel, selector, buttonText) => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(<PropertyCard property={property} onSelect={onSelect} onToggleFavorite={vi.fn()} />);
    });

    const action = buttonText
      ? [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(buttonText))
      : host.querySelector(selector);
    expect(action).toBeTruthy();
    await act(async () => {
      action!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(captureEvent).toHaveBeenCalledExactlyOnceWith('contact_lead_clicked', {
      propertyId: property.id,
      listing_ref: property.publicRef,
      source: 'feed',
      channel,
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['telegram', 'button', 'Chat in Telegram'],
    ['whatsapp', 'a[aria-label="Try WhatsApp"]', ''],
    ['phone', 'a[aria-label="Call"]', ''],
  ])('tracks %s contact from detail with only public event fields', async (channel, selector, buttonText) => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<PropertyDetailModal property={property} onClose={onClose} onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />);
    });

    const action = buttonText
      ? [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(buttonText))
      : host.querySelector(selector);
    expect(action).toBeTruthy();
    await act(async () => {
      action!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(captureEvent).toHaveBeenCalledExactlyOnceWith('contact_lead_clicked', {
      propertyId: property.id,
      listing_ref: property.publicRef,
      source: 'detail',
      channel,
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tracks a feed original-source click without logging its URL or opening the card', async () => {
    const onSelect = vi.fn();
    const sourceProperty = { ...property, contact: { ...property.contact, telegramLink: undefined } };
    await act(async () => {
      root.render(<PropertyCard property={sourceProperty} onSelect={onSelect} onToggleFavorite={vi.fn()} />);
    });

    const link = host.querySelector<HTMLAnchorElement>('a.property-card__original')!;
    expect(link.href).toBe(property.originalUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    link.addEventListener('click', (event) => event.preventDefault()); // Suppress jsdom navigation.
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(captureEvent).toHaveBeenCalledExactlyOnceWith('outbound_source_clicked', {
      propertyId: property.id,
      listing_ref: property.publicRef,
      source: 'feed',
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([0, 1])('tracks detail original-source link %i once and preserves external navigation', async (index) => {
    const openLink = vi.fn();
    (window as unknown as { Telegram: { WebApp: unknown } }).Telegram = {
      WebApp: { openLink, openTelegramLink, close: closeMiniApp },
    };
    const sourceProperty = { ...property, contact: { ...property.contact, telegramLink: undefined } };
    const onClose = vi.fn();
    await act(async () => {
      root.render(<PropertyDetailModal property={sourceProperty} onClose={onClose}
        onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />);
    });

    const links = [...host.querySelectorAll<HTMLAnchorElement>('a[href="https://www.khmer24.com/post-adid-1"]')];
    expect(links).toHaveLength(2);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      links[index].dispatchEvent(click);
    });

    expect(openLink).toHaveBeenCalledExactlyOnceWith(property.originalUrl);
    expect(click.defaultPrevented).toBe(true);
    expect(captureEvent).toHaveBeenCalledExactlyOnceWith('outbound_source_clicked', {
      propertyId: property.id,
      listing_ref: property.publicRef,
      source: 'detail',
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens Telegram from a card without firing the card selection handler', async () => {
    const onSelect = vi.fn();
    const onTelegramContactDispatched = vi.fn();
    await act(async () => {
      root.render(<PropertyCard property={property} onSelect={onSelect} onToggleFavorite={vi.fn()} onTelegramContactDispatched={onTelegramContactDispatched} />);
    });

    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Message Agent'))!;
    await act(async () => {
      chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(openTelegramLink).toHaveBeenCalledTimes(1);
    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/agent_sr');
    expect(closeMiniApp).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onTelegramContactDispatched).toHaveBeenCalledWith(property);
    expect(onTelegramContactDispatched.mock.invocationCallOrder[0]).toBeLessThan(openTelegramLink.mock.invocationCallOrder[0]);
  });

  it('opens WhatsApp from a card through the Telegram WebApp bridge only once', async () => {
    const onSelect = vi.fn();
    const openLink = vi.fn();
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    (window as unknown as { Telegram: { WebApp: unknown } }).Telegram = {
      WebApp: { openLink, openTelegramLink, close: closeMiniApp },
    };

    try {
      await act(async () => {
        root.render(<PropertyCard property={property} onSelect={onSelect} onToggleFavorite={vi.fn()} />);
      });

      const whatsapp = host.querySelector<HTMLAnchorElement>('a[aria-label="Try WhatsApp Agent"]')!;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => {
        whatsapp.dispatchEvent(event);
      });

      expect(openLink).toHaveBeenCalledExactlyOnceWith('https://wa.me/85512345678');
      expect(event.defaultPrevented).toBe(true);
      expect(openWindow).not.toHaveBeenCalled();
      expect(openTelegramLink).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      openWindow.mockRestore();
    }
  });

  it('opens WhatsApp from a card in a browser without a Telegram bridge', async () => {
    const onSelect = vi.fn();
    delete (window as unknown as { Telegram?: unknown }).Telegram;
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);

    try {
      await act(async () => {
        root.render(<PropertyCard property={property} onSelect={onSelect} onToggleFavorite={vi.fn()} />);
      });

      const whatsapp = host.querySelector<HTMLAnchorElement>('a[aria-label="Try WhatsApp Agent"]')!;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => {
        whatsapp.dispatchEvent(event);
      });

      expect(openWindow).toHaveBeenCalledExactlyOnceWith('https://wa.me/85512345678', '_blank', 'noopener,noreferrer');
      expect(event.defaultPrevented).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      openWindow.mockRestore();
    }
  });

  it('keeps native call and a WhatsApp attempt available without displaying or copying the phone', async () => {
    const onSelect = vi.fn();
    const onTelegramContactDispatched = vi.fn();
    await act(async () => {
      root.render(<PropertyCard property={{ ...property, contact: { ...property.contact, whatsappLink: undefined } }} onSelect={onSelect} onToggleFavorite={vi.fn()} onTelegramContactDispatched={onTelegramContactDispatched} />);
    });

    const callLink = host.querySelector<HTMLAnchorElement>('a[aria-label="Call Agent"]')!;
    expect(callLink.getAttribute('href')).toBe('tel:+85512345678');
    const whatsapp = host.querySelector<HTMLAnchorElement>('a[aria-label="Try WhatsApp Agent"]')!;
    expect(whatsapp.getAttribute('href')).toBe('https://wa.me/85512345678');
    expect(host.querySelector('button[aria-label="Copy phone number"]')).toBeNull();
    expect(openTelegramLink).not.toHaveBeenCalled();

    await act(async () => {
      whatsapp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();

    const nativeCallEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      callLink.dispatchEvent(nativeCallEvent);
    });
    expect(nativeCallEvent.defaultPrevented).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <PropertyDetailModal property={{ ...property, contact: { ...property.contact, whatsappLink: undefined } }} onClose={vi.fn()}
          onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />,
      );
    });
    expect(host.querySelector('button[aria-label="Copy phone number"]')).toBeNull();
    expect(host.textContent).not.toContain('012 345 678');
    expect(host.querySelector('a[aria-label="Try WhatsApp"]')?.getAttribute('href')).toBe('https://wa.me/85512345678');
  });

  it('does not invent WhatsApp or phone actions when the listing has no validated phone', async () => {
    await act(async () => {
      root.render(<PropertyCard property={{ ...property, contact: { telegramLink: property.contact.telegramLink } }}
        onSelect={vi.fn()} onToggleFavorite={vi.fn()} />);
    });
    expect(host.querySelector('a[href^="tel:"]')).toBeNull();
    expect(host.querySelector('a[href^="https://wa.me/"]')).toBeNull();
  });

  it('keeps the detail modal open when Telegram chat is clicked', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <PropertyDetailModal
          property={property}
          onClose={onClose}
          onToggleFavorite={vi.fn()}
          onShowOnMap={vi.fn()}
        />,
      );
    });

    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Chat in Telegram'))!;
    await act(async () => {
      chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(openTelegramLink).toHaveBeenCalledTimes(1);
    expect(closeMiniApp).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('a[aria-label="Call"]')?.getAttribute('href')).toBe('tel:+85512345678');
  });

  it('clearly separates verified rental terms from amenities and avoids assuming a cash deposit', async () => {
    await act(async () => {
      root.render(<PropertyDetailModal property={{ ...property, priceUsd: 0, minLeaseMonths: 6, depositUsd: null, depositMonths: 1 }}
        onClose={vi.fn()} onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />);
    });
    expect(host.textContent).toContain('Rental Terms');
    expect(host.textContent).toContain('6 months');
    expect(host.textContent).toContain('1 month');
    expect(host.textContent).toContain('Price not specified');
    expect(host.textContent).not.toContain('contact the agent');
    expect(host.textContent).not.toContain('Deposit $');
  });
});
