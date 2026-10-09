import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyDTO } from '../types';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn(), identify: vi.fn() } }));

import { PropertyCard } from './PropertyCard';
import { PropertyDetailModal } from './PropertyDetailModal';
import {
  formatCambodianTelegramPhone,
  normalizePhoneToE164,
  phoneActionHref,
  phoneActionHrefFromDto,
  telegramActionHrefFromDto,
} from '../services/contact-actions';

const property: PropertyDTO = {
  id: 1,
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

  it('opens Telegram from a card without selecting the card', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<PropertyCard property={property} onSelect={onSelect} onToggleFavorite={vi.fn()} />));
    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Message Agent'))!;
    await act(async () => chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(openTelegramLink).toHaveBeenCalledTimes(1);
    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/agent_sr');
    expect(closeMiniApp).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides Call and keeps a selectable number without a copy control in the card', async () => {
    await act(async () => root.render(<PropertyCard property={property} onSelect={vi.fn()} onToggleFavorite={vi.fn()} />));
    expect(host.querySelector('a[aria-label="Call Agent"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Copy phone number"]')).toBeNull();
    expect(host.querySelector('[aria-label="Phone number"]')?.textContent).toBe('012 345 678');
    expect(openTelegramLink).not.toHaveBeenCalled();
  });

  it('keeps the detail modal open after Telegram chat and renders native call', async () => {
    const onClose = vi.fn();
    await act(async () => root.render(
      <PropertyDetailModal property={property} onClose={onClose} onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />,
    ));
    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Chat in Telegram'))!;
    await act(async () => chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(openTelegramLink).toHaveBeenCalledTimes(1);
    expect(closeMiniApp).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('a[aria-label="Call"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Copy phone number"]')).toBeNull();
    expect(host.textContent).toContain('012 345 678');
  });

  it('adapts legacy phone DTO values for card chat and call actions', async () => {
    const legacyProperty = {
      ...property,
      contact: { phone: '012 345 678', phoneLink: 'tel:012345678' },
    } as PropertyDTO;
    await act(async () => root.render(
      <PropertyCard property={legacyProperty} onSelect={vi.fn()} onToggleFavorite={vi.fn()} />,
    ));

    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Message Agent'))!;
    await act(async () => chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/+855012345678');
    expect(host.querySelector('a[aria-label="Call Agent"]')).toBeNull();
  });

  it('adapts legacy phone DTO values in the detail modal', async () => {
    const legacyProperty = {
      ...property,
      contact: { phone: '012 345 678', phoneLink: 'tel:012345678' },
    } as PropertyDTO;
    await act(async () => root.render(
      <PropertyDetailModal property={legacyProperty} onClose={vi.fn()} onToggleFavorite={vi.fn()} onShowOnMap={vi.fn()} />,
    ));

    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Chat in Telegram'))!;
    await act(async () => chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/+855012345678');
    expect(host.querySelector('a[aria-label="Call"]')).toBeNull();
  });

  it('uses the separate Telegram phone from a real listing for Chat while Call stays hidden', async () => {
    const separateContacts = {
      ...property,
      contact: {
        phone: '096 815 2427',
        phoneLink: 'tel:0968152427',
        telegram: '089 586 258',
        telegramLink: 'https://t.me/+85589586258',
      },
    } as PropertyDTO;
    await act(async () => root.render(
      <PropertyCard property={separateContacts} onSelect={vi.fn()} onToggleFavorite={vi.fn()} />,
    ));

    const chatButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Message Agent'))!;
    await act(async () => chatButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/+855089586258');
    expect(host.querySelector('a[aria-label="Call Agent"]')).toBeNull();
  });
});

describe('legacy DTO phone normalization', () => {
  it.each([
    ['tel:012345678', '+85512345678'],
    ['012345678', '+85512345678'],
    ['tel:85512345678', '+85512345678'],
    ['+85512345678', '+85512345678'],
    ['tel:+85512345678', '+85512345678'],
    ['+66 81-234-5678', '+66812345678'],
    ['0969343456', '+855969343456'],
  ])('normalizes %s as %s', (raw, expected) => {
    expect(normalizePhoneToE164(raw)).toBe(expected);
  });

  it('does not guess a country code for foreign numbers without a plus', () => {
    expect(normalizePhoneToE164('66812345678')).toBeNull();
    expect(normalizePhoneToE164('not a phone')).toBeNull();
    expect(normalizePhoneToE164('tel:123')).toBeNull();
  });

  it('keeps phoneActionHref strict while adapting the legacy DTO before validation', () => {
    expect(phoneActionHref('tel:012345678')).toBeNull();
    expect(phoneActionHrefFromDto('tel:012345678', null)).toBe('tel:+85512345678');
    expect(phoneActionHrefFromDto('tel:garbage', '012345678')).toBe('tel:+85512345678');
  });

  it('keeps call E.164 separate from Cambodian Telegram resolver identity', () => {
    expect(phoneActionHrefFromDto('tel:089899265', null)).toBe('tel:+85589899265');
    expect(formatCambodianTelegramPhone('089 899 265')).toBe('+855089899265');
    expect(formatCambodianTelegramPhone('+85589899265')).toBe('+855089899265');
    expect(telegramActionHrefFromDto('https://t.me/+85589899265', '089 899 265')).toBe('https://t.me/+855089899265');
  });

  it('keeps a longer Cambodian mobile number at 12 digits for call and Telegram', () => {
    // Existing raw Khmer24 fixture: tests/fixtures/khmer24_raw_fixture_house.json
    const rawLongMobile = '0888855706';
    expect(phoneActionHrefFromDto(`tel:${rawLongMobile}`, null)).toBe('tel:+855888855706');
    expect(formatCambodianTelegramPhone(rawLongMobile)).toBe('+855888855706');
    expect(telegramActionHrefFromDto(null, rawLongMobile)).toBe('https://t.me/+855888855706');
  });

  it('preserves an explicitly supplied Telegram phone URL', () => {
    expect(
      telegramActionHrefFromDto('https://t.me/+855089899265', '089 899 265', 'https://t.me/+855089899265'),
    ).toBe('https://t.me/+855089899265');
  });

  it('formats a Telegram phone from the source field even when Call uses a different phone', () => {
    // Existing Siem Reap listing #215 has separate Call and Telegram numbers.
    expect(
      telegramActionHrefFromDto('https://t.me/+85589586258', '096 815 2427', '089 586 258'),
    ).toBe('https://t.me/+855089586258');
    expect(phoneActionHrefFromDto('tel:0968152427', '096 815 2427')).toBe('tel:+855968152427');
  });
});
