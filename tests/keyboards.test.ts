import { mainMenuKeyboard } from '../src/modules/bot/keyboards/main.keyboard';
import {
  typeKeyboard,
  categoryKeyboard,
  cityKeyboard,
  locationsKeyboard,
  budgetKeyboard,
  bedroomsKeyboard,
  poolKeyboard,
  leaseKeyboard,
} from '../src/modules/bot/keyboards/filter.keyboard';
import {
  listingActionKeyboard,
  favoritesListKeyboard,
  favoriteDetailKeyboard,
} from '../src/modules/bot/keyboards/listing.keyboard';
import type { Property } from '../src/database/repositories/properties.repo';

type FlatBtn = { text: string; callback_data?: string; url?: string };

describe('Telegram Bot Keyboard Generators', () => {
  describe('Main Menu Keyboard', () => {
    test('renders minimal main menu with active alerts', () => {
      const kb = mainMenuKeyboard(false);
      const json = kb.inline_keyboard as FlatBtn[][];

      expect(json).toBeDefined();
      expect(json.length).toBe(3); // 3 rows

      // Row 1: Search & Alerts
      expect(json[0][0].text).toBe('🔍 Search & Alerts');
      expect(json[0][0].callback_data).toBe('cb:menu:search');

      // Row 2: Filters & Favorites
      expect(json[1][0].text).toBe('🛠 Manage Alerts');
      expect(json[1][0].callback_data).toBe('cb:menu:filters');
      expect(json[1][1].text).toBe('⭐ Favorites');
      expect(json[1][1].callback_data).toBe('cb:menu:favorites');

      // Row 3: Pause alerts toggle
      expect(json[2][0].text).toBe('⏸ Pause Alerts');
      expect(json[2][0].callback_data).toBe('cb:alerts:pause');
    });

    test('renders resume alerts button when alerts are paused', () => {
      const kb = mainMenuKeyboard(true);
      const json = kb.inline_keyboard as FlatBtn[][];

      expect(json[2][0].text).toBe('▶️ Resume Alerts');
      expect(json[2][0].callback_data).toBe('cb:alerts:resume');
    });
  });

  describe('Filter Wizard Keyboards', () => {
    test('typeKeyboard renders Rent and Sale options', () => {
      const kb = typeKeyboard();
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      expect(flat.some((b) => b.text.includes('Rent') && b.callback_data === 'cb:filter:type:rent')).toBe(true);
      expect(flat.some((b) => b.text.includes('Sale') && b.callback_data === 'cb:filter:type:sale')).toBe(true);
      expect(flat.some((b) => b.text.includes('Cancel') && b.callback_data === 'cb:filter:cancel')).toBe(true);
    });

    test('categoryKeyboard renders category options and cancel', () => {
      const kb = categoryKeyboard();
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      expect(flat.length).toBe(5); // 4 category options ('Any', 'Apartment', 'House', 'Room') + cancel
      expect(flat.some((b) => b.text.includes('Apartment'))).toBe(true);
      expect(flat.some((b) => b.text.includes('House'))).toBe(true);
      expect(flat.some((b) => b.text.includes('Room'))).toBe(true);
    });

    test('cityKeyboard renders Phnom Penh and Siem Reap', () => {
      const kb = cityKeyboard();
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      expect(flat.some((b) => b.text.includes('Phnom Penh') && b.callback_data === 'cb:filter:city:phnom_penh')).toBe(true);
      expect(flat.some((b) => b.text.includes('Siem Reap') && b.callback_data === 'cb:filter:city:siem_reap')).toBe(true);
    });

    test('locationsKeyboard renders districts and selected states', () => {
      const kb = locationsKeyboard('siem_reap', ['Svay Dangkum']);
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      const svayBtn = flat.find((b) => b.text.includes('Svay Dangkum'));
      expect(svayBtn).toBeDefined();
      expect(svayBtn?.text).toContain('✅');

      const salaBtn = flat.find((b) => b.text.includes('Sala Kamreuk'));
      expect(salaBtn).toBeDefined();
      expect(salaBtn?.text).not.toContain('✅');

      expect(flat.some((b) => b.text.includes('Done'))).toBe(true);
      expect(flat.some((b) => b.text.includes('Any Area'))).toBe(true);
    });

    test('budgetKeyboard renders ranges, custom, any, and cancel', () => {
      const kb = budgetKeyboard();
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      expect(flat.some((b) => b.text.includes('Custom Budget'))).toBe(true);
      expect(flat.some((b) => b.text.includes('Any Budget'))).toBe(true);
      expect(flat.some((b) => b.text.includes('Cancel'))).toBe(true);
    });

    test('bedroomsKeyboard renders bedroom options', () => {
      const kb = bedroomsKeyboard();
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      expect(flat.some((b) => b.text.includes('Studio'))).toBe(true);
      expect(flat.some((b) => b.text.includes('1 BR'))).toBe(true);
      expect(flat.some((b) => b.text.includes('Any'))).toBe(true);
    });

    test('poolKeyboard and leaseKeyboard render properly', () => {
      const poolFlat = poolKeyboard().inline_keyboard.flat() as FlatBtn[];
      expect(poolFlat.some((b) => b.text.includes('Pool Required'))).toBe(true);

      const leaseFlat = leaseKeyboard().inline_keyboard.flat() as FlatBtn[];
      expect(leaseFlat.some((b) => b.text.includes('Short-term'))).toBe(true);
      expect(leaseFlat.some((b) => b.text.includes('Long-term'))).toBe(true);
    });
  });

  describe('Listing Action & Moderation Keyboard', () => {
    const mockProperty: Property = {
      id: 99,
      hash: 'test-hash',
      title: 'Nice 2BR Villa',
      description: 'Villa with pool',
      price: 50000,
      currency: 'USD',
      type: 'rent',
      category: 'house',
      bedrooms: 2,
      bathrooms: 2,
      deposit: 50000,
      min_lease: 6,
      has_pool: true,
      location: 'Sala Kamreuk',
      city: 'siem_reap',
      maps_url: 'https://maps.app.goo.gl/sample',
      photos: [],
      image_phash: null,
      image_phashes: [],
      direct_contact: {
        phone: '089899084',
        telegram: '@agent_sophea',
      },
      source_url: 'https://facebook.com/groups/post/99',
      original_url: 'https://facebook.com/groups/post/99',
      reports_count: 0,
      is_active: 1,
      created_at: new Date().toISOString(),
      parsed_at: new Date().toISOString(),
    };

    test('renders Telegram contact, Save, Hide, Original link, and Report button', () => {
      const kb = listingActionKeyboard(mockProperty);
      const flat = kb.inline_keyboard.flat() as FlatBtn[];

      // Telegram username button
      const tgBtn = flat.find((b) => b.text.includes('Contact on Telegram'));
      expect(tgBtn).toBeDefined();
      expect(tgBtn?.url).toBe('https://t.me/agent_sophea');

      // Save & Hide
      expect(flat.some((b) => b.text.includes('Save') && b.callback_data === 'cb:prop:save:99')).toBe(true);
      expect(flat.some((b) => b.text.includes('Hide') && b.callback_data === 'cb:prop:hide:99')).toBe(true);

      // Original link
      expect(flat.some((b) => b.text.includes('Original') && b.url === 'https://facebook.com/groups/post/99')).toBe(true);

      // Report button (Crowdsourced moderation)
      const reportBtn = flat.find((b) => b.text.includes('Report'));
      expect(reportBtn).toBeDefined();
      expect(reportBtn?.callback_data).toBe('cb:prop:report:99');
    });

    test('favoritesListKeyboard and favoriteDetailKeyboard render properly', () => {
      const favList = favoritesListKeyboard([mockProperty], 0);
      const favFlat = favList.inline_keyboard.flat() as FlatBtn[];
      expect(favFlat.some((b) => b.text.includes('Nice 2BR Villa') && b.callback_data === 'cb:fav:view:99')).toBe(true);

      const detail = favoriteDetailKeyboard(99);
      const detailFlat = detail.inline_keyboard.flat() as FlatBtn[];
      expect(detailFlat.some((b) => b.text.includes('Remove') && b.callback_data === 'cb:fav:remove:99')).toBe(true);
    });
  });
});
