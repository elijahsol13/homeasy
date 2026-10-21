import { FacebookLiveAdapter, Khmer24LiveAdapter } from '../src/modules/parser/live-source-adapters';

describe('live unified source adapters', () => {
  const context = { runType: 'DISCOVERY' as const, ingestionMethod: 'KHMER24_SCRAPER' as const };

  it('normalizes Khmer24 ad IDs, photos, media hashes and source text', () => {
    const adapter = new Khmer24LiveAdapter(async function* () { /* no network in adapter tests */ });
    const item = adapter.normalize({ sourceId: 'siem-reap', sourceName: 'Khmer24',
      listing: { title: 'Apartment', description: 'For rent $350/month', raw_text: 'For rent $350/month',
        source_url: 'https://www.khmer24.com/en/apartment-adid-12345', city: 'siem_reap',
        photos: ['https://img.example/a.jpg', 'https://img.example/a.jpg'] } });
    expect(item.externalId).toBe('12345');
    expect(item.classification).toBe('UNCLASSIFIED');
    expect(item.rawText).toBe('For rent $350/month');
    expect(item.mediaHash).toHaveLength(64);
    expect((item.raw as unknown as { photos: string[] }).photos).toHaveLength(1);
  });

  it('retains independently captured Khmer24 source asking price and provenance in raw payload', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const item = adapter.normalize({ sourceId: 'siem-reap', sourceName: 'Khmer24', listing: {
      title: 'House for rent', raw_text: 'In Siem Reap, 2 bedrooms', price: 375,
      source_price: 350, source_price_currency: 'USD', source_price_origin: 'khmer24_json_ld_offer',
      source_url: 'https://www.khmer24.com/en/house-adid-123456', city: 'siem_reap', photos: [],
    } });
    expect((item.raw as unknown as { listing: Record<string, unknown> }).listing).toMatchObject({
      price: 375, source_price: 350, source_price_currency: 'USD', source_price_origin: 'khmer24_json_ld_offer',
    });
  });

  it('preserves source text exactly and hashes different whitespace as a new version', () => {
    const adapter = new FacebookLiveAdapter(async function* () {});
    const normalize = (raw_text: string) => adapter.normalize({
      sourceId: '12345', sourceName: 'Siem Reap group', groupId: '12345',
      listing: { title: 'Translated title', description: 'Translated body', raw_text,
        source_url: 'https://www.facebook.com/groups/12345/posts/67890', city: 'siem_reap', photos: [] },
    });
    const original = normalize('  first line\nsecond line\n\n');
    expect(original.rawText).toBe('  first line\nsecond line\n\n');
    expect((original.raw.listing as { raw_text?: string }).raw_text).toBe(original.rawText);
    expect(original.contentHash).not.toBe(normalize('first line\nsecond line').contentHash);
    expect(normalize('').rawText).toBe('');
    expect(original.classification).toBe('UNCLASSIFIED');
    expect(adapter.normalize({ sourceId: '12345', sourceName: 'Group',
      listing: { source_url: 'https://facebook.com/groups/12345/posts/67890', is_real_estate: true, photos: [] },
    }).classification).toBe('HOUSING_SUPPLY');
  });

  it('uses a structured Facebook post ID for opaque permalinks and rejects conflicting IDs', () => {
    const adapter = new FacebookLiveAdapter(async function* () {});
    const base = { sourceId: 'group-1', sourceName: 'Group 1', groupId: 'group-1',
      listing: { photos: [], source_url: 'https://www.facebook.com/share/p/share-token/', facebook_post_id: '9988776655' } };
    expect(adapter.normalize(base).externalId).toBe('9988776655');
    expect(() => adapter.normalize({
      ...base,
      listing: { ...base.listing, source_url: 'https://www.facebook.com/groups/group-1/posts/11223344/', facebook_post_id: '9988776655' },
    })).toThrow(/conflicts with permalink/);
    expect(() => adapter.normalize({
      ...base,
      listing: { ...base.listing, facebook_post_id: 'S:_I123:9988776655' },
    })).toThrow(/structured post ID is invalid/);
  });

  it('retains valid JSON room counts, prefers valid raw counts and rejects invalid counts', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const normalize = (listing: Record<string, unknown>) => adapter.normalize({sourceId:'siem-reap',sourceName:'Khmer24',
      listing: {title:'Apartment',raw_text:'Apartment for rent',source_url:'https://khmer24.com/en/apartment-adid-12345',city:'siem_reap',photos:[],...listing}});
    const facts = (listing: Record<string, unknown>) => (normalize(listing).raw as unknown as {listingExtraction:Record<string,unknown>}).listingExtraction;
    expect(facts({listing_facts_json:JSON.stringify({bedrooms:3,bathrooms:2})})).toMatchObject({bedrooms:3,bathrooms:2});
    expect(facts({bedrooms:0,bathrooms:4,listing_facts_json:JSON.stringify({bedrooms:3,bathrooms:2})})).toMatchObject({bedrooms:0,bathrooms:4});
    expect(facts({bedrooms:-1,bathrooms:1.5,listing_facts_json:JSON.stringify({bedrooms:3,bathrooms:2})})).toMatchObject({bedrooms:3,bathrooms:2});
    expect(facts({listing_facts_json:'invalid'})).toMatchObject({bedrooms:null,bathrooms:null});
    expect(facts({listing_facts_json:'[2,3]'})).toMatchObject({bedrooms:null,bathrooms:null});
  });

  it('does not use AI room estimates to cover contradictory original room counts', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const result = adapter.normalize({ sourceId:'siem-reap', sourceName:'Khmer24',
      listing:{source_url:'https://khmer24.com/en/post-adid-12345', city:'siem_reap',
        raw_text:'For rent. 2 bedrooms. Bedrooms: 3. 1 bathroom. Bathrooms: 2.',
        bedrooms: 4, bathrooms: 4, listing_facts_json:JSON.stringify({bedrooms:5,bathrooms:5}),photos:[]},
    });
    expect((result.raw as unknown as {listingExtraction:Record<string,unknown>}).listingExtraction)
      .toMatchObject({bedrooms:null,bathrooms:null});
  });

  it('corrects Facebook AI room guesses from nonconflicting numbers in the retained original', () => {
    const adapter = new FacebookLiveAdapter(async function* () {});
    const listing = { source_url:'https://facebook.com/groups/123/posts/456', city:'siem_reap' as const,
      raw_text:'02 – Bedroom Apartment for Rent in Siem Reap. Bedroom: 02 — Bathroom: 03. $380/Month',
      bedrooms:1, bathrooms:1, photos:[] };
    const extracted = (adapter.normalize({sourceId:'123',sourceName:'Group',listing}).raw as unknown as {
      listingExtraction:Record<string,unknown> }).listingExtraction;
    expect(extracted).toMatchObject({bedrooms:2,bathrooms:3});
    const contradictory = (adapter.normalize({sourceId:'123',sourceName:'Group',
      listing:{...listing, raw_text:listing.raw_text+'\nBedrooms: 1'} }).raw as unknown as {
        listingExtraction:Record<string,unknown> }).listingExtraction;
    expect(contradictory.bedrooms).toBeNull();
  });

  it('keeps a Facebook map only when its resolved URL has provenance from the labelled original link', () => {
    const adapter = new FacebookLiveAdapter(async function* () {});
    const sourceMap = 'https://maps.app.goo.gl/shortCode';
    const resolvedMap = 'https://www.google.com/maps/place/House/@13.352345,103.865432/data=!3d13.352345!4d103.865432';
    const listing = {
      source_url: 'https://www.facebook.com/groups/123/posts/456', city: 'siem_reap' as const,
      raw_text: `House for rent in Siem Reap.\nProperty location: ${sourceMap}`,
      maps_url: resolvedMap, latitude: 13.352345, longitude: 103.865432, photos: [],
    };
    const normalizedOf = (overrides: Record<string, unknown>) => adapter.normalize({ sourceId: '123', sourceName: 'Group',
      listing: { ...listing, ...overrides } });
    const factsOf = (overrides: Record<string, unknown>) =>
      (normalizedOf(overrides).raw as unknown as { listingExtraction: Record<string, unknown> }).listingExtraction;

    expect(factsOf({}).maps_url).toBeUndefined();
    expect(normalizedOf({}).deterministicIdentifiers).not.toContainEqual(expect.objectContaining({ type: 'MAPS_URL' }));
    expect(factsOf({ source_map_url: sourceMap, maps_url: 'https://attacker.example/map' }).maps_url).toBeUndefined();
    const accepted = normalizedOf({ source_map_url: sourceMap });
    expect((accepted.raw as unknown as { listingExtraction: Record<string, unknown> }).listingExtraction).toMatchObject({
      maps_url: resolvedMap, latitude: 13.352345, longitude: 103.865432,
    });
    expect(accepted.deterministicIdentifiers).toContainEqual(expect.objectContaining({ type: 'MAPS_URL', rawValue: resolvedMap }));
    const mismatchedCoordinates = factsOf({ source_map_url: sourceMap,
      latitude: 13.352345, longitude: 103.865432,
      maps_url: resolvedMap.replace('!4d103.865432', '!4d103.855432'),
    });
    expect(mismatchedCoordinates.maps_url).toBeDefined();
    expect(mismatchedCoordinates).not.toHaveProperty('latitude');
    expect(mismatchedCoordinates).not.toHaveProperty('longitude');
  });

  it('uses Khmer24 source coordinates and ignores hallucinated AI map facts', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const normalize = (overrides: Record<string, unknown>) => adapter.normalize({
      sourceId: 'siem-reap', sourceName: 'Khmer24',
      listing: { source_url: 'https://www.khmer24.com/en/post-adid-14071624', city: 'siem_reap',
        title: 'Villa', photos: [], ...overrides },
    });
    const facts = (overrides: Record<string, unknown>) =>
      (normalize(overrides).raw as unknown as { listingExtraction: Record<string, unknown> }).listingExtraction;
    const hallucination = JSON.stringify({ latitude: 13.370000, longitude: 103.880000,
      maps_url: 'https://maps.google.com/?q=13.370000,103.880000' });
    expect(facts({ listing_facts_json: hallucination })).not.toHaveProperty('latitude');
    expect(facts({ listing_facts_json: hallucination })).not.toHaveProperty('longitude');
    expect(facts({ listing_facts_json: hallucination })).not.toHaveProperty('maps_url');
    expect(facts({ latitude: 13.351234, longitude: 103.864567, listing_facts_json: hallucination }))
      .toMatchObject({ latitude: 13.351234, longitude: 103.864567 });
    expect(facts({ latitude: 13.351234, longitude: 103.864567, listing_facts_json: hallucination }).maps_url)
      .toBeUndefined();
  });

  it('does not reintroduce Khmer24 district-centre coordinates from historical payloads', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const base = { sourceId: 'siem-reap', sourceName: 'Khmer24', listing: {
      title: 'Villa for rent in Sala Kamreuk', city: 'siem_reap' as const,
      source_url: 'https://www.khmer24.com/en/post-adid-14071624', photos: [],
      latitude: 13.35789016603966, longitude: 103.86067953898747,
      maps_url: 'https://maps.google.com/?q=13.35789016603966,103.86067953898747',
      listing_facts_json: JSON.stringify({ latitude: 13.35789016603966,
        longitude: 103.86067953898747, maps_url: 'https://maps.google.com/?q=13.35789016603966,103.86067953898747' }),
    } };
    const normalized = adapter.normalize(base);
    const facts = (normalized.raw as unknown as { listingExtraction: Record<string, unknown> }).listingExtraction;
    expect(facts).not.toHaveProperty('latitude');
    expect(facts).not.toHaveProperty('longitude');
    expect(facts).not.toHaveProperty('maps_url');
    expect(normalized.deterministicIdentifiers).not.toContainEqual(expect.objectContaining({ type: 'MAPS_URL' }));
    const valid = adapter.normalize({ ...base, listing: { ...base.listing,
      latitude: 13.352345, longitude: 103.852345,
      maps_url: 'https://maps.google.com/?q=13.352345,103.852345' } });
    const validFacts = (valid.raw as unknown as { listingExtraction: Record<string, unknown> }).listingExtraction;
    expect(validFacts).toMatchObject({ latitude: 13.352345, longitude: 103.852345,
      maps_url: 'https://maps.google.com/?q=13.352345,103.852345' });
    expect(valid.deterministicIdentifiers).toContainEqual(expect.objectContaining({ type: 'MAPS_URL' }));
  });

  it('preserves the shadow classifier outcome for raw listings rejected by enrichment', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const item = adapter.normalize({sourceId:'siem-reap',sourceName:'Khmer24',classification:'IRRELEVANT',
      listing:{title:'Shop house',raw_text:'Commercial shop house',source_url:'https://www.khmer24.com/en/shop-adid-54321',
        city:'siem_reap',photos:[]}});
    expect(item.classification).toBe('IRRELEVANT');
  });

  it('does not request discovery records until its fetcher is consumed', async () => {
    let fetched = false;
    const adapter = new FacebookLiveAdapter(async function* () {
      fetched = true;
      yield { sourceId: 'group-1', sourceName: 'Group 1',
        listing: { title: 'House', raw_text: 'For rent $400', source_url: 'https://facebook.com/groups/group-1/posts/999', city: 'siem_reap', photos: [] } };
    });
    expect(fetched).toBe(false);
    const rows = [];
    for await (const raw of adapter.fetchNewItems(context)) rows.push(adapter.normalize(raw));
    expect(fetched).toBe(true);
    expect(rows[0]?.externalId).toBe('999');
  });
});
