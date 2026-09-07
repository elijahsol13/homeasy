import {
  cleanFacebookUrl,
  extractPhoneFromText,
  parseFacebookPostText,
  extractStoriesFromGraphQL,
  extractTextFromStory,
  extractPhotosFromStory,
  extractUrlFromStory,
  extractDateFromStory,
  extractPostsFromFbGraphQL,
  FB_GROUP_TARGETS,
  type FBGroupTarget,
  type FbGraphQLStoryNode,
  getNextGroupBatch,
  loadScraperState,
  saveScraperState,
  SCRAPER_STATE_PATH,
  BROWSER_CACHE_DIR,
} from '../src/modules/parser/facebook.scraper';
import fs from 'fs';
import { RawListingSchema } from '../src/modules/parser/schemas';

jest.mock('../src/modules/parser/extractor', () => {
  const original = jest.requireActual('../src/modules/parser/extractor');
  return {
    ...original,
    extractListingWithLLM: jest.fn().mockImplementation(async (text: string, city: string) => {
      const isHotel = text.toLowerCase().includes('hotel');
      const isMinimal = text.includes('Room for rent in Svay Dangkum $150');
      return {
        title_en: isMinimal ? 'Room for rent in Svay Dangkum' : isHotel ? 'Boutique Hotel Room for rent' : 'Modern 3-Bedroom Villa with Swimming Pool',
        description_en: text,
        price: isMinimal ? 150 : isHotel ? 300 : 650,
        currency: 'USD',
        type: 'rent',
        category: isHotel ? 'hotel' : isMinimal ? 'room' : 'house',
        bedrooms: isMinimal ? 1 : isHotel ? 1 : 3,
        bathrooms: isMinimal ? 1 : isHotel ? 1 : 3,
        deposit: isMinimal ? 150 : isHotel ? 300 : 650,
        min_lease: 6,
        has_pool: isHotel || !isMinimal,
        location: isMinimal ? 'Svay Dangkum' : isHotel ? 'Wat Bo' : 'Sala Kamreuk',
        city: city || 'siem_reap',
        phone: isMinimal ? undefined : '089 899 084',
      };
    }),
  };
});

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
    jest.setTimeout(30000);

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

    test('categorizes hotel room as hotel', async () => {
      const hotelPost = 'Boutique Hotel Room for rent in Wat Bo, Siem Reap $300/month with pool and cleaning included.';
      const listing = await parseFacebookPostText(hotelPost, defaultTarget, 'https://facebook.com/p/3');
      expect(listing).not.toBeNull();
      expect(listing!.category).toBe('hotel');
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

  describe('Facebook GraphQL API Extraction Engine', () => {
    const sampleStory: FbGraphQLStoryNode = {
      __typename: 'Story',
      id: 'S:_I123456:9988776655',
      post_id: '9988776655',
      creation_time: 1725600000,
      comet_sections: {
        context_layout: {
          story: {
            comet_sections: {
              metadata: [
                {
                  story: {
                    creation_time: 1725600000,
                    url: 'https://www.facebook.com/groups/siemreaprealestate/posts/9988776655/?__cft__[0]=AZX',
                  },
                },
              ],
            },
          },
        },
        content: {
          story: {
            message: {
              text: 'Modern 2BR apartment for rent in Wat Bo, Siem Reap. $450/month with pool and wifi. Contact: 012 345 678',
            },
            attachments: [
              {
                styles: {
                  attachment: {
                    media: {
                      photo_image: {
                        uri: 'https://scontent.fpnh1-1.fna.fbcdn.net/v/t39.30808-6/photo1.jpg?stp=dst-jpg',
                      },
                    },
                    all_subattachments: {
                      nodes: [
                        {
                          media: {
                            image: {
                              uri: 'https://scontent.fpnh1-1.fna.fbcdn.net/v/t39.30808-6/photo2.jpg?stp=dst-jpg',
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };

    test('extractStoriesFromGraphQL finds Story nodes in Relay response', () => {
      const relayResponse = {
        data: {
          node: {
            __typename: 'Group',
            group_feed: {
              edges: [
                { cursor: 'cur1', node: sampleStory },
                { cursor: 'cur2', node: { __typename: 'Ad' } }, // ignored
              ],
            },
          },
        },
      };

      const stories = extractStoriesFromGraphQL(relayResponse);
      expect(stories.length).toBe(1);
      expect(stories[0]!.post_id).toBe('9988776655');
    });

    test('extractTextFromStory extracts complete message and strips UI noise', () => {
      const text = extractTextFromStory(sampleStory);
      expect(text).toContain('Modern 2BR apartment for rent in Wat Bo');
      expect(text).toContain('$450/month');
      expect(text).not.toContain('See more');
    });

    test('extractPhotosFromStory extracts primary and subattachment photo URLs', () => {
      const photos = extractPhotosFromStory(sampleStory);
      expect(photos.length).toBe(2);
      expect(photos[0]).toContain('photo1.jpg');
      expect(photos[1]).toContain('photo2.jpg');
    });

    test('extractUrlFromStory extracts permalink and cleans tracking params', () => {
      const url = extractUrlFromStory(sampleStory, defaultTarget.url);
      expect(url).toBe('https://www.facebook.com/groups/siemreaprealestate/posts/9988776655/');
      expect(url).not.toContain('__cft__');
    });

    test('extractDateFromStory converts epoch timestamp to ISO string', () => {
      const dateStr = extractDateFromStory(sampleStory);
      expect(dateStr).toBeDefined();
      expect(new Date(dateStr!).getTime()).toBe(1725600000 * 1000);
    });

    test('extractPostsFromFbGraphQL handles complete feed JSON into parsed posts', () => {
      const relayResponse = {
        data: {
          node: {
            __typename: 'Group',
            group_feed: {
              edges: [{ node: sampleStory }],
            },
          },
        },
      };

      const posts = extractPostsFromFbGraphQL(relayResponse, defaultTarget.url);
      expect(posts.length).toBe(1);
      expect(posts[0]!.id).toBe('9988776655');
      expect(posts[0]!.text).toContain('Modern 2BR apartment');
      expect(posts[0]!.photos.length).toBe(2);
      expect(posts[0]!.postUrl).toBe(
        'https://www.facebook.com/groups/siemreaprealestate/posts/9988776655/',
      );
    });

    test('extractTextFromStory falls back to comet_sections.message.story.text', () => {
      const alternativeStory: FbGraphQLStoryNode = {
        __typename: 'Story',
        id: '12345',
        comet_sections: {
          message: {
            story: {
              text: 'Cozy wooden bungalow for rent in Svay Dangkum $300/mo. Phone: 089 999 888',
            },
          },
        },
      };

      const text = extractTextFromStory(alternativeStory);
      expect(text).toContain('Cozy wooden bungalow');
    });
  });

  describe('Round-Robin Group Batching & State Management', () => {
    const backupState = fs.existsSync(SCRAPER_STATE_PATH)
      ? fs.readFileSync(SCRAPER_STATE_PATH, 'utf-8')
      : null;

    afterAll(() => {
      if (backupState !== null) {
        fs.writeFileSync(SCRAPER_STATE_PATH, backupState, 'utf-8');
      } else if (fs.existsSync(SCRAPER_STATE_PATH)) {
        fs.unlinkSync(SCRAPER_STATE_PATH);
      }
    });

    test('saveScraperState and loadScraperState correctly persist cursor', () => {
      saveScraperState({ fbGroupCursor: 42, lastCycleAt: '2026-09-07T12:00:00Z' });
      const loaded = loadScraperState();
      expect(loaded.fbGroupCursor).toBe(42);
      expect(loaded.lastCycleAt).toBe('2026-09-07T12:00:00Z');
    });

    test('getNextGroupBatch returns batches of specified size and advances cursor through wrap-around', () => {
      const mockTargets: FBGroupTarget[] = [
        { name: 'Group 0', url: 'https://fb.com/0', city: 'siem_reap' },
        { name: 'Group 1', url: 'https://fb.com/1', city: 'siem_reap' },
        { name: 'Group 2', url: 'https://fb.com/2', city: 'siem_reap' },
        { name: 'Group 3', url: 'https://fb.com/3', city: 'siem_reap' },
        { name: 'Group 4', url: 'https://fb.com/4', city: 'siem_reap' },
        { name: 'Group 5', url: 'https://fb.com/5', city: 'siem_reap' },
        { name: 'Group 6', url: 'https://fb.com/6', city: 'siem_reap' },
      ];

      // Reset to 0
      saveScraperState({ fbGroupCursor: 0 });

      // Cycle 1: batch of 3 (0, 1, 2)
      const res1 = getNextGroupBatch(mockTargets, 3);
      expect(res1.batch.map((t) => t.name)).toEqual(['Group 0', 'Group 1', 'Group 2']);
      expect(res1.nextCursor).toBe(3);

      // Cycle 2: batch of 3 (3, 4, 5)
      const res2 = getNextGroupBatch(mockTargets, 3);
      expect(res2.batch.map((t) => t.name)).toEqual(['Group 3', 'Group 4', 'Group 5']);
      expect(res2.nextCursor).toBe(6);

      // Cycle 3: batch of 3 (6, 0, 1) -> wraps around
      const res3 = getNextGroupBatch(mockTargets, 3);
      expect(res3.batch.map((t) => t.name)).toEqual(['Group 6', 'Group 0', 'Group 1']);
      expect(res3.nextCursor).toBe(2);
    });

    test('BROWSER_CACHE_DIR points to data/browser_cache', () => {
      expect(BROWSER_CACHE_DIR).toContain('browser_cache');
      expect(BROWSER_CACHE_DIR).toContain('data');
    });
  });
});


