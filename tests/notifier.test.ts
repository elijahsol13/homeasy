import {
  formatListingCard,
  formatListingTimestamp,
  sendListingCard,
  NotifierService,
} from '../src/services/notifier';
import type { Property } from '../src/database/repositories/properties.repo';

describe('Dynamic Telegram Listing Card Formatter', () => {
  const baseProperty: Property = {
    id: 1,
    hash: 'test-hash-1',
    title: 'Modern House in Siem Reap',
    description: 'Clean modern house for rent close to Old Market.',
    price: 35000, // $350
    currency: 'USD',
    type: 'rent',
    category: 'house',
    bedrooms: null,
    bathrooms: null,
    deposit: null,
    min_lease: null,
    has_pool: false,
    location: 'Svay Dangkum',
    city: 'siem_reap',
    maps_url: null,
    photos: ['https://example.com/photo.jpg'],
    image_phash: null,
    image_phashes: [],
    direct_contact: {
      phone: '089899084',
    },
    source_url: 'https://facebook.com/groups/siemreaprealestate/posts/12345',
    original_url: 'https://facebook.com/groups/siemreaprealestate/posts/12345',
    reports_count: 0,
    is_active: 1,
    created_at: new Date().toISOString(),
    parsed_at: new Date().toISOString(),
  };

  test('omits features row and terms row when bedrooms, bathrooms, pool, deposit, min_lease are null/false', () => {
    const card = formatListingCard(baseProperty);

    // Should NOT contain the bed/bath row icon or placeholders
    expect(card).not.toContain('🛏');
    expect(card).not.toContain('—');
    expect(card).not.toContain('📋');
    expect(card).not.toContain('Deposit:');
    expect(card).not.toContain('Min Lease:');

    // Should contain essentials
    expect(card).toContain('🏠 <b>Modern House in Siem Reap</b>');
    expect(card).toContain('💰 <b>$350/mo</b>');
    expect(card).toContain('📍 <b>Svay Dangkum</b>, Siem Reap');
    expect(card).toContain('📞 Phone: <code>+855 89 899 084</code>');
    expect(card).toContain('🔗 Source:');
  });

  test('dynamically includes only present features and terms', () => {
    const fullProperty: Property = {
      ...baseProperty,
      bedrooms: 2,
      bathrooms: 2,
      has_pool: true,
      deposit: 35000,
      min_lease: 6,
    };

    const card = formatListingCard(fullProperty);

    expect(card).toContain('Deposit: $350 · Min Lease: 6 mos');
    expect(card).toContain('🛏 2 BR · 2 Bath · 🏊 Pool');
  });

  test('renders studio correctly when bedrooms is 0', () => {
    const studioProperty: Property = {
      ...baseProperty,
      category: 'apartment',
      bedrooms: 0,
      bathrooms: 1,
      has_pool: false,
    };

    const card = formatListingCard(studioProperty);

    expect(card).toContain('🛏 Studio · 1 Bath');
    expect(card).not.toContain('🏊 Pool');
  });

  test('renders custom maps_url when provided, and generated query when not', () => {
    const cardWithCustomMaps = formatListingCard({
      ...baseProperty,
      maps_url: 'https://maps.app.goo.gl/sample123',
    });
    expect(cardWithCustomMaps).toContain('href="https://maps.app.goo.gl/sample123"');

    const cardWithSpecificMaps = formatListingCard({
      ...baseProperty,
      maps_url: null,
      location: 'Sala Kamreuk',
      city: 'siem_reap',
    });
    expect(cardWithSpecificMaps).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=Sala%20Kamreuk%2C%20Siem%20Reap%2C%20Cambodia"');
    expect(cardWithSpecificMaps).toContain('📍 <b>Sala Kamreuk</b>, Siem Reap ↗');

    const cardWithCityOnlyMaps = formatListingCard({
      ...baseProperty,
      maps_url: null,
      location: '',
      city: 'siem_reap',
    });
    expect(cardWithCityOnlyMaps).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=Siem%20Reap%2C%20Cambodia"');
    expect(cardWithCityOnlyMaps).toContain('📍 <b>Siem Reap</b> ↗');
  });

  test('formats listing timestamps nicely and positions above contact section', () => {
    const card = formatListingCard(baseProperty);
    expect(card).toContain('🕒 Added: Today at');

    const timestampIndex = card.indexOf('🕒 Added:');
    const contactIndex = card.indexOf('👤 <b>Contact:</b>');
    expect(timestampIndex).toBeGreaterThan(0);
    expect(contactIndex).toBeGreaterThan(timestampIndex);

    // Test formatListingTimestamp unit scenarios
    const now = new Date();
    expect(formatListingTimestamp(now.toISOString())).toContain('Today at');

    const pastDate = new Date('2025-01-15T08:30:00Z');
    expect(formatListingTimestamp(pastDate.toISOString())).toContain('2025-01-15 at');
  });

  test('instantiates NotifierService and respects injected Api', () => {
    const mockApi = {
      sendMessage: jest.fn().mockResolvedValue({}),
      sendPhoto: jest.fn().mockResolvedValue({}),
    } as unknown as import('grammy').Api;

    const notifier = new NotifierService(mockApi, [111222]);
    expect(notifier.getApi()).toBe(mockApi);
  });

  test('formats extra amenities and specs when present in description', () => {
    const richProperty: Property = {
      ...baseProperty,
      description:
        'Stunning luxury villa. Size: 120m² · Floor: 2nd · Furnished: Fully. Includes gym, pool, elevator, balcony, and free wifi.',
      bedrooms: 3,
      bathrooms: 3,
      has_pool: true,
    };

    const card = formatListingCard(richProperty);
    expect(card).toContain('📐 120m²');
    expect(card).toContain('🏢 2nd');
    expect(card).toContain('🛋️ Furnished');
    expect(card).toContain('🏋️ Gym');
    expect(card).toContain('🛗 Elevator');
    expect(card).toContain('🌅 Balcony');
    expect(card).toContain('📶 Free Wi-Fi');
  });

  test('sendListingCard sends media group capped at 3 photos', async () => {
    const mockApi = {
      sendMediaGroup: jest.fn().mockResolvedValue([]),
      sendMessage: jest.fn().mockResolvedValue({}),
      sendPhoto: jest.fn().mockResolvedValue({}),
    } as unknown as import('grammy').Api;

    const multiPhotoProperty: Property = {
      ...baseProperty,
      photos: [
        'https://example.com/p1.jpg',
        'https://example.com/p2.jpg',
        'https://example.com/p3.jpg',
        'https://example.com/p4.jpg',
      ],
    };

    await sendListingCard(12345, multiPhotoProperty, mockApi);
    expect(mockApi.sendMediaGroup).toHaveBeenCalledTimes(1);
    const callArgs = (mockApi.sendMediaGroup as jest.Mock).mock.calls[0];
    expect(callArgs[0]).toBe(12345);
    expect(callArgs[1]).toHaveLength(3);
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
