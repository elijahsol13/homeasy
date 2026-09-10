import type { RawListing } from '../src/modules/parser/schemas';
import type { LLMExtractedListing } from '../src/modules/parser/extractor';

jest.mock('../src/modules/parser/extractor', () => {
  const original = jest.requireActual('../src/modules/parser/extractor');
  return {
    ...original,
    extractListingsBatchWithLLM: jest.fn(),
  };
});

import { extractListingsBatchWithLLM } from '../src/modules/parser/extractor';
import { enrichListingsWithLLM } from '../src/modules/parser/khmer24.scraper';

const mockedBatch = extractListingsBatchWithLLM as jest.Mock;

function makeListing(overrides: Partial<RawListing> = {}): RawListing {
  return {
    title: 'ផ្ទះជួល នៅ សាលាកំរើក',
    description: 'ផ្ទះស្អាតមួយនៅជិតផ្សារ។ តម្លៃសមរម្យ។',
    price: 350,
    currency: 'USD',
    type: 'rent',
    category: 'house',
    city: 'siem_reap',
    location: 'Sala Kamreuk',
    photos: ['https://images.khmer24.co/x-b.jpg'],
    phone: '012345678',
    url: 'https://www.khmer24.com/post-adid-1',
    source_url: 'https://www.khmer24.com/post-adid-1',
    ...overrides,
  };
}

function makeLlmResult(overrides: Partial<LLMExtractedListing> = {}): LLMExtractedListing {
  return {
    is_real_estate: true,
    title_en: 'Charming House Near Market',
    price: null,
    currency: 'USD',
    category: 'house',
    bedrooms: 2,
    bathrooms: 1,
    min_lease: null,
    has_pool: false,
    location: 'Sala Kamreuk',
    phone_numbers: [],
    maps_url: null,
    description_en: 'A charming house near the market. Reasonable price.',
    ...overrides,
  };
}

describe('Khmer24: AI batch enrichment (enrichListingsWithLLM)', () => {
  beforeEach(() => {
    mockedBatch.mockReset();
  });

  test('rewrites title/description to the Gemini-translated English version', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult()]]));

    const [result] = await enrichListingsWithLLM([makeListing()]);

    expect(result.title).toBe('Charming House Near Market');
    expect(result.description).toBe('A charming house near the market. Reasonable price.');
    expect(result.bedrooms).toBe(2);
  });

  test('sends listings in micro-batches of 6 to conserve Gemini quota', async () => {
    mockedBatch.mockResolvedValue(new Map());
    const listings = Array.from({ length: 13 }, (_, i) => makeListing({ url: `https://www.khmer24.com/post-adid-${i}` }));

    await enrichListingsWithLLM(listings);

    // 13 listings / batch size 6 => 3 calls (6 + 6 + 1)
    expect(mockedBatch).toHaveBeenCalledTimes(3);
    expect(mockedBatch.mock.calls[0][0]).toHaveLength(6);
    expect(mockedBatch.mock.calls[1][0]).toHaveLength(6);
    expect(mockedBatch.mock.calls[2][0]).toHaveLength(1);
  });

  test('drops listings the LLM flags as non-real-estate or land', async () => {
    mockedBatch.mockResolvedValue(
      new Map([[0, makeLlmResult({ is_real_estate: false })]]),
    );

    const result = await enrichListingsWithLLM([makeListing()]);
    expect(result).toHaveLength(0);
  });

  test('drops listings with low translation quality (>10% untranslated Khmer)', async () => {
    mockedBatch.mockResolvedValue(
      new Map([[0, makeLlmResult({ description_en: 'ផ្ទះស្អាតនៅជិតផ្សារធំមួយកន្លែងល្អសម្រាប់ការស្នាក់នៅ' })]]),
    );

    const result = await enrichListingsWithLLM([makeListing()]);
    expect(result).toHaveLength(0);
  });

  test('falls back to original scraped text when the batch call fails entirely', async () => {
    mockedBatch.mockRejectedValue(new Error('Gemini 503'));

    const original = makeListing();
    const [result] = await enrichListingsWithLLM([original]);

    expect(result.title).toBe(original.title);
    expect(result.description).toBe(original.description);
  });

  test('falls back to original text for items the batch response omitted', async () => {
    // Batch call succeeds but only returns a result for the second item.
    mockedBatch.mockResolvedValue(new Map([[1, makeLlmResult()]]));

    const first = makeListing({ title: 'Original Untranslated Title 1', url: 'https://www.khmer24.com/post-adid-1' });
    const second = makeListing({ title: 'Original Untranslated Title 2', url: 'https://www.khmer24.com/post-adid-2' });

    const [resultFirst, resultSecond] = await enrichListingsWithLLM([first, second]);

    expect(resultFirst.title).toBe('Original Untranslated Title 1');
    expect(resultSecond.title).toBe('Charming House Near Market');
  });

  test('never overrides the reliable Khmer24-scraped price, photos, or phone', async () => {
    mockedBatch.mockResolvedValue(
      new Map([[0, makeLlmResult({ price: 999 })]]),
    );

    const original = makeListing({ price: 350, phone: '012345678' });
    const [result] = await enrichListingsWithLLM([original]);

    expect(result.price).toBe(350);
    expect(result.phone).toBe('012345678');
    expect(result.photos).toEqual(original.photos);
  });

  test('pre-filters spam before spending any Gemini quota on it', async () => {
    mockedBatch.mockResolvedValue(new Map());
    const spamListing = makeListing({
      title: 'Selling my Honda motorbike, low mileage',
      description: 'Honda motorbike for sale, negotiable price, call now',
    });

    const result = await enrichListingsWithLLM([spamListing]);

    expect(result).toHaveLength(0);
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  test('returns an empty array immediately for an empty input without calling the API', async () => {
    const result = await enrichListingsWithLLM([]);
    expect(result).toEqual([]);
    expect(mockedBatch).not.toHaveBeenCalled();
  });
});
