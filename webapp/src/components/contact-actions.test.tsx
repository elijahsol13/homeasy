import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyDTO } from '../types';

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), identify: vi.fn() },
}));

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

  it('keeps call, WhatsApp and copy actions directly available on the card', async () => {
    const onSelect = vi.fn();
    const onTelegramContactDispatched = vi.fn();
    await act(async () => {
      root.render(<PropertyCard property={property} onSelect={onSelect} onToggleFavorite={vi.fn()} onTelegramContactDispatched={onTelegramContactDispatched} />);
    });

    const callLink = host.querySelector<HTMLAnchorElement>('a[aria-label="Call Agent"]')!;
    expect(callLink.getAttribute('href')).toBe('tel:+85512345678');
    const whatsapp = host.querySelector<HTMLAnchorElement>('a[aria-label="WhatsApp Agent"]')!;
    expect(whatsapp.getAttribute('href')).toBe('https://wa.me/85512345678');
    expect(host.querySelector('button[aria-label="Copy phone number"]')).not.toBeNull();
    expect(openTelegramLink).not.toHaveBeenCalled();

    await act(async () => {
      whatsapp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Copy phone number"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(writeText).toHaveBeenCalledWith('012 345 678');
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <PropertyDetailModal property={property} onClose={vi.fn()}
          onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />,
      );
    });
    expect(host.querySelector('button[aria-label="Copy phone number"]')).not.toBeNull();
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
