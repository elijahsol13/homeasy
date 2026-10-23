import { createDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { FiltersRepository, MAX_USER_FILTERS } from '../src/database/repositories/filters.repo';
import { PropertiesRepository } from '../src/database/repositories/properties.repo';
import { UsersRepository } from '../src/database/repositories/users.repo';
import { NLSearchService } from '../src/services/nl-search.service';
import { createContainer } from '../src/container';
import { env } from '../src/config/env';
import { propertyMatchesFilter } from '../src/modules/matcher/matcher';
import { extractDraftFromCriteriaText, renderCriteriaMessage, searchNLListings } from '../src/modules/bot/handlers/nl-search.handler';
import type { FilterDraft } from '../src/modules/bot/session';
import fs from 'fs';
import path from 'path';

describe('Natural Language Search & Guardrails Engine', () => {
  let db: any;
  let filtersRepo: FiltersRepository;
  let propertiesRepo: PropertiesRepository;
  let usersRepo: UsersRepository;
  const testDbPath = ':memory:';

  beforeAll(() => {
    db = createDatabase(testDbPath);
    runMigrations(db);
    filtersRepo = new FiltersRepository(db);
    propertiesRepo = new PropertiesRepository(db);
    usersRepo = new UsersRepository(db);
  });

  describe('User Filter Cap Enforcement (MAX_USER_FILTERS = 5)', () => {
    it('allows creating up to 5 active filters per user and strictly rejects the 6th', () => {
      const user = usersRepo.upsertUser(999888, 'nl_tester');
      const testUserId = user.id;

      // Clean existing
      filtersRepo.deactivateAllUserFilters(testUserId);
      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(0);

      // Create 5 active filters
      for (let i = 1; i <= MAX_USER_FILTERS; i++) {
        const filter = filtersRepo.createFilter({
          user_id: testUserId,
          type: 'rent',
          category: 'apartment',
          city: 'siem_reap',
          min_price: 20000,
          max_price: 50000 + i * 5000,
          bedrooms: [1],
          requires_pool: false,
          min_lease_preferred: 6,
          locations: ['Wat Bo'],
        });
        expect(filter.id).toBeGreaterThan(0);
      }

      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(MAX_USER_FILTERS);

      // 6th filter must throw error
      expect(() => {
        filtersRepo.createFilter({
          user_id: testUserId,
          type: 'rent',
          category: 'apartment',
          city: 'siem_reap',
          min_price: 30000,
          max_price: 60000,
          bedrooms: [2],
          requires_pool: true,
          min_lease_preferred: 12,
          locations: ['Sala Kamreuk'],
        });
      }).toThrow(/Filter limit reached/);

      // Deactivate one filter, now count should be 4 and we can create another
      const activeFilters = filtersRepo.getUserActiveFilters(testUserId);
      expect(activeFilters.length).toBe(5);
      filtersRepo.deactivateFilter(activeFilters[0]!.id, testUserId);
      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(4);

      const newFilter = filtersRepo.createFilter({
        user_id: testUserId,
        type: 'rent',
        category: 'house',
        city: 'siem_reap',
        min_price: 40000,
        max_price: 80000,
        bedrooms: [3],
        requires_pool: true,
        min_lease_preferred: null,
        locations: [],
      });
      expect(newFilter.id).toBeGreaterThan(0);
      expect(filtersRepo.countUserActiveFilters(testUserId)).toBe(5);
    });
  });

  describe('Map Bounding Box with Overscan Buffer', () => {
    it('filters map markers within coordinates bounding box plus 20% overscan', () => {
      // Insert property in Siem Reap center (~13.36, 103.86)
      const propInBounds = propertiesRepo.insertProperty({
        hash: 'test_hash_sr_center',
        title: 'Centrally Located Studio',
        description: 'Near Pub Street',
        price: 30000,
        currency: 'USD',
        type: 'rent',
        category: 'apartment',
        bedrooms: 1,
        bathrooms: 1,
        deposit: 30000,
        min_lease: 6,
        has_pool: false,
        city: 'siem_reap',
        location: 'Svay Dangkum',
        maps_url: null,
        source_url: null,
        photos: [],
        direct_contact: {},
        latitude: 13.355,
        longitude: 103.855,
        original_url: 'https://example.com/p1',
      });

      // Insert property in Phnom Penh (~11.55, 104.92)
      propertiesRepo.insertProperty({
        hash: 'test_hash_pp_center',
        title: 'Phnom Penh Condo',
        description: 'BKK1 luxury condo',
        price: 80000,
        currency: 'USD',
        type: 'rent',
        category: 'apartment',
        bedrooms: 2,
        bathrooms: 2,
        deposit: 80000,
        min_lease: 12,
        has_pool: true,
        city: 'phnom_penh',
        location: 'BKK1',
        maps_url: null,
        source_url: null,
        photos: [],
        direct_contact: {},
        latitude: 11.552,
        longitude: 104.928,
        original_url: 'https://example.com/p2',
      });

      // Query map markers with Siem Reap bounds
      const markers = propertiesRepo.getPropertiesForMap('siem_reap', {
        bounds: {
          minLat: 13.34,
          maxLat: 13.37,
          minLng: 103.84,
          maxLng: 103.87,
          paddingRatio: 0.2,
        },
      });

      expect(markers.length).toBeGreaterThanOrEqual(1);
      const ids = markers.map((m) => m.id);
      expect(ids).toContain(propInBounds.id);
    });
  });

  describe('NLSearchService Fallback and Query Handling', () => {
    it('returns structured rejection for empty input or unconfigured API key gracefully', async () => {
      const service = new NLSearchService(propertiesRepo);
      const emptyRes = await service.parseQuery({});
      expect(emptyRes.is_real_estate_query).toBe(false);
      expect(emptyRes.rejection_reason).toBeDefined();
    });
  });

  describe('extractDraftFromCriteriaText (Session Recovery)', () => {
    // Import helper dynamically or from nl-search.handler
    const { extractDraftFromCriteriaText } = require('../src/modules/bot/handlers/nl-search.handler');

    it('correctly recovers filter draft from rendered telegram message text', () => {
      const messageText = `
🎯 <b>Search Criteria Understood:</b>

• <b>City:</b> 🌴 Siem Reap
• <b>Type:</b> 🏠 For Rent (apartment)
• <b>Budget:</b> Up to $25,000
• <b>Bedrooms:</b> 1 BR
• <b>District:</b> 📍 Wat Bo

📦 <i>Available in database right now: <b>13</b> matching listing(s)</i>
`.trim();

      const draft = extractDraftFromCriteriaText(messageText);
      expect(draft).not.toBeNull();
      expect(draft?.city).toBe('siem_reap');
      expect(draft?.type).toBe('rent');
      expect(draft?.category).toBe('apartment');
      expect(draft?.max_price).toBe(25000);
      expect(draft?.bedrooms).toEqual([1]);
      expect(draft?.locations).toEqual(['Wat Bo']);
    });

    it('does not recover a historical Phnom Penh sale card while AI search is Siem Reap rentals only', () => {
      const messageText = `
🎯 <b>Search Criteria Understood:</b>

• <b>City:</b> 🏙 Phnom Penh
• <b>Type:</b> 🏷 For Sale (condo)
• <b>Budget:</b> $50,000 – $120,000
• <b>Bedrooms:</b> Studio, 2 BR
• <b>District:</b> 📍 BKK1
• <b>Swimming Pool:</b> 🏊 Required
`.trim();

      const draft = extractDraftFromCriteriaText(messageText);
      expect(draft).toBeNull();
    });

    it('returns null for unrelated text messages', () => {
      expect(extractDraftFromCriteriaText('Hello there!')).toBeNull();
      expect(extractDraftFromCriteriaText('')).toBeNull();
    });
  });
});

describe('Wat Bo text/voice search: count, pages, card and saved alert', () => {
  const telegramId = 990055;
  const criteria = {
    is_real_estate_query: true,
    summary_en: 'Room for rent in Wat Bo under $200',
    city: 'siem_reap' as const,
    type: 'rent' as const,
    category: 'room' as const,
    location: 'Wat Bo',
    max_price: 200,
  };
  const draft: FilterDraft = {
    city: 'siem_reap', type: 'rent', category: 'room',
    max_price: 200, locations: ['Wat Bo'],
  };
  const fixtures = [
    { slug: 'a', location: 'Sala Kamreuk', price: 15000, category: 'room' },
    { slug: 'b', location: 'Wat Bo', price: 17500, category: 'room' },
    { slug: 'c', location: 'Sala Kamroek', price: 19900, category: 'room' },
    { slug: 'd', location: 'Sangkat Sala Kamreuk', price: 20000, category: 'room' },
    { slug: 'expensive', location: 'Sala Kamreuk', price: 25000, category: 'room' },
    { slug: 'elsewhere', location: 'Sla Kram', price: 12000, category: 'room' },
    { slug: 'apartment', location: 'Wat Bo', price: 11000, category: 'apartment' },
  ] as const;

  it('shows $200/month and recovers both new cards and historical cents-based cards', () => {
    const card = renderCriteriaMessage(criteria, 4);
    expect(card.text).toContain('Up to $200 (USD/month)');
    expect(card.text).toContain('Wat Bo (searching Sala Kamreuk area)');
    expect(card.text).toContain('4</b> matching listing(s)');
    expect(extractDraftFromCriteriaText(card.text)).toMatchObject(draft);

    const historical = card.text
      .replace('Up to $200 (USD/month)', 'Up to $20,000')
      .replace('Wat Bo (searching Sala Kamreuk area)', 'Wat Bo');
    expect(extractDraftFromCriteriaText(historical)?.max_price).toBe(200);
    expect(extractDraftFromCriteriaText(historical)?.locations).toEqual(['Wat Bo']);
  });

  it.each(['legacy', 'canonical'] as const)('%s: same four matches for card estimate, first page, next page and alert', (path) => {
    const previous = env.LISTING_READ_PATH;
    const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
    const container = createContainer({ dbPath: ':memory:' });
    try {
      runMigrations(container.db);
      env.LISTING_READ_PATH = path;
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
      const now = new Date().toISOString();
      const registryId = path === 'canonical' ? container.sourceIngestionRepo.upsertSource({
        sourceType: 'KHMER24', externalSourceId: 'wat-bo-test', name: 'Wat Bo test',
      }) : 0;
      for (const fixture of fixtures) {
        if (path === 'legacy') {
          container.db.prepare(`INSERT INTO properties
            (hash,title,price,currency,type,category,location,city,original_url,review_status,is_active)
            VALUES (?,?,?,'USD','rent',?,?,'siem_reap',?,'approved',1)`)
            .run(`wat-bo-${fixture.slug}`, fixture.slug, fixture.price, fixture.category,
              fixture.location, `https://example.test/legacy/${fixture.slug}`);
        } else {
          const itemId = container.sourceIngestionRepo.upsertSourceItemDetailed(registryId, {
            sourceType: 'KHMER24', externalId: fixture.slug,
            sourceUrl: `https://example.test/canonical/${fixture.slug}`,
            rawText: `Room for rent in ${fixture.location}`,
            contentHash: `wat-bo-${fixture.slug}`,
            classification: 'HOUSING_SUPPLY',
            rawPayload: { listingFacts: { offer_type: 'rent', city: 'siem_reap', sangkat: fixture.location } },
          }, now).id;
          const listingId = Number(container.db.prepare(`INSERT INTO canonical_listings
            (public_ref,title,description,status,availability_status,price,currency,category,city,sangkat,first_seen_at,last_seen_at,listing_facts_json)
            VALUES ('lst_'||lower(hex(randomblob(16))),?,'For rent','active','available',?,'USD',?,'siem_reap',?,?,?,?)`)
            .run(fixture.slug, fixture.price, fixture.category, fixture.location, now, now,
              JSON.stringify({ offer_type: 'rent' })).lastInsertRowid);
          const occurrenceId = Number(container.db.prepare(`INSERT INTO canonical_listing_source_occurrences
            (source_item_id,listing_id,source_registry_id,source_url,first_seen_at,last_seen_at)
            VALUES (?,?,?,?,?,?)`)
            .run(itemId, listingId, registryId, `https://example.test/canonical/${fixture.slug}`, now, now).lastInsertRowid);
          container.db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=? WHERE id=?').run(occurrenceId, listingId);
          container.db.prepare(`INSERT INTO canonical_listing_moderation(listing_id,review_status)
            VALUES (?,'approved')`).run(listingId);
        }
      }

      const estimate = searchNLListings(container, telegramId, draft, 1);
      const pageOne = searchNLListings(container, telegramId, draft, 3);
      const pageTwo = searchNLListings(container, telegramId, draft, 3, 3);
      expect(estimate.total).toBe(4);
      expect(pageOne.total).toBe(4);
      expect(pageOne.items).toHaveLength(3);
      expect(pageTwo.total).toBe(4);
      expect(pageTwo.items).toHaveLength(1);
      expect(new Set([...pageOne.items, ...pageTwo.items].map((p) => p.id)).size).toBe(4);
      expect([...pageOne.items, ...pageTwo.items].every((p) => p.price <= 20000 && p.category === 'room')).toBe(true);

      const user = container.usersRepo.upsertUser(telegramId, 'wat_bo_test');
      const savedAlert = container.filtersRepo.createFilter({
        user_id: user.id, type: 'rent', category: 'room', city: 'siem_reap',
        min_price: null, max_price: draft.max_price!, bedrooms: null, requires_pool: false,
        min_lease_preferred: null, locations: draft.locations!,
      });
      expect(savedAlert.max_price).toBe(200);
      expect(savedAlert.locations).toEqual(['Wat Bo']);
      const wider = searchNLListings(container, telegramId, { ...draft, max_price: 300 }, 20);
      const expensive = wider.items.find((p) => p.price === 25000);
      expect(expensive).toBeDefined();
      expect(propertyMatchesFilter(expensive!, savedAlert)).toBe(false);
      for (const property of [...pageOne.items, ...pageTwo.items]) {
        expect(propertyMatchesFilter(property, savedAlert)).toBe(true);
      }
    } finally {
      env.LISTING_READ_PATH = previous;
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
      container.db.close();
    }
  });
});
