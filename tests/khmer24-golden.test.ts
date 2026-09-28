import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import type { AppContainer } from '../src/container';
import { findCanonicalLocation } from '../src/config/locations';
import { inferLocationFromLandmark } from '../src/config/landmarks';
import { isNonRealEstateSpam } from '../src/modules/parser/spam-detector';
import { normalizeRawToClean } from '../src/modules/parser/ingestor';
import { RawListingSchema } from '../src/modules/parser/schemas';

import houseFixtures from './fixtures/khmer24_raw_fixture_house.json';
import apartmentFixtures from './fixtures/khmer24_raw_fixture_apartment.json';
import roomFixtures from './fixtures/khmer24_raw_fixture_room.json';
import edgeFixtures from './fixtures/khmer24_raw_fixture_edge.json';
import houseSaleFixtures from './fixtures/khmer24_raw_fixture_house_sale.json';
import landSaleFixtures from './fixtures/khmer24_raw_fixture_land_sale.json';

describe('Khmer24 golden fixtures', () => {
  let container: AppContainer;

  beforeAll(() => {
    container = createContainer({ dbPath: ':memory:' });
    runMigrations(container.db);
  });

  afterAll(() => {
    container.db.close();
  });

  test('locations from JSON-LD resolve to their actual city', () => {
    // Phnom Penh listings masquerading on a Siem Reap browse page
    expect(findCanonicalLocation('Boeng Kak Pir, Tuol Kouk, Phnom Penh')?.city).toBe('phnom_penh');
    expect(findCanonicalLocation('Boeng Keng Kang Bei, Boeng Keng Kang, Phnom Penh')?.city).toBe('phnom_penh');
    expect(findCanonicalLocation('Bak Khaeng, Chrouy Changva, Phnom Penh')?.city).toBe('phnom_penh');

    // Actual Siem Reap listings
    expect(findCanonicalLocation('Svay Dangkum, Siem Reap, Siem Reap')?.city).toBe('siem_reap');
  });

  test('commercial villa is not dropped by spam detector but should be rejected by admission', async () => {
    const commercial = houseFixtures[0];
    expect(commercial?.title).toMatch(/commercial villa/i);
    expect(isNonRealEstateSpam(commercial.title, commercial.description).isSpam).toBe(false);

    const parsed = RawListingSchema.parse({ ...commercial, is_real_estate: false });
    const result = await container.ingestionService.ingestRawListing(parsed);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/non-real-estate|commercial/i);
  });

  test('good Siem Reap house is ingested active when LLM confirms it', async () => {
    const siemReapHouse = houseFixtures.find((f) => f.location.includes('Svay Dangkum'));
    expect(siemReapHouse).toBeDefined();

    const parsed = RawListingSchema.parse({
      ...siemReapHouse,
      is_real_estate: true,
      category: 'house',
      bedrooms: 3,
      bathrooms: 3,
      min_lease: 12,
      has_pool: false,
    });
    const result = await container.ingestionService.ingestRawListing(parsed);
    expect(result.status).toBe('inserted');

    const saved = container.propertiesRepo.getPropertyById(result.propertyId!);
    expect(saved).toBeDefined();
    expect(saved?.city).toBe('siem_reap');
    expect(saved?.price).toBe(60000); // $600/month in cents
    expect(saved?.bedrooms).toBe(3);
    expect(saved?.bathrooms).toBe(3);
    expect(saved?.min_lease).toBe(12);
    expect(saved?.review_status).toBe('approved');
    expect(saved?.is_active).toBe(1);
  });

  test('wrong-city listing is rejected even if it is residential rent', async () => {
    const phnomPenhHouse = houseFixtures.find((f) => f.location.includes('Chbar Ampov'));
    expect(phnomPenhHouse).toBeDefined();

    const parsed = RawListingSchema.parse({
      ...phnomPenhHouse,
      is_real_estate: true,
      category: 'house',
    });
    const result = await container.ingestionService.ingestRawListing(parsed);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/siem reap|mvp/i);
  });

  test('deterministic normalizer extracts utilities and amenities from BKK3 apartment fixture', () => {
    const bkk3 = apartmentFixtures.find((f) => f.title.includes('BKK3'));
    expect(bkk3).toBeDefined();

    const clean = normalizeRawToClean(RawListingSchema.parse(bkk3));
    expect(clean).not.toBeNull();
    expect(clean!.price).toBe(40000);
    expect(clean!.bedrooms).toBe(1);
    expect(clean!.bathrooms).toBe(1);
    expect(clean!.has_pool).toBe(true);
    expect(clean!.electricity).toMatch(/Fixed Rate \(\$0.25\/kWh\)/);
    expect(clean!.amenities).toEqual(
      expect.arrayContaining(['Swimming Pool', 'Gym']),
    );
  });

  test('room fixture in Siem Reap normalizes as a room', () => {
    const siemReapRoom = roomFixtures.find((f) => f.location.includes('Svay Dangkum'));
    expect(siemReapRoom).toBeDefined();

    const clean = normalizeRawToClean(RawListingSchema.parse(siemReapRoom));
    expect(clean).not.toBeNull();
    expect(clean!.category).toBe('room');
    expect(clean!.price).toBe(10000);
  });

  describe('edge cases', () => {
    test('land sale is rejected', async () => {
      const land = edgeFixtures.find((f) => f.title.includes('Land for sale'));
      expect(land).toBeDefined();

      const result = await container.ingestionService.ingestRawListing(RawListingSchema.parse(land));
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/siem reap|mvp|non-real-estate/i);
    });

    test('real Phnom Penh land sale is rejected even if LLM says true', async () => {
      const land = landSaleFixtures.find((f) => f.location.includes('Phnom Penh') || f.location.includes('Battambang'));
      expect(land).toBeDefined();

      const result = await container.ingestionService.ingestRawListing(
        RawListingSchema.parse({ ...land, is_real_estate: true }),
      );
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/siem reap|mvp/i);
    });

    test('house sale is rejected', async () => {
      const sale = edgeFixtures.find((f) => f.title.includes('House for sale'));
      expect(sale).toBeDefined();

      const result = await container.ingestionService.ingestRawListing(RawListingSchema.parse(sale));
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/siem reap|mvp|non-real-estate/i);
    });

    test('real Phnom Penh house sale is rejected by city filter', async () => {
      const sale = houseSaleFixtures[0];
      expect(sale).toBeDefined();

      const result = await container.ingestionService.ingestRawListing(
        RawListingSchema.parse({ ...sale, is_real_estate: true }),
      );
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/siem reap|mvp/i);
    });

    test('daily/nightly guesthouse room is rejected by spam detector', async () => {
      const daily = edgeFixtures.find((f) => f.title.includes('per night'));
      expect(daily).toBeDefined();

      const result = await container.ingestionService.ingestRawListing(RawListingSchema.parse(daily));
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/spam|daily|night/i);
    });

    test('commercial villa is not approved active', async () => {
      const commercial = edgeFixtures.find((f) => f.title.includes('Commercial villa'));
      expect(commercial).toBeDefined();

      const result = await container.ingestionService.ingestRawListing(RawListingSchema.parse(commercial));
      expect(result.status).toBe('inserted');

      const saved = container.propertiesRepo.getPropertyById(result.propertyId!);
      expect(saved?.is_active).toBe(0);
      expect(saved?.review_status).not.toBe('approved');
    });

    test('deposit_months from text is converted using known rent', () => {
      const apt = edgeFixtures.find((f) => f.title.includes('2-month deposit'));
      expect(apt).toBeDefined();

      const clean = normalizeRawToClean(RawListingSchema.parse(apt));
      expect(clean).not.toBeNull();
      expect(clean!.deposit).toBe(80000); // $400 x 2 months in cents
    });

    test('generic Siem Reap location is inferred from nearby landmark', () => {
      const room = edgeFixtures.find((f) => f.title.includes('Room for rent near Pub Street'));
      expect(room).toBeDefined();

      expect(inferLocationFromLandmark(room!.description, 'siem_reap')?.canonicalName).toBe('Sla Kram');

      const clean = normalizeRawToClean(RawListingSchema.parse(room));
      expect(clean).not.toBeNull();
      expect(clean!.location).toBe('Sla Kram');
    });
  });
});
