import type { LLMExtractedListing } from '../src/modules/parser/extractor';
import type { FetchedFbPost } from '../src/modules/parser/fb-worker';

jest.mock('../src/modules/parser/extractor', () => {
  const original = jest.requireActual('../src/modules/parser/extractor');
  return {
    ...original,
    extractListingsBatchWithLLM: jest.fn(),
  };
});

import { extractListingsBatchWithLLM } from '../src/modules/parser/extractor';
import { batchExtractFbPosts } from '../src/modules/parser/facebook.scraper';

const mockedBatch = extractListingsBatchWithLLM as jest.Mock;

function makePost(overrides: Partial<FetchedFbPost> = {}): FetchedFbPost {
  return {
    postUrl: 'https://facebook.com/groups/siemreaprealestate/posts/1',
    text: '2 bedroom apartment for rent in Svay Dangkum, $350/month, pool available',
    photos: [],
    ...overrides,
  };
}

function makeLlmResult(overrides: Partial<LLMExtractedListing> = {}): LLMExtractedListing {
  return {
    is_real_estate: true,
    title_en: 'Modern 2BR Apartment in Svay Dangkum',
    price: 350,
    currency: 'USD',
    category: 'apartment',
    bedrooms: 2,
    bathrooms: 1,
    min_lease: null,
    has_pool: true,
    location: 'Svay Dangkum',
    phone_numbers: [],
    maps_url: null,
    description_en: 'Modern 2 bedroom apartment with pool access.',
    ...overrides,
  };
}

describe('Facebook: batchExtractFbPosts', () => {
  beforeEach(() => {
    mockedBatch.mockReset();
  });

  test('sends fetched posts in micro-batches of 6 to conserve Gemini quota', async () => {
    mockedBatch.mockResolvedValue(new Map());
    const posts = Array.from({ length: 13 }, (_, i) =>
      makePost({ postUrl: `https://facebook.com/groups/siemreaprealestate/posts/${i}` }),
    );

    await batchExtractFbPosts(posts);

    // 13 posts / batch size 6 => 3 calls (6 + 6 + 1)
    expect(mockedBatch).toHaveBeenCalledTimes(3);
    expect(mockedBatch.mock.calls[0][0]).toHaveLength(6);
    expect(mockedBatch.mock.calls[1][0]).toHaveLength(6);
    expect(mockedBatch.mock.calls[2][0]).toHaveLength(1);
  });

  test('returns results keyed by the post index in the input array', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult()], [1, makeLlmResult({ title_en: 'Second' })]]));

    const results = await batchExtractFbPosts([makePost(), makePost()]);

    expect(results.get(0)?.title_en).toBe('Modern 2BR Apartment in Svay Dangkum');
    expect(results.get(1)?.title_en).toBe('Second');
  });

  test('pre-filters obvious spam before spending any Gemini quota on it', async () => {
    mockedBatch.mockResolvedValue(new Map());
    const spamPost = makePost({ text: 'Selling my Honda motorbike, low mileage, negotiable price' });

    const results = await batchExtractFbPosts([spamPost]);

    expect(results.size).toBe(0);
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  test('gracefully returns partial results when a batch call fails', async () => {
    mockedBatch
      .mockResolvedValueOnce(new Map([[0, makeLlmResult()]]))
      .mockRejectedValueOnce(new Error('Gemini 503'));

    const posts = Array.from({ length: 7 }, (_, i) =>
      makePost({ postUrl: `https://facebook.com/groups/siemreaprealestate/posts/${i}` }),
    );

    const results = await batchExtractFbPosts(posts);

    expect(results.get(0)).toBeDefined();
    expect(results.get(6)).toBeUndefined(); // second batch (index 6) failed
  });

  test('returns an empty map immediately for empty input without calling the API', async () => {
    const results = await batchExtractFbPosts([]);
    expect(results.size).toBe(0);
    expect(mockedBatch).not.toHaveBeenCalled();
  });
});
