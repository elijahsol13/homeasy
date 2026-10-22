import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';

describe('CanonicalListingRepository', () => {
  let db: DatabaseSync;
  let repository: CanonicalListingRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE canonical_properties(id INTEGER PRIMARY KEY, latitude REAL, longitude REAL, property_type TEXT, canonical_address TEXT, explicit_location TEXT, sangkat TEXT, city TEXT);
      CREATE TABLE canonical_listings(id INTEGER PRIMARY KEY, public_ref TEXT, property_id INTEGER, status TEXT, availability_status TEXT, price INTEGER, currency TEXT, title TEXT, description TEXT, property_type TEXT, category TEXT, bedrooms INTEGER, bathrooms INTEGER, min_lease_months INTEGER, deposit_amount INTEGER, pet_friendly INTEGER, amenities TEXT, restrictions TEXT, city TEXT, sangkat TEXT, explicit_location TEXT, first_seen_at TEXT, last_seen_at TEXT, last_checked_at TEXT, primary_source_occurrence_id INTEGER, listing_facts_json TEXT, content_hash TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE canonical_listing_source_occurrences(id INTEGER PRIMARY KEY, source_item_id INTEGER, listing_id INTEGER, source_registry_id INTEGER, external_id TEXT, group_id TEXT, group_name TEXT, source_url TEXT, posted_at TEXT, first_seen_at TEXT, last_seen_at TEXT, last_checked_at TEXT, source_alive INTEGER, last_check_result TEXT, ended_at TEXT, content_changed_at TEXT, availability_signal TEXT, is_current INTEGER);
      CREATE TABLE source_items(id INTEGER PRIMARY KEY, classification TEXT, source_type TEXT, raw_text TEXT, raw_payload_json TEXT, canonical_url TEXT, source_url TEXT, published_at TEXT);
      CREATE TABLE source_registry(id INTEGER PRIMARY KEY, city TEXT);
      CREATE TABLE canonical_listing_moderation(listing_id INTEGER PRIMARY KEY, review_status TEXT, review_reason TEXT);
      CREATE TABLE source_item_identifiers(source_item_id INTEGER, type TEXT, normalized_value TEXT);
      CREATE TABLE media_assets(id INTEGER PRIMARY KEY, source_url TEXT);
      CREATE TABLE media_asset_source_occurrences(media_asset_id INTEGER, source_item_id INTEGER, source_occurrence_id INTEGER, listing_id INTEGER);
    `);
    const insertListing = db.prepare(`INSERT INTO canonical_listings
      (id,public_ref,status,availability_status,price,currency,title,description,category,bedrooms,city,sangkat,explicit_location,first_seen_at,last_seen_at,primary_source_occurrence_id,listing_facts_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertOccurrence = db.prepare(`INSERT INTO canonical_listing_source_occurrences(id,source_item_id,listing_id,source_registry_id,external_id,group_id,group_name,source_url,posted_at,last_seen_at,source_alive,availability_signal,is_current) VALUES(?,?,?,NULL,?,NULL,NULL,?,?,?,?,?,?)`);
    const insertSource = db.prepare(`INSERT INTO source_items(id,classification,source_type,raw_text,raw_payload_json,source_url) VALUES(?,?,?,?,?,?)`);
    const fixtures = [
      {id:1,status:'active',availability:'available',current:1,classification:'HOUSING_SUPPLY'},
      {id:2,status:'active',availability:'rented',current:1,classification:'HOUSING_SUPPLY'},
      {id:3,status:'inactive',availability:'unknown',current:1,classification:'HOUSING_SUPPLY'},
      {id:4,status:'active',availability:'removed',current:1,classification:'HOUSING_SUPPLY'},
      {id:5,status:'active',availability:'available',current:0,classification:'HOUSING_SUPPLY'},
      {id:6,status:'active',availability:'available',current:1,classification:'IRRELEVANT'},
    ];
    for (const row of fixtures) {
      const occurrenceId = row.id + 100;
      insertListing.run(row.id,`lst_${String(row.id).padStart(32,'0')}`,row.status,row.availability,25000,'USD',`Test apartment ${row.id}`,'A clean apartment','apartment',1,'siem_reap','Sala Kamreuk','Sala Kamreuk','2026-10-01','2026-10-07',occurrenceId,JSON.stringify({offer_type:'rent',phone_numbers:['+855 12 345 678'],discovered_amenities:['Wi-Fi']}),'2026-10-01','2026-10-07');
      insertOccurrence.run(occurrenceId,row.id,row.id,String(row.id),`https://example.test/${row.id}`,'2026-10-01','2026-10-07',1,'available',row.current);
      insertSource.run(row.id,row.classification,'KHMER24','Apartment for rent',JSON.stringify({photos:['https://img.test/a.jpg'],listingFacts:{discovered_amenities:['Wi-Fi']}}),`https://example.test/${row.id}`);
      db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'approved')").run(row.id);
    }
    db.prepare("INSERT INTO source_item_identifiers(source_item_id,type,normalized_value) VALUES(1,'PHONE','+855 12 345 678')").run();
    db.prepare('INSERT INTO media_assets(id,source_url) VALUES(1,?)').run('https://img.test/canonical.jpg');
    db.prepare('INSERT INTO media_asset_source_occurrences(media_asset_id,source_item_id,source_occurrence_id,listing_id) VALUES(1,1,101,1)').run();
    repository = new CanonicalListingRepository(db);
  });

  afterEach(() => db.close());

  it('only returns active, current supply and excludes rented, removed and irrelevant records', () => {
    const result = repository.searchProperties({city:'siem_reap',type:'rent'});
    expect(result.total).toBe(1);
    expect(result.items.map((item)=>item.id)).toEqual([1]);
  });

  it('orders Newest by publication time across rent-confidence tiers and paginates in that order', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    // An older exact rental must not outrank a newer probable rental.
    db.prepare("UPDATE canonical_listings SET availability_status='available', listing_facts_json=? WHERE id=2")
      .run(JSON.stringify({ offer_type: 'rent_or_sale' }));
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=? WHERE id=101').run(daysAgo(14));
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=? WHERE id=102').run(daysAgo(1));

    const newest = repository.searchProperties({ city: 'siem_reap', type: 'rent', sort: 'newest' });
    expect(newest.items.map((item) => item.id)).toEqual([2, 1]);
    expect(newest.items.map((item) => item.match_tier)).toEqual(['PROBABLE', 'EXACT']);
    expect(repository.searchProperties({ city: 'siem_reap', type: 'rent', sort: 'newest', limit: 1, offset: 0 })
      .items.map((item) => item.id)).toEqual([2]);
    expect(repository.searchProperties({ city: 'siem_reap', type: 'rent', sort: 'newest', limit: 1, offset: 1 })
      .items.map((item) => item.id)).toEqual([1]);
  });

  it('sorts by the displayed source publication date when the occurrence date is missing', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const newer = daysAgo(6);
    const older = daysAgo(7);
    db.prepare("UPDATE canonical_listings SET availability_status='available' WHERE id=2").run();
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=?,last_seen_at=? WHERE id=101').run(newer,daysAgo(1));
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=NULL,last_seen_at=? WHERE id=102').run(daysAgo(0));
    db.prepare('UPDATE source_items SET published_at=? WHERE id=2').run(older);

    const newest = repository.searchProperties({ city: 'siem_reap', type: 'rent', sort: 'newest' });
    expect(newest.items.map((item) => item.id)).toEqual([1, 2]);
    expect(newest.items.map((item) => item.posted_at)).toEqual([newer, older]);
  });

  it('interprets the 4+ selection as four or more bedrooms in canonical list and map', () => {
    for (const count of [3, 4, 5, 6]) {
      db.prepare('UPDATE canonical_listings SET bedrooms=? WHERE id=1').run(count);
      const result = repository.searchProperties({ city: 'siem_reap', type: 'rent', bedrooms: [4] });
      expect(result.items.map((item) => item.bedrooms)).toEqual(count >= 4 ? [count] : []);
      const mapBedrooms: Array<number | null> = [];
      repository.forEachMapProperty({ city: 'siem_reap', type: 'rent', bedrooms: [4] },
        (item) => mapBedrooms.push(item.bedrooms));
      expect(mapBedrooms).toEqual(count >= 4 ? [count] : []);
    }
  });

  it('unions 2 BR and 4+ BR, preserves exact choices and combines price, location, sort and pagination', () => {
    db.prepare('UPDATE canonical_listings SET bedrooms=5 WHERE id=1').run();
    db.prepare("UPDATE canonical_listings SET availability_status='available',bedrooms=2,price=20000 WHERE id=2").run();
    const bedroomsFor = (selection: number[]) => repository.searchProperties({
      city: 'siem_reap', type: 'rent', bedrooms: selection,
    }).items.map((item) => item.bedrooms).sort((a, b) => Number(a) - Number(b));
    expect(bedroomsFor([2, 4])).toEqual([2, 5]);
    expect(bedroomsFor([1])).toEqual([]);
    expect(bedroomsFor([2])).toEqual([2]);
    expect(bedroomsFor([3])).toEqual([]);

    const combined = repository.searchProperties({
      city: 'siem_reap', type: 'rent', category: 'apartment',
      locations: ['Sala Kamreuk'], bedrooms: [2, 4], maxPrice: 30000,
      sort: 'price_desc', limit: 1, offset: 1,
    });
    expect(combined.total).toBe(2);
    expect(combined.items.map((item) => item.bedrooms)).toEqual([2]);
    expect(repository.searchProperties({
      city: 'siem_reap', type: 'rent', locations: ['Sala Kamreuk'],
      bedrooms: [2, 4], maxPrice: 22000,
    }).items.map((item) => item.bedrooms)).toEqual([2]);
  });

  it('excludes unknown bedroom counts from every active bedroom selection in list and map', () => {
    db.prepare('UPDATE canonical_listings SET bedrooms=NULL WHERE id=1').run();
    for (const bedrooms of [[1], [4], [2, 4]]) {
      expect(repository.searchProperties({ city: 'siem_reap', type: 'rent', bedrooms }).items).toEqual([]);
      const map: number[] = [];
      expect(repository.forEachMapProperty({ city: 'siem_reap', type: 'rent', bedrooms }, (p) => map.push(p.id))).toBe(0);
      expect(map).toEqual([]);
    }
    expect(repository.searchProperties({ city: 'siem_reap', type: 'rent' }).total).toBe(1);
  });

  it('suppresses Khmer24 district-centre GPS in historical facts, property and synthesized map links', () => {
    const lat = 13.35789016603966;
    const lng = 103.86067953898747;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    db.prepare('UPDATE canonical_listings SET property_id=1, listing_facts_json=? WHERE id=1').run(
      JSON.stringify({offer_type:'rent',latitude:lat,longitude:lng,maps_urls:[mapsUrl]}));
    db.prepare('INSERT INTO canonical_properties(id,latitude,longitude) VALUES(1,?,?)').run(lat,lng);
    const assertCoarse = (card: NonNullable<ReturnType<typeof repository.getPropertyById>>) => {
      expect(card.latitude).toBeNull();
      expect(card.longitude).toBeNull();
      expect(card.maps_url).toBeNull();
      expect(card.coordinate_precision).toBe('district');
      expect(card.location).toBe('Sala Kamreuk');
    };
    assertCoarse(repository.searchProperties({city:'siem_reap',type:'rent'}).items[0]);
    assertCoarse(repository.getPropertyById(1)!);
    assertCoarse(repository.getPropertyById(1,true)!);
    const mapCards: Array<NonNullable<ReturnType<typeof repository.getPropertyById>>> = [];
    repository.forEachMapProperty({city:'siem_reap',type:'rent'}, card => mapCards.push(card));
    expect(mapCards).toHaveLength(1);
    assertCoarse(mapCards[0]);

    // Removing just listing facts must not restore the same false pin via
    // a canonical property or the historic raw source URL.
    db.prepare('UPDATE canonical_listings SET listing_facts_json=? WHERE id=1').run(
      JSON.stringify({offer_type:'rent'}));
    db.prepare('UPDATE source_items SET raw_payload_json=? WHERE id=1').run(JSON.stringify({
      listing:{maps_url:mapsUrl},photos:['https://img.test/a.jpg'],
    }));
    assertCoarse(repository.getPropertyById(1)!);
  });

  it('retains other Khmer24 property-specific GPS and does not suppress a different source at the known coordinate', () => {
    const exactUrl = 'https://www.google.com/maps/search/?api=1&query=13.352345,103.852345';
    db.prepare('UPDATE canonical_listings SET listing_facts_json=? WHERE id=1').run(JSON.stringify({
      offer_type:'rent',latitude:13.352345,longitude:103.852345,maps_urls:[exactUrl],
    }));
    expect(repository.getPropertyById(1)?.coordinate_precision).toBe('exact');
    expect(repository.getPropertyById(1)?.maps_url).toBe(exactUrl);
    expect(repository.getPropertyById(1)?.latitude).toBe(13.352345);

    db.prepare('UPDATE source_items SET source_type=? WHERE id=1').run('FACEBOOK_GROUP');
    db.prepare('UPDATE canonical_listings SET listing_facts_json=? WHERE id=1').run(JSON.stringify({
      offer_type:'rent',latitude:13.35789016603966,longitude:103.86067953898747,
    }));
    expect(repository.getPropertyById(1)?.coordinate_precision).toBe('exact');
    expect(repository.getPropertyById(1)?.latitude).toBe(13.35789016603966);
  });

  it('hides a 30-day-old original consistently in list, detail, map and metadata without losing admin access', () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=?,last_seen_at=? WHERE id=101')
      .run(hoursAgo(31 * 24), hoursAgo(1));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(0);
    expect(repository.getPropertyById(1)).toBeUndefined();
    expect(repository.getPropertyById(1,true)?.id).toBe(1);
    const visited: number[] = [];
    expect(repository.forEachMapProperty({city:'siem_reap',type:'rent'}, p => visited.push(p.id))).toBe(0);
    expect(visited).toEqual([]);
    expect(repository.getMetadata('siem_reap').categories).toEqual([]);

    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=? WHERE id=101')
      .run(hoursAgo(29 * 24));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(1);
    expect(repository.getPropertyById(1)?.id).toBe(1);
  });

  it('chooses the earliest actual publication even when a fresher copy is currently primary', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=?,last_seen_at=? WHERE id=101').run(daysAgo(50),daysAgo(1));
    db.prepare(`INSERT INTO source_items(id,classification,source_type,raw_text,raw_payload_json,published_at)
      VALUES(1001,'HOUSING_SUPPLY','FACEBOOK_GROUP','Repost','{}',?)`).run(daysAgo(1));
    db.prepare(`INSERT INTO canonical_listing_source_occurrences
      (id,source_item_id,listing_id,posted_at,first_seen_at,last_seen_at,is_current)
      VALUES(1101,1001,1,?,?,?,1)`).run(daysAgo(1),daysAgo(1),daysAgo(1));
    db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=1101 WHERE id=1').run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(0);

    // The first source's verified substantive edit may extend its own offer.
    db.prepare('UPDATE canonical_listing_source_occurrences SET content_changed_at=? WHERE id=101').run(daysAgo(2));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(1);
    db.prepare('UPDATE canonical_listing_source_occurrences SET content_changed_at=NULL WHERE id=101').run();
    db.prepare('UPDATE canonical_listing_source_occurrences SET content_changed_at=? WHERE id=1101').run(daysAgo(1));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(0);

    // A confirmed removal of the original cannot be undone by an active copy.
    db.prepare(`UPDATE canonical_listing_source_occurrences SET
      is_current=0,source_alive=0,last_check_result='REMOVED',ended_at=? WHERE id=101`).run(daysAgo(1));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(0);
    db.prepare('UPDATE canonical_listing_source_occurrences SET content_changed_at=? WHERE id=101').run(daysAgo(1));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(0);
  });

  it('uses valid fallback published_at, but does not expire an undated or invalid original', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=NULL,last_seen_at=? WHERE id=101').run(daysAgo(1));
    db.prepare('UPDATE source_items SET published_at=? WHERE id=1').run(daysAgo(31));
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(0);
    db.prepare('UPDATE source_items SET published_at=? WHERE id=1').run('not-a-date');
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(1);
    db.prepare('UPDATE source_items SET published_at=NULL WHERE id=1').run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).total).toBe(1);
  });

  function seedOverflowCandidates(): void {
    const insertListing = db.prepare(`INSERT INTO canonical_listings
      (id,public_ref,status,availability_status,price,currency,title,description,category,city,sangkat,primary_source_occurrence_id,listing_facts_json,last_seen_at)
      VALUES(?,'lst_'||lower(hex(randomblob(16))),'active','available',30000,'USD','Map candidate','For rent','apartment','siem_reap','Sala Kamreuk',?,'{"offer_type":"rent"}','2026-10-08')`);
    const insertSource = db.prepare(`INSERT INTO source_items(id,classification,source_type,raw_text,raw_payload_json)
      VALUES(?,'HOUSING_SUPPLY','KHMER24','For rent','{}')`);
    const insertOccurrence = db.prepare(`INSERT INTO canonical_listing_source_occurrences(id,source_item_id,listing_id,is_current)
      VALUES(?,?,?,1)`);
    const approve = db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'approved')");
    for (let id = 10; id < 521; id += 1) {
      insertListing.run(id, id + 1000);
      insertSource.run(id);
      insertOccurrence.run(id + 1000, id, id);
      approve.run(id);
    }
  }

  it('streams every eligible map candidate past the 500-row search cap in stable order', () => {
    seedOverflowCandidates();
    // Ordinary card search still obeys its 500-row page maximum.
    expect(repository.searchProperties({ city: 'siem_reap', type: 'rent', limit: 999 }).items).toHaveLength(500);
    const ids: number[] = [];
    const count = repository.forEachMapProperty({ city: 'siem_reap', type: 'rent' }, (property) => ids.push(property.id));
    expect(count).toBe(512);
    expect(ids).toHaveLength(512);
    expect(ids[0]).toBe(520);
    expect(ids).toContain(1);
    expect(ids).toContain(10);
  });

  it('aggregates metadata past the card cap using exact location fallbacks and public eligibility', () => {
    seedOverflowCandidates();
    // Oldest rows disappear from a 500-card search but must contribute metadata.
    db.prepare("UPDATE canonical_listings SET category='house',price=990000,explicit_location='   ',sangkat='  Wat Bo  ' WHERE id=10").run();
    db.prepare("INSERT INTO canonical_properties(id,city,canonical_address) VALUES(901,'siem_reap','  Historic Quarter  ')").run();
    db.prepare("UPDATE canonical_listings SET category='room',price=5000,property_id=901,explicit_location='  ',sangkat='  ' WHERE id=11").run();
    db.prepare("UPDATE canonical_listings SET category=NULL,price=0,explicit_location=' ',sangkat=' ' WHERE id=12").run();
    db.prepare("UPDATE canonical_listings SET category='room',price=-500 WHERE id=13").run();
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=15").run();
    db.prepare("UPDATE canonical_listing_moderation SET review_status='rejected' WHERE listing_id=16").run();
    db.prepare("UPDATE canonical_listings SET status='inactive' WHERE id=17").run();
    db.prepare("UPDATE canonical_listings SET availability_status='rented' WHERE id=18").run();
    db.prepare("UPDATE canonical_listings SET availability_status='removed' WHERE id=19").run();

    const page = repository.searchProperties({ city: 'siem_reap', type: 'rent', limit: 500 });
    expect(page.total).toBe(507);
    expect(page.items).toHaveLength(500);
    expect(page.items.map((p) => p.id)).not.toContain(10);
    expect(page.items.map((p) => p.id)).not.toContain(11);

    const meta = repository.getMetadata('siem_reap');
    expect(meta.priceRange).toEqual({ minPrice: 5000, maxPrice: 990000 });
    expect(Object.fromEntries(meta.categories.map(({category, count}) => [category, count])))
      .toEqual({ apartment: 503, house: 1, room: 2 });
    expect(Object.fromEntries(meta.locations.map(({location, count}) => [location, count])))
      .toEqual({ 'Sala Kamreuk': 504, 'Wat Bo': 1, 'Historic Quarter': 1, 'siem_reap': 1 });
  });

  it('returns zero price range and no groups when every candidate is moderated out', () => {
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending'").run();
    expect(repository.getMetadata('siem_reap')).toEqual({ locations: [], categories: [], priceRange: { minPrice: 0, maxPrice: 0 } });
  });

  it('can filter the city fallback location advertised by metadata without including listings with specific locations', () => {
    db.prepare("UPDATE canonical_listings SET explicit_location=' ',sangkat=' ',city='siem_reap' WHERE id=1").run();
    expect(repository.getMetadata('siem_reap').locations).toEqual([{ location: 'siem_reap', count: 1 }]);
    expect(repository.searchProperties({city:'siem_reap',type:'rent',locations:['siem_reap']}).items.map(p=>p.id)).toEqual([1]);

    db.prepare("UPDATE canonical_listings SET sangkat='Wat Bo' WHERE id=1").run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent',locations:['siem_reap']}).total).toBe(0);
    expect(repository.searchProperties({city:'siem_reap',type:'rent',locations:['Wat Bo']}).items.map(p=>p.id)).toEqual([1]);

    db.prepare("INSERT INTO canonical_properties(id,city) VALUES(901,'siem_reap')").run();
    db.prepare("UPDATE canonical_listings SET city=NULL,property_id=901,sangkat=NULL WHERE id=1").run();
    expect(repository.getMetadata('siem_reap').locations).toEqual([{ location: 'siem_reap', count: 1 }]);
    expect(repository.searchProperties({city:'siem_reap',type:'rent',locations:['siem_reap']}).items.map(p=>p.id)).toEqual([1]);
  });

  it('T10: location filters match only the advertised primary location and support map cluster aliases', () => {
    // A secondary sangkat mentioning Sala Kamreuk must not inflate its bucket.
    db.prepare(`INSERT INTO canonical_properties(id,city,sangkat) VALUES(902,'siem_reap','Sala Kamreuk')`).run();
    db.prepare("UPDATE canonical_listings SET property_id=902,explicit_location='Wat Bo',sangkat='Sala Kamreuk' WHERE id=1").run();
    expect(repository.getMetadata('siem_reap').locations).toEqual([{ location: 'Wat Bo', count: 1 }]);
    expect(repository.searchProperties({ city:'siem_reap',type:'rent',locations:['Sala Kamreuk'] }).total).toBe(0);
    expect(repository.searchProperties({ city:'siem_reap',type:'rent',locations:['Wat Bo'] }).total).toBe(1);
    expect(repository.searchProperties({ city:'siem_reap',type:'rent',locations:['Wat Bo','Sla Kram'] }).total).toBe(1);
  });

  it('T20: rejects a reversed price interval even when the listing price is unknown', () => {
    db.prepare('UPDATE canonical_listings SET price=NULL WHERE id=1').run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent',minPrice:80000,maxPrice:25000}).total).toBe(0);
    expect(repository.searchProperties({city:'siem_reap',type:'rent',maxPrice:25000}).total).toBe(1);
  });

  it('keeps pending or rejected moderation state out of public list and detail', () => {
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=1").run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).items.map((p)=>p.id)).not.toContain(1);
    expect(repository.getPropertyById(1)).toBeUndefined();
  });

  it('projects canonical facts and media into the legacy Property contract', () => {
    const property = repository.getPropertyById(1);
    expect(property).toMatchObject({
      id:1, price:25000, location:'Sala Kamreuk', bedrooms:1,
      direct_contact:{phone:'+855 12 345 678'},
      photos:['https://img.test/canonical.jpg'],
      amenities:['Wi-Fi'],
    });
    expect(repository.searchProperties({city:'siem_reap'}).items[0]?.photos).toEqual(['https://img.test/canonical.jpg']);
  });

  it('falls back to raw photo URLs when canonical media is absent', () => {
    db.prepare('DELETE FROM media_asset_source_occurrences WHERE listing_id=1').run();
    expect(repository.getPropertyById(1)?.photos).toEqual(['https://img.test/a.jpg']);
    expect(repository.searchProperties({city:'siem_reap'}).items[0]?.photos).toEqual(['https://img.test/a.jpg']);
  });

  it('uses source city only as a hint and excludes explicit out-of-area geography', () => {
    db.prepare('INSERT INTO source_registry(id,city) VALUES(1,\'siem_reap\')').run();
    const add = (id:number, explicit:string|null, rawText:string) => {
      db.prepare(`INSERT INTO canonical_listings (id,public_ref,status,availability_status,price,currency,title,description,category,bedrooms,city,explicit_location,primary_source_occurrence_id,listing_facts_json,created_at,updated_at)
        VALUES(?,'lst_'||lower(hex(randomblob(16))),'active','available',25000,'USD',?,'','apartment',1,NULL,?, ?, ?, '2026-10-01','2026-10-07')`)
        .run(id,`fixture ${id}`,explicit,id+1000,JSON.stringify({offer_type:'rent'}));
      db.prepare(`INSERT INTO canonical_listing_source_occurrences(id,source_item_id,listing_id,source_registry_id,external_id,source_url,is_current)
        VALUES(?,?,?,1,?,?,1)`).run(id+1000,id,id,String(id),`https://example.test/${id}`);
      db.prepare(`INSERT INTO source_items(id,classification,source_type,raw_text,raw_payload_json,source_url) VALUES(?,'HOUSING_SUPPLY','KHMER24',?,'{}',?)`)
        .run(id,rawText,`https://example.test/${id}`);
      db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'approved')").run(id);
    };
    add(20,'Phnom Penh','Apartment for rent');
    add(21,'Kandal','Apartment for rent');
    add(22,null,'Apartment for rent');
    add(23,'Sala Kamreuk, Siem Reap','Apartment for rent');
    add(24,null,'🏡 ដីលក់នៅតាកែវ បន្ទាន់ តម្លៃល្អ សម្រាប់ទិញទុក');
    add(25,'Siem Reap city center','Apartment for rent នៅកណ្ដាលក្រុងសៀមរាប');
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).items.map((p)=>p.id).sort((a,b)=>a-b)).toEqual([1,22,23,25]);
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).items.find((p)=>p.id===22)?.city_tier).toBe('PROBABLE_CITY');
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).items.find((p)=>p.id===22)?.city_evidence).toBe('SOURCE_PRIOR_ONLY');
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).items.find((p)=>p.id===23)?.city_evidence).toBe('LOCAL_EVIDENCE');
  });

  it('keeps unknown prices under price filters while excluding unknown bedrooms with a bedroom filter', () => {
    db.prepare(`UPDATE canonical_listings SET price=0, bedrooms=NULL WHERE id=1`).run();
    const budget=repository.searchProperties({city:'siem_reap',type:'rent',maxPrice:30000});
    expect(budget.items).toHaveLength(1);
    expect(budget.items[0]).toMatchObject({price:0,match_tier:'PROBABLE'});
    expect(repository.searchProperties({city:'siem_reap',type:'rent',bedrooms:[1]}).items).toHaveLength(0);
  });

  it('includes unknown minimum lease and excludes terms longer than the requested maximum', () => {
    // The base fixture has no minimum lease; an unknown term must remain discoverable.
    expect(repository.searchProperties({city:'siem_reap',type:'rent',minLeaseMax:12}).items.map((p)=>p.id)).toEqual([1]);
    db.prepare('UPDATE canonical_listings SET min_lease_months=18 WHERE id=1').run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent',minLeaseMax:12}).items).toHaveLength(0);
    db.prepare('UPDATE canonical_listings SET min_lease_months=6 WHERE id=1').run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent',minLeaseMax:12}).items.map((p)=>p.id)).toEqual([1]);
  });

  it('sorts canonical prices globally across confidence tiers and puts unknown prices last', () => {
    db.prepare('INSERT INTO source_registry(id,city) VALUES(1,\'siem_reap\')').run();
    db.prepare('UPDATE canonical_listings SET price=20000 WHERE id=1').run();

    const add = (id: number, price: number | null, offerType = 'rent', postedAt = '2026-10-06') => {
      db.prepare(`INSERT INTO canonical_listings
        (id,public_ref,status,availability_status,price,currency,title,description,category,bedrooms,city,explicit_location,primary_source_occurrence_id,listing_facts_json,created_at,updated_at)
        VALUES(?,'lst_'||lower(hex(randomblob(16))),'active','available',?,'USD',?,'','apartment',1,NULL,NULL,?,?,'2026-10-01','2026-10-07')`)
        .run(id,price,`Fixture apartment ${id}`,id+1000,JSON.stringify({offer_type:offerType}));
      db.prepare(`INSERT INTO canonical_listing_source_occurrences
        (id,source_item_id,listing_id,source_registry_id,external_id,source_url,posted_at,last_seen_at,is_current)
        VALUES(?,?,?,1,?,?,?,'2026-10-07',1)`)
        .run(id+1000,id,id,String(id),`https://example.test/${id}`,postedAt);
      db.prepare(`INSERT INTO source_items(id,classification,source_type,raw_text,raw_payload_json,source_url)
        VALUES(?,'HOUSING_SUPPLY','KHMER24','Apartment for rent','{}',?)`)
        .run(id,`https://example.test/${id}`);
      db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'approved')").run(id);
    };

    add(10,9000,'rent_or_sale','2026-10-08');
    add(11,null);
    add(12,10000);
    add(13,0);
    add(14,-100);
    add(15,10000);

    expect(repository.searchProperties({city:'siem_reap',type:'rent',sort:'price_asc'}).items.map((p)=>p.id))
      .toEqual([10,15,12,1,11,14,13]);
    expect(repository.searchProperties({city:'siem_reap',type:'rent',sort:'price_desc'}).items.map((p)=>p.id))
      .toEqual([1,15,12,10,13,14,11]);
    const newest=repository.searchProperties({city:'siem_reap',type:'rent'}).items;
    expect(newest[0].id).toBe(10);
    expect(newest.find((p)=>p.id===10)).toMatchObject({match_tier:'PROBABLE',city_tier:'PROBABLE_CITY'});
    expect(newest.findIndex((p)=>p.id===15)).toBeGreaterThan(newest.findIndex((p)=>p.id===10));
    expect(repository.searchProperties({city:'siem_reap',type:'rent',sort:'price_asc'}).items[0].id)
      .toBe(10);
    const paginated=repository.searchProperties({city:'siem_reap',type:'rent',sort:'price_asc',limit:2,offset:2});
    expect(paginated).toMatchObject({total:7});
    expect(paginated.items.map(p=>p.id)).toEqual([12,1]);
    expect(repository.lastDiagnostics.queryCount).toBe(1);
    const pastEnd=repository.searchProperties({city:'siem_reap',type:'rent',sort:'price_asc',limit:2,offset:100});
    expect(pastEnd).toMatchObject({total:7,items:[]});
    expect(repository.lastDiagnostics.queryCount).toBe(2);
  });

  it('includes unknown offer type as a tiered candidate while excluding sale-only evidence', () => {
    db.prepare("UPDATE canonical_listings SET listing_facts_json='{}' WHERE id=1").run();
    const result=repository.searchProperties({city:'siem_reap',type:'rent'});
    expect(result.items.map((p)=>p.id)).toContain(1);
    expect(result.items.find((p)=>p.id===1)?.match_tier).toBe('PROBABLE');
    expect(repository.getPropertyById(1)).toBeDefined();
    db.prepare("UPDATE source_items SET raw_text='House for sale. Pay $500/month for 12 months' WHERE id=1").run();
    expect(repository.searchProperties({city:'siem_reap',type:'rent'}).items.map((p)=>p.id)).not.toContain(1);
  });
});
