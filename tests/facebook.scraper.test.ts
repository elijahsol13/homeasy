import {
  cleanFacebookUrl,
  extractPhoneFromText,
  parseFacebookPostText,
  FB_GROUP_TARGETS,
  type FBGroupTarget,
} from '../src/modules/parser/facebook.scraper';
import { RawListingSchema } from '../src/modules/parser/schemas';

const defaultTarget: FBGroupTarget = {
  name: 'Siem Reap Real Estate & Rentals',
  url: 'https://www.facebook.com/groups/siemreaprealestate?sorting_setting=CHRONOLOGICAL',
  city: 'siem_reap',
};

describe('Facebook Scraper', () => {
  describe('cleanFacebookUrl', () => {
    test('removes tracking parameters (__cft__, __tn__, ref)', () => {
      const raw =
        'https://www.facebook.com/groups/siemreaprealestate/posts/123456789/?__cft__[0]=AZX&__tn__=%2CO%2CP-R&ref=share';
      expect(cleanFacebookUrl(raw)).toBe(
        'https://www.facebook.com/groups/siemreaprealestate/posts/123456789/',
      );
    });

    test('leaves clean URL unmodified', () => {
      const clean = 'https://www.facebook.com/groups/siemreaprealestate/posts/123456789/';
      expect(cleanFacebookUrl(clean)).toBe(clean);
    });

    test('handles empty or invalid strings gracefully', () => {
      expect(cleanFacebookUrl('')).toBe('');
    });
  });

  describe('extractPhoneFromText', () => {
    test('extracts local format phone number from post text', () => {
      const text = 'Beautiful house for rent in Siem Reap. Please call 012 345 678 for viewing.';
      expect(extractPhoneFromText(text)).toBe('012 345 678');
    });

    test('extracts +855 format phone number', () => {
      const text = 'Apartment available now. WhatsApp / Telegram: +855 96 934 3456';
      expect(extractPhoneFromText(text)).toBe('+855 96 934 3456');
    });

    test('returns undefined when no phone is present', () => {
      const text = 'Cozy studio for rent. PM for more info.';
      expect(extractPhoneFromText(text)).toBeUndefined();
    });
  });

  describe('parseFacebookPostText heuristics', () => {
    const postText = `
🏡 Modern 3-Bedroom Villa with Swimming Pool for Rent
📍 Location: Sala Kamreuk, Siem Reap
💰 Price: $650 / month
🛏 3 Bedrooms | 🚿 3 Bathrooms
🏊 Private Swimming Pool & Garden
📋 1 month deposit, minimum 6 months contract
📞 Contact: 089 899 084 / Telegram: @sr_realty
    `.trim();

    const postUrl =
      'https://www.facebook.com/groups/siemreaprealestate/posts/987654321/?__cft__[0]=AZV';
    const photos = ['https://scontent.xx.fbcdn.net/v/t39.30808-6/sample_villa.jpg'];

    test('extracts all core structured fields correctly', async () => {
      const listing = await parseFacebookPostText(postText, defaultTarget, postUrl, photos);

      expect(listing).not.toBeNull();
      expect(listing!.title).toContain('Modern 3-Bedroom Villa with Swimming Pool');
      expect(listing!.price).toBe(650);
      expect(listing!.currency).toBe('USD');
      expect(listing!.type).toBe('rent');
      expect(listing!.category).toBe('house');
      expect(listing!.bedrooms).toBe(3);
      expect(listing!.bathrooms).toBe(3);
      expect(listing!.has_pool).toBe(true);
      expect(listing!.location).toBe('Sala Kamreuk');
      expect(listing!.city).toBe('siem_reap');
      expect(listing!.deposit).toBe(650); // 1 month deposit of $650
      expect(listing!.min_lease).toBe(6);
      expect(listing!.phone).toBe('089 899 084');
      expect(listing!.photos).toEqual(photos);
      expect(listing!.source_url).toBe(
        'https://www.facebook.com/groups/siemreaprealestate/posts/987654321/',
      );
    });

    test('mapped listing passes RawListingSchema validation', async () => {
      const listing = await parseFacebookPostText(postText, defaultTarget, postUrl, photos);
      expect(listing).not.toBeNull();
      const result = RawListingSchema.safeParse(listing);
      expect(result.success).toBe(true);
    });

    test('handles minimal text post with reasonable defaults', async () => {
      const minimalText = 'Room for rent in Svay Dangkum $150';
      const listing = await parseFacebookPostText(minimalText, defaultTarget, 'https://facebook.com/p/1');

      expect(listing).not.toBeNull();
      expect(listing!.price).toBe(150);
      expect(listing!.category).toBe('room');
      expect(listing!.location).toBe('Svay Dangkum');
      expect(listing!.city).toBe('siem_reap');
      expect(RawListingSchema.safeParse(listing).success).toBe(true);
    });

    test('drops land sale listings automatically', async () => {
      const landPost = 'ដីលក់បន្ទាន់ Land for sale in Siem Reap $230/m2 size 20x30m';
      const listing = await parseFacebookPostText(landPost, defaultTarget, 'https://facebook.com/p/2');
      expect(listing).toBeNull();
    });
  });

  describe('FB_GROUP_TARGETS configuration', () => {
    test('has configured Siem Reap rental groups', () => {
      expect(FB_GROUP_TARGETS.length).toBeGreaterThanOrEqual(2);
      FB_GROUP_TARGETS.forEach((target) => {
        expect(target.city).toBe('siem_reap');
        expect(target.url).toContain('facebook.com/groups/');
      });
    });
  });

  describe('Session Error Handling', () => {
    test('FacebookSessionExpiredError has correct message and name', () => {
      const { FacebookSessionExpiredError } = require('../src/modules/parser/facebook.scraper');
      const err = new FacebookSessionExpiredError('Test session error');
      expect(err.name).toBe('FacebookSessionExpiredError');
      expect(err.message).toBe('Test session error');
    });
  });
});

