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
import { classifyKhmer24Listing, enrichListingsWithLLM } from '../src/modules/parser/khmer24.scraper';
import { sanitizeListingFacts } from '../src/modules/parser/listing-extraction';
import { toLegacyListingExtraction } from '../src/modules/parser/canonical-listing-adapter';
import { normalizeRawToClean } from '../src/modules/parser/ingestor';
import { RawListingSchema } from '../src/modules/parser/schemas';

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
    pet_friendly: null,
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

  test('missing or failed enrichment remains unclassified, not falsely irrelevant', () => {
    expect(classifyKhmer24Listing(undefined)).toBe('UNCLASSIFIED');
    expect(classifyKhmer24Listing(makeListing())).toBe('UNCLASSIFIED');
    expect(classifyKhmer24Listing(makeListing({ is_real_estate: true }))).toBe('HOUSING_SUPPLY');
    expect(classifyKhmer24Listing(makeListing({ is_real_estate: false }))).toBe('IRRELEVANT');
  });

  test('rewrites title/description to the Gemini-translated English version', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult()]]));

    const [result] = await enrichListingsWithLLM([makeListing()]);

    expect(result.title).toBe('Charming House Near Market');
    expect(result.description).toBe('A charming house near the market. Reasonable price.');
    expect(result.bedrooms).toBe(2);
  });

  test('sends verbatim source title/body to AI and preserves the title for canonical room checks', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({ bedrooms: 1 })]]));
    const source = makeListing({
      title: 'Normalized display name',
      description: 'Normalized display description',
      source_title: 'Private house: 2 Bedrooms',
      raw_text: '2 Bedrooms, 3 Bathrooms, $350/month',
    });

    const [result] = await enrichListingsWithLLM([source]);

    expect(mockedBatch.mock.calls[0][0][0].text).toBe('Private house: 2 Bedrooms\n\n2 Bedrooms, 3 Bathrooms, $350/month');
    expect(result.source_title).toBe('Private house: 2 Bedrooms');
    expect(result.raw_text).toBe(source.raw_text);
    expect(result.title).toBe('Charming House Near Market');
  });

  test('retains the original heading when a source_title field was not provided', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult()]]));
    const [result] = await enrichListingsWithLLM([makeListing({ title: '3 Bedrooms Villa' })]);
    expect(result.source_title).toBe('3 Bedrooms Villa');
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

  test('failed batch keeps raw source but publishes only verified factual fallback in pending review', async () => {
    mockedBatch.mockRejectedValue(new Error('Gemini 503'));

    const original = makeListing({ title: 'House for rent', raw_text: 'House for rent. 2 bedrooms, 1 bathroom. Call 012345678!!!',
      bedrooms: 2, bathrooms: 1 });
    const [result] = await enrichListingsWithLLM([original]);

    expect(result.title).toBe(original.title);
    expect(result.raw_text).toBe(original.raw_text);
    expect(result.description).toBe('House for rent with 2 bedrooms and 1 bathroom.');
    expect(result.review_status).toBe('pending');
  });

  test('falls back to original text for items the batch response omitted', async () => {
    // Batch call succeeds but only returns a result for the second item.
    mockedBatch.mockResolvedValue(new Map([[1, makeLlmResult()]]));

    const first = makeListing({ title: 'Original Untranslated Title 1', url: 'https://www.khmer24.com/post-adid-1' });
    const second = makeListing({ title: 'Original Untranslated Title 2', url: 'https://www.khmer24.com/post-adid-2' });

    const [resultFirst, resultSecond] = await enrichListingsWithLLM([first, second]);

    expect(resultFirst.title).toBe('Original Untranslated Title 1');
    expect(resultFirst.description).toBe('House for rent.');
    expect(resultFirst.review_status).toBe('pending');
    expect(resultSecond.title).toBe('Charming House Near Market');
  });

  test('empty AI description produces bounded copy without overriding canonical unknown room counts', async () => {
    const source = makeListing({ title: 'Apartment', source_title: 'Apartment',
      raw_text: '2 bedrooms. 3 bedrooms. 1 bathroom. 2 bathrooms. Contact 012345678.', bedrooms: 3, bathrooms: 3 });
    const facts = sanitizeListingFacts({ is_supported_listing: true, title_en: 'Apartment',
      description_en: '', category: 'apartment', property_type: 'Apartment',
      bedrooms: null, bathrooms: null, price: 350, currency: 'USD' }, source.raw_text!, {})!;
    mockedBatch.mockResolvedValue(new Map([[0, toLegacyListingExtraction(facts)]]));
    const [result] = await enrichListingsWithLLM([source]);
    expect(result.description).toBe('Apartment for rent.');
    expect(result.bedrooms).toBeUndefined();
    expect(result.bathrooms).toBeUndefined();
    expect(result.raw_text).toBe(source.raw_text);
  });

  test('never overrides the reliable Khmer24-scraped price, photos, or phone', async () => {
    mockedBatch.mockResolvedValue(
      new Map([[0, makeLlmResult({ price: 999 })]]),
    );

    const original = makeListing({ price: 350, phone: '012345678', source_price: 350,
      source_price_currency: 'USD', source_price_origin: 'khmer24_json_ld_offer' });
    const [result] = await enrichListingsWithLLM([original]);

    expect(result.price).toBe(350);
    expect(result.source_price).toBe(350);
    expect(result.source_price_currency).toBe('USD');
    expect(result.source_price_origin).toBe('khmer24_json_ld_offer');
    expect(result.phone).toBe('012345678');
    expect(result.photos).toEqual(original.photos);
  });

  test('author price and room counts prevail over conflicting Khmer24 form values all the way to clean columns', async () => {
    const source = makeListing({
      title: 'House for rent', source_title: 'House for rent',
      raw_text: 'House for rent $1000/month, 2 bedrooms and 1 bathroom.',
      price: 800, source_price: 800, source_price_currency: 'USD',
      bedrooms: 3, bathrooms: 2,
    });
    const facts = sanitizeListingFacts({
      is_supported_listing: true, title_en: '2 Bedroom House',
      description_en: 'House for rent with 2 bedrooms and 1 bathroom.',
      price: 1000, currency: 'USD', bedrooms: 2, bathrooms: 1,
      property_type: 'Private House',
    }, `${source.source_title}\n${source.raw_text}`, {
      asking_price: 800, platform_bedrooms: 3, platform_bathrooms: 2,
    })!;
    mockedBatch.mockResolvedValue(new Map([[0, toLegacyListingExtraction(facts)]]));

    const [result] = await enrichListingsWithLLM([source]);
    expect(result).toMatchObject({ price: 1000, bedrooms: 2, bathrooms: 1 });
    const clean = normalizeRawToClean(RawListingSchema.parse(result))!;
    expect(clean).toMatchObject({ price: 100000, bedrooms: 2, bathrooms: 1 });
    expect(JSON.parse(clean.listing_facts_json!)).toMatchObject({ price: 1000, bedrooms: 2, bathrooms: 1 });
  });

  test('an intentional null price and conflicting room count stay unknown in legacy and clean columns', async () => {
    const source = makeListing({
      title: 'House for rent', source_title: 'House for rent',
      raw_text: 'House for rent, contact for price. 2 bedrooms, 3 bedrooms.',
      price: 800, source_price: 800, bedrooms: 4,
    });
    const facts = sanitizeListingFacts({
      is_supported_listing: true, title_en: '4 Bedroom House',
      description_en: 'House with 4 bedrooms is available.',
      price: null, currency: null, bedrooms: 4, property_type: 'Private House',
    }, `${source.source_title}\n${source.raw_text}`, {
      asking_price: 800, platform_bedrooms: 4,
    })!;
    mockedBatch.mockResolvedValue(new Map([[0, toLegacyListingExtraction(facts)]]));

    const [result] = await enrichListingsWithLLM([source]);
    expect(result.price).toBeUndefined();
    expect(result.bedrooms).toBeUndefined();
    expect(result.review_status).toBe('pending');
    expect(result.title).not.toMatch(/4\s*bedroom/i);
    const clean = normalizeRawToClean(RawListingSchema.parse(result))!;
    expect(clean).toMatchObject({ price: 0, bedrooms: null });
    expect(JSON.parse(clean.listing_facts_json!)).toMatchObject({ price: null, bedrooms: null });
  });

  test('when author omits room counts, matching AI and platform counts survive', async () => {
    const source = makeListing({
      title: 'House for rent', source_title: 'House for rent',
      raw_text: 'House available for monthly rent.', bedrooms: 3, bathrooms: 2,
    });
    const facts = sanitizeListingFacts({
      is_supported_listing: true, title_en: '3 Bedroom House',
      description_en: 'House with 3 bedrooms and 2 bathrooms.',
      price: 350, currency: 'USD', bedrooms: 3, bathrooms: 2,
    }, `${source.source_title}\n${source.raw_text}`, {
      platform_bedrooms: 3, platform_bathrooms: 2,
    })!;
    mockedBatch.mockResolvedValue(new Map([[0, toLegacyListingExtraction(facts)]]));

    const [result] = await enrichListingsWithLLM([source]);
    expect(result).toMatchObject({ bedrooms: 3, bathrooms: 2 });
    expect(normalizeRawToClean(RawListingSchema.parse(result))).toMatchObject({ bedrooms: 3, bathrooms: 2 });
  });

  test('keeps a source map while rejecting an AI map to a promotional landmark', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({
      maps_url: 'https://maps.google.com/?q=13.370000,103.880000',
    })]]));
    const originalMap = 'https://maps.google.com/?q=13.351234,103.864567';
    const [withPin] = await enrichListingsWithLLM([makeListing({
      latitude: 13.351234, longitude: 103.864567, maps_url: originalMap,
    })]);
    expect(withPin).toMatchObject({
      latitude: 13.351234, longitude: 103.864567, maps_url: originalMap,
    });
    const [withoutPin] = await enrichListingsWithLLM([makeListing()]);
    expect(withoutPin.maps_url).toBeUndefined();
    expect(withoutPin.latitude).toBeUndefined();
    expect(withoutPin.longitude).toBeUndefined();
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

  test('sends Khmer property sale with a vehicle-related landmark to AI for rejection', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({
      is_real_estate: false,
      admission_reason: 'House and land are offered for sale, not monthly rent',
    })]]));
    const source = makeListing({
      title: 'ផ្ទះដីលក់បន្ទាន់ ជិតឆៀកឡាន វត្តស្វាយធំ',
      description: 'លក់ផ្ទះដី ជិតឆៀកឡាន',
      price: 37000,
    });

    const [result] = await enrichListingsWithLLM([source], { inclusive: true });

    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBatch.mock.calls[0][0][0].text).toContain('ផ្ទះដីលក់បន្ទាន់');
    expect(result).toMatchObject({ is_real_estate: false, review_reason: expect.stringContaining('sale') });
    expect(classifyKhmer24Listing(result)).toBe('IRRELEVANT');
  });

  test('returns an empty array immediately for an empty input without calling the API', async () => {
    const result = await enrichListingsWithLLM([]);
    expect(result).toEqual([]);
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  test('inclusive mode preserves an explicit rejection, its reason, facts, and original source text', async () => {
    const original = makeListing({ raw_text: 'Original Khmer24 source text' });
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({
      is_real_estate: false,
      admission_reason: 'For sale, not monthly rent',
      canonical_facts: { rejection_reason: 'Sale offer', price: null } as NonNullable<LLMExtractedListing['canonical_facts']>,
    })]]));

    const result = await enrichListingsWithLLM([original], { inclusive: true });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: original.title, description: original.description, raw_text: original.raw_text,
      is_real_estate: false, review_status: 'pending', review_reason: 'For sale, not monthly rent',
    });
    expect(JSON.parse(result[0].listing_facts_json!)).toMatchObject({ rejection_reason: 'Sale offer' });
    expect(classifyKhmer24Listing(result[0])).toBe('IRRELEVANT');
  });

  test('inclusive mode rejects land even if the LLM labels it real estate', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({ is_real_estate: true, category: 'land' })]]));

    const [result] = await enrichListingsWithLLM([makeListing()], { inclusive: true });

    expect(result).toMatchObject({ is_real_estate: false, review_reason: 'Unsupported land category' });
    expect(classifyKhmer24Listing(result)).toBe('IRRELEVANT');
  });

  test('inclusive mode keeps poor translations quarantined with extracted facts and original text', async () => {
    const original = makeListing({ raw_text: 'Verbatim original', is_real_estate: true });
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({
      description_en: 'ផ្ទះស្អាតនៅជិតផ្សារធំមួយកន្លែងល្អសម្រាប់ការស្នាក់នៅ',
      canonical_facts: { rejection_reason: null, price: 350 } as NonNullable<LLMExtractedListing['canonical_facts']>,
    })]]));

    const [result] = await enrichListingsWithLLM([original], { inclusive: true });

    expect(result).toMatchObject({
      raw_text: 'Verbatim original', title: original.title, description: original.description,
      is_real_estate: null, review_reason: expect.stringContaining('translation quality'),
    });
    expect(JSON.parse(result.listing_facts_json!)).toMatchObject({ price: 350 });
    expect(classifyKhmer24Listing(result)).toBe('UNCLASSIFIED');
  });

  test('inclusive mode keeps original input order when a spam prefilter skips a record', async () => {
    mockedBatch.mockResolvedValue(new Map([[0, makeLlmResult({ is_real_estate: false })]]));
    const first = makeListing({ url: 'https://www.khmer24.com/post-adid-111' });
    const spam = makeListing({
      url: 'https://www.khmer24.com/post-adid-222',
      title: 'Selling my Honda motorbike, low mileage',
      description: 'Honda motorbike for sale, negotiable price, call now',
    });
    const last = makeListing({ url: 'https://www.khmer24.com/post-adid-333' });

    const results = await enrichListingsWithLLM([spam, first, last], { inclusive: true });

    expect(results.map((listing) => listing.url)).toEqual([spam.url, first.url, last.url]);
    expect(results[0]).toMatchObject({ is_real_estate: null, review_reason: expect.stringContaining('Spam prefilter:') });
    expect(results[1].is_real_estate).toBe(false);
    expect(results[2].is_real_estate).toBeNull();
    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBatch.mock.calls[0][0]).toHaveLength(2);
  });

  test('inclusive mode clears stale positive classification when extraction is unavailable', async () => {
    mockedBatch.mockRejectedValue(new Error('Rate limit'));
    const original = makeListing({ is_real_estate: true, review_status: 'approved' });

    const [result] = await enrichListingsWithLLM([original], { inclusive: true });

    expect(result).toMatchObject({
      is_real_estate: null, review_status: 'pending', review_reason: 'LLM extraction unavailable',
    });
    expect(classifyKhmer24Listing(result)).toBe('UNCLASSIFIED');
  });
});
