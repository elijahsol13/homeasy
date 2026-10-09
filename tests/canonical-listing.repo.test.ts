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
      CREATE TABLE canonical_listing_source_occurrences(id INTEGER PRIMARY KEY, source_item_id INTEGER, listing_id INTEGER, source_registry_id INTEGER, external_id TEXT, group_id TEXT, group_name TEXT, source_url TEXT, posted_at TEXT, last_seen_at TEXT, last_checked_at TEXT, source_alive INTEGER, availability_signal TEXT, is_current INTEGER);
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
      photos:['https://img.test/canonical.jpg','https://img.test/a.jpg'],
      amenities:['Wi-Fi'],
    });
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

  it('keeps unknown price and bedrooms as lower-confidence matches under filters', () => {
    db.prepare(`UPDATE canonical_listings SET price=0, bedrooms=NULL WHERE id=1`).run();
    const budget=repository.searchProperties({city:'siem_reap',type:'rent',maxPrice:30000});
    expect(budget.items).toHaveLength(1);
    expect(budget.items[0]).toMatchObject({price:0,match_tier:'PROBABLE'});
    expect(repository.searchProperties({city:'siem_reap',type:'rent',bedrooms:[1]}).items).toHaveLength(1);
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
