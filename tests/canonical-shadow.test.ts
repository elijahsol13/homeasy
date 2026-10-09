import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { IngestionService } from '../src/modules/parser/ingestor';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';
import { RepostClusteringService } from '../src/modules/parser/repost-clustering';
import { LegacyKhmer24BackfillAdapter } from '../src/modules/parser/legacy-khmer24-backfill-adapter';
import { assertLegacyPropertiesUnchanged, snapshotLegacyProperties, type LegacyPropertiesSnapshot } from '../src/database/legacy-write-guard';

const HASH_A = '0'.repeat(64);
const HASH_B = '1'.repeat(64);

describe('Phase 4 shadow ingestion and canonicalization', () => {
  let db: DatabaseSync;
  let legacyBaseline: LegacyPropertiesSnapshot;

  beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); legacyBaseline = snapshotLegacyProperties(db); });
  afterEach(() => { assertLegacyPropertiesUnchanged(db, legacyBaseline); db.close(); });

  it('imports stable Khmer24 ad IDs through ingestBatch and is idempotent', async () => {
    db.exec(`INSERT INTO properties (hash,title,description,price,currency,type,city,location,category,property_type,source_url,original_url,raw_text,photos,image_phashes,direct_contact,posted_at,created_at,updated_at)
      VALUES ('legacy-test-1','Villa rent','Description',125000,'USD','rent','siem_reap','Sala Kamreuk','house','Private Villa',
        'https://www.khmer24.com/en/villa-adid-10001','https://www.khmer24.com/en/villa-adid-10001',
        'Rental Price: USD 1,250/month. Phone: 012 345 678. Property ID: DV018',
        '["https://images.khmer24.com/listing/1.jpg"]','["0000000000000000000000000000000000000000000000000000000000000000"]',
        '{"phone":"012 345 678","telegram":"@seller01"}','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z'),
      ('legacy-test-2','Duplicate parsed row','Alternate description',125000,'USD','rent','siem_reap','Sala Kamreuk','house','Private Villa',
        'https://www.khmer24.com/en/villa-adid-10001','https://www.khmer24.com/en/villa-adid-10001',
        'Rental Price: USD 1,250/month. Property ID: DV018',
        '["https://images.khmer24.com/listing/2.jpg"]','["1111111111111111111111111111111111111111111111111111111111111111"]',
        '{"email":"seller@example.com"}','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-03T00:00:00Z'),
      ('legacy-test-3','Legacy Facebook row','',1000,'USD','rent','siem_reap','Wat Bo','apartment','Apartment',
        'https://www.facebook.com/groups/123/posts/456','https://www.facebook.com/groups/123/posts/456','Example', '[]','[]','{}',NULL,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z'),
      ('legacy-test-4','No stable portal ID','',1000,'USD','rent','siem_reap','Wat Bo','apartment','Apartment',
        'https://www.khmer24.com/en/no-ad-id','https://www.khmer24.com/en/no-ad-id','Example', '[]','[]','{}',NULL,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`);
    legacyBaseline = snapshotLegacyProperties(db);
    const repo = new SourceIngestionRepository(db);
    const ingestion = new IngestionService({} as never, {} as never, undefined, repo);
    const adapter = new LegacyKhmer24BackfillAdapter(db);
    const first = await ingestion.ingestBatch(adapter, { runType: 'MANUAL_IMPORT', ingestionMethod: 'MANUAL' });
    const item = db.prepare("SELECT raw_text,raw_payload_json FROM source_items WHERE source_type='KHMER24'").get() as { raw_text: string; raw_payload_json: string };
    const payload = JSON.parse(item.raw_payload_json) as { listingFacts: { price: number }; photos: string[]; legacyDuplicateRows: unknown[] };
    expect(first.inputItems).toBe(1);
    expect(first.newSourceItems).toBe(1);
    expect(payload.listingFacts.price).toBe(1250); // legacy value is USD cents
    expect(payload.photos).toHaveLength(2);
    expect(payload.legacyDuplicateRows).toHaveLength(2);
    expect(item.raw_text).toContain('seller@example.com');
    const second = await ingestion.ingestBatch(adapter, { runType: 'MANUAL_IMPORT', ingestionMethod: 'MANUAL' });
    expect(second.newSourceItems).toBe(0);
    expect(second.newVersions).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_items WHERE source_type='KHMER24'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_item_identifiers i JOIN source_items s ON s.id=i.source_item_id WHERE s.source_type='KHMER24'").get()).toEqual({ n: 4 });
  });

  it('keeps active agent inventory as separate offers and records a pHash-supported same-property decision', () => {
    const repo = new SourceIngestionRepository(db);
    const facebookSource = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'fb-test', name: 'FB test' });
    const khmerSource = repo.upsertSource({ sourceType: 'KHMER24', externalSourceId: 'k24-test', name: 'Khmer24 test' });
    const fb = repo.upsertSourceItemDetailed(facebookSource, {
      sourceType: 'FACEBOOK_GROUP', externalId: 'post-1', rawText: 'Two bedroom apartment Wat Bo rent $350 monthly furnished',
      contentHash: 'fb-hash', classification: 'HOUSING_SUPPLY', sourceUrl: 'https://facebook.com/groups/test/posts/1',
      rawPayload: { listingExtraction: { title_en: '2BR apartment', description_en: 'Furnished unit', price: 350, currency: 'USD',
        category: 'apartment', property_type: 'Apartment', bedrooms: 2, bathrooms: 1, city: 'Siem Reap', sangkat: 'Wat Bo',
        offer_type: 'rent' }, photos: ['https://fb.example/one.jpg','https://fb.example/two.jpg'], imagePhashes: [HASH_A,HASH_B] },
    }).id;
    const k24 = repo.upsertSourceItemDetailed(khmerSource, {
      sourceType: 'KHMER24', externalId: 'adid:2', rawText: 'Two bedroom apartment Wat Bo rent $500 monthly furnished',
      contentHash: 'k24-hash', classification: 'HOUSING_SUPPLY', sourceUrl: 'https://khmer24.example/adid-2',
      rawPayload: { listingFacts: { title_en: '2BR apartment', description_en: 'Furnished unit', price: 500, currency: 'USD',
        category: 'apartment', property_type: 'Apartment', bedrooms: 2, bathrooms: 1, city: 'siem_reap', sangkat: 'Wat Bo',
        offer_type: 'rent' }, photos: ['https://k24.example/one.jpg','https://k24.example/two.jpg'], imagePhashes: [HASH_A,HASH_B] },
    }).id;
    db.prepare(`INSERT INTO dedupe_clusters(entity_type,algorithm_version,cluster_key,confidence,representative_source_item_id)
      VALUES('SUPPLY_REPOST','repost-v1','fb-cluster-key',1,?)`).run(fb);
    const clusterId = Number((db.prepare("SELECT id FROM dedupe_clusters WHERE cluster_key='fb-cluster-key'").get() as { id: number }).id);
    db.prepare('INSERT INTO dedupe_cluster_members(cluster_id,source_item_id,score,reason,details_json) VALUES(?,?,?,?,?)')
      .run(clusterId, fb, 1, 'representative', '{}');
    const service = new CanonicalShadowService(db);
    const preview = service.run({ dryRun: true });
    expect(preview.pairsActuallyScored).toBe(1);
    expect(preview.pHashComparisons).toBe(4);
    expect(preview.pHashMatches).toBe(2);
    expect(preview.decisionCounts.SAME_PROPERTY_DIFFERENT_LISTING).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_properties').get()).toEqual({ n: 0 });

    const committed = service.run({ dryRun: false });
    expect(committed.canonicalProperties).toBe(1);
    expect(committed.canonicalListings).toBe(2);
    expect(committed.sourceOccurrences).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dedupe_decisions').get()).toEqual({ n: 1 });
    expect((db.prepare('SELECT details_json FROM dedupe_decisions').get() as { details_json: string }).details_json).toContain('MEDIA');
    const stableRows = db.prepare(`SELECT id,canonical_key FROM canonical_properties UNION ALL SELECT id,canonical_key FROM canonical_listings ORDER BY canonical_key`).all();
    service.run({ dryRun: false });
    expect(db.prepare(`SELECT id,canonical_key FROM canonical_properties UNION ALL SELECT id,canonical_key FROM canonical_listings ORDER BY canonical_key`).all()).toEqual(stableRows);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listing_source_occurrences').get()).toEqual({ n: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    expect(db.prepare('SELECT id FROM canonical_listings WHERE price=35000').get()).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_item_versions WHERE source_item_id IN (?,?)').get(fb,k24)).toEqual({ n: 2 });
  });

  it('does not inherit legacy approval when the numeric alias belongs to another canonical listing', () => {
    db.exec(`INSERT INTO properties(hash,title,description,price,currency,type,city,location,category,property_type,source_url,original_url,raw_text,photos,image_phashes,direct_contact,posted_at,created_at,updated_at,review_status)
      VALUES('legacy-a','Legacy A','For rent',30000,'USD','rent','siem_reap','Wat Bo','apartment','Apartment','https://example.com/legacy-a','https://example.com/legacy-a','For rent in Wat Bo $300/month','[]','[]','{}',NULL,'2026-10-01','2026-10-01','approved'),
        ('legacy-b','Legacy B','For rent',70000,'USD','rent','siem_reap','Sala Kamreuk','house','Villa','https://example.com/legacy-b','https://example.com/legacy-b','For rent in Sala Kamreuk $700/month','[]','[]','{}',NULL,'2026-10-01','2026-10-01','approved')`);
    legacyBaseline = snapshotLegacyProperties(db);
    const repo = new SourceIngestionRepository(db);
    const source = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'alias-collision', name: 'Alias collision' });
    const facts = (title: string, price: number, sangkat: string, propertyCode: string) => ({ title_en: title, description_en: 'For rent', price, currency: 'USD', category: 'apartment', property_type: 'Apartment', bedrooms: 2, city: 'siem_reap', sangkat, property_code: propertyCode, offer_type: 'rent' });
    const first = repo.upsertSourceItemDetailed(source, { sourceType: 'FACEBOOK_GROUP', externalId: 'legacy-a-post', sourceUrl: 'https://example.com/legacy-a', rawText: 'For rent in Wat Bo $300/month', contentHash: 'alias-a', classification: 'HOUSING_SUPPLY', rawPayload: { listingExtraction: facts('Apartment Wat Bo', 300, 'Wat Bo', 'ALIAS-A'), photos: [] } }).id;
    const second = repo.upsertSourceItemDetailed(source, { sourceType: 'FACEBOOK_GROUP', externalId: 'legacy-b-post', sourceUrl: 'https://example.com/legacy-b', rawText: 'For rent in Sala Kamreuk $700/month', contentHash: 'alias-b', classification: 'HOUSING_SUPPLY', rawPayload: { listingExtraction: facts('Apartment Sala Kamreuk', 700, 'Sala Kamreuk', 'ALIAS-B'), photos: [] } }).id;
    const service = new CanonicalShadowService(db);
    service.run({ dryRun: false });
    const firstListing = (db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(first) as { listing_id: number }).listing_id;
    const secondListing = (db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(second) as { listing_id: number }).listing_id;
    expect(firstListing).not.toBe(secondListing);
    expect(db.prepare('SELECT review_status,decision_origin FROM canonical_listing_moderation WHERE listing_id=?').get(firstListing)).toEqual({ review_status: 'approved', decision_origin: 'MIGRATED_LEGACY' });

    db.prepare("DELETE FROM canonical_listing_aliases WHERE namespace='legacy_property_id' AND alias='1'").run();
    db.prepare("INSERT INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('legacy_property_id','1',?)").run(secondListing);
    service.run({ dryRun: false });

    expect(db.prepare("SELECT listing_id FROM canonical_listing_aliases WHERE namespace='legacy_property_id' AND alias='1'").get()).toEqual({ listing_id: secondListing });
    expect(db.prepare('SELECT review_status,decision_origin,review_reason FROM canonical_listing_moderation WHERE listing_id=?').get(firstListing)).toEqual({
      review_status: 'pending', decision_origin: 'DEFAULT_PENDING', review_reason: 'Legacy identity alias conflict; manual review required',
    });
  });

  it('keeps price edits on the same Property, Listing, and occurrence identity', () => {
    const repo=new SourceIngestionRepository(db);const source=repo.upsertSource({sourceType:'FACEBOOK_GROUP',externalSourceId:'price-edit',name:'Price Edit'});
    const facts={title_en:'2BR apartment Wat Bo',description_en:'For rent in Wat Bo',price:400,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',property_code:'P-123',offer_type:'rent'};
    const itemId=repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'post-123',rawText:'2BR Wat Bo for rent $400',contentHash:'price-v1',classification:'HOUSING_SUPPLY',rawPayload:{listingExtraction:facts,photos:['https://img.example/one.jpg']}}).id;
    const service=new CanonicalShadowService(db);service.run({dryRun:false});
    const before=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id,l.price FROM canonical_listing_source_occurrences o
      JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as {occurrence_id:number;listing_id:number;property_id:number;price:number};
    const nextFacts={...facts,price:350};repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'post-123',rawText:'2BR Wat Bo for rent $350',contentHash:'price-v2',classification:'HOUSING_SUPPLY',rawPayload:{listingExtraction:nextFacts,photos:['https://img.example/one.jpg'] }},'2026-10-08T00:00:00Z');
    const result=service.reconcileBoundSourceItems([itemId],'2026-10-08T00:00:00Z');
    const after=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id,l.price,o.price_seen,o.last_seen_at FROM canonical_listing_source_occurrences o
      JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as {occurrence_id:number;listing_id:number;property_id:number;price:number;price_seen:number;last_seen_at:string};
    expect(result).toMatchObject({processed:1,bindingsUpdated:1,repurposed:0,needsGlobalMatch:0});
    expect(after).toMatchObject({occurrence_id:before.occurrence_id,listing_id:before.listing_id,property_id:before.property_id,price:35000,price_seen:35000,last_seen_at:'2026-10-08T00:00:00Z'});
    expect(db.prepare('SELECT COUNT(*) n FROM source_item_versions WHERE source_item_id=?').get(itemId)).toEqual({n:2});
  });

  it('attaches a new repost member to its cluster’s existing canonical listing', () => {
    const repo=new SourceIngestionRepository(db);const source=repo.upsertSource({sourceType:'FACEBOOK_GROUP',externalSourceId:'repost-bind',name:'Repost Bind'});
    const facts={title_en:'2BR apartment Wat Bo',description_en:'Apartment for rent in Wat Bo',price:400,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',property_code:'P-321',offer_type:'rent'};
    const original=repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'post-a',rawText:'2BR apartment Wat Bo for rent $400 monthly code P-321 phone 012 345 678',contentHash:'repost-a',classification:'HOUSING_SUPPLY',authorExternalId:'agent-a',rawPayload:{listingExtraction:facts,photos:['https://img.example/a.jpg']}}).id;
    const canonical=new CanonicalShadowService(db);canonical.run({dryRun:false});
    const prior=db.prepare(`SELECT o.listing_id,l.property_id FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.source_item_id=? AND o.is_current=1`).get(original) as {listing_id:number;property_id:number};
    const repost=repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'post-b',rawText:'2BR apartment Wat Bo for rent $400 monthly code P-321 phone 012 345 678',contentHash:'repost-b',classification:'HOUSING_SUPPLY',authorExternalId:'agent-a',rawPayload:{listingExtraction:facts,photos:['https://img.example/b.jpg']}}).id;
    const cluster=new RepostClusteringService(db);cluster.runIncremental('repost-v1',[repost]);
    const result=canonical.reconcileBoundSourceItems([repost],'2026-10-08T00:00:00Z');
    const attached=db.prepare(`SELECT o.listing_id,l.property_id FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.source_item_id=? AND o.is_current=1`).get(repost);
    expect(result).toMatchObject({processed:1,occurrencesAttached:1,needsGlobalMatch:0});
    expect(attached).toEqual(prior);
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({n:2});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({n:1});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_properties').get()).toEqual({n:1});
    canonical.reconcileBoundSourceItems([repost],'2026-10-08T00:01:00Z');
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({n:2});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({n:1});
  });

  it('reconciles media-only changes on the current binding without changing canonical IDs', () => {
    const repo=new SourceIngestionRepository(db);const source=repo.upsertSource({sourceType:'FACEBOOK_GROUP',externalSourceId:'media-edit',name:'Media Edit'});
    const facts={title_en:'2BR apartment Wat Bo',description_en:'For rent in Wat Bo',price:400,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',offer_type:'rent'};
    const itemId=repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'media-post',rawText:'2BR Wat Bo for rent $400',contentHash:'same-content',mediaHash:'media-a',classification:'HOUSING_SUPPLY',rawPayload:{listingExtraction:facts,photos:['https://img.example/old.jpg']}}).id;
    const canonical=new CanonicalShadowService(db);canonical.run({dryRun:false});
    const before=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.source_item_id=? AND o.is_current=1`).get(itemId);
    repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'media-post',rawText:'2BR Wat Bo for rent $400',contentHash:'same-content',mediaHash:'media-b',classification:'HOUSING_SUPPLY',rawPayload:{listingExtraction:facts,photos:['https://img.example/new.jpg']}},'2026-10-08T00:00:00Z');
    expect(canonical.reconcileBoundSourceItems([itemId],'2026-10-08T00:00:00Z')).toMatchObject({processed:1,bindingsUpdated:1});
    const after=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.source_item_id=? AND o.is_current=1`).get(itemId);
    expect(after).toEqual(before);
    expect(db.prepare(`SELECT ma.normalized_url FROM media_asset_source_occurrences mo JOIN media_assets ma ON ma.id=mo.media_asset_id
      WHERE mo.source_item_id=?`).all(itemId)).toEqual([{normalized_url:'https://img.example/new.jpg'}]);
    expect(db.prepare('SELECT COUNT(*) n FROM source_item_versions WHERE source_item_id=?').get(itemId)).toEqual({n:2});
  });

  it('closes the historical occurrence before a strongly repurposed post gets a new canonical binding', () => {
    const repo=new SourceIngestionRepository(db);const source=repo.upsertSource({sourceType:'FACEBOOK_GROUP',externalSourceId:'repurpose',name:'Repurpose'});
    const oldFacts={title_en:'2BR apartment Wat Bo',description_en:'Apartment for rent',price:400,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',property_code:'OLD-111',offer_type:'rent'};
    const itemId=repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'post-same-id',rawText:'2BR apartment Wat Bo $400 code OLD-111',contentHash:'old-content',classification:'HOUSING_SUPPLY',rawPayload:{listingExtraction:oldFacts,photos:['https://img.example/old.jpg']}}).id;
    const canonical=new CanonicalShadowService(db);canonical.run({dryRun:false});
    const old=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as {occurrence_id:number;listing_id:number;property_id:number};
    const newFacts={title_en:'4BR villa Svay Dangkum',description_en:'Villa for rent',price:900,currency:'USD',category:'house',property_type:'Villa',bedrooms:4,city:'siem_reap',sangkat:'Svay Dangkum',property_code:'NEW-999',offer_type:'rent'};
    repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'post-same-id',rawText:'4BR villa Svay Dangkum $900 code NEW-999 phone 099 999 999',contentHash:'new-content',classification:'HOUSING_SUPPLY',rawPayload:{listingExtraction:newFacts,photos:['https://img.example/new.jpg'] }},'2026-10-10T00:00:00Z');
    repo.replaceIdentifiers(itemId,[{type:'PROPERTY_CODE',normalizedValue:'NEW-999'},{type:'PHONE',normalizedValue:'+85599999999'}]);
    new RepostClusteringService(db).runIncremental('repost-v1',[itemId]);
    const change=canonical.reconcileBoundSourceItems([itemId],'2026-10-10T00:00:00Z');
    expect(change).toMatchObject({repurposed:1,needsGlobalMatch:1});
    const historical=db.prepare('SELECT id,listing_id,is_current,ended_at FROM canonical_listing_source_occurrences WHERE source_item_id=? ORDER BY id').all(itemId);
    expect(historical).toEqual([{id:old.occurrence_id,listing_id:old.listing_id,is_current:0,ended_at:'2026-10-10T00:00:00Z'}]);
    canonical.run({dryRun:false});
    const current=db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(itemId) as {listing_id:number};
    expect(current.listing_id).not.toBe(old.listing_id);
    const newBinding=db.prepare(`SELECT o.id,o.listing_id,l.property_id,o.is_current FROM canonical_listing_source_occurrences o
      JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as {id:number;listing_id:number;property_id:number;is_current:number};
    expect(newBinding.listing_id).not.toBe(old.listing_id);
    expect(newBinding.property_id).not.toBe(old.property_id);
    expect(newBinding.is_current).toBe(1);
    expect(db.prepare('SELECT is_current,ended_at FROM canonical_listing_source_occurrences WHERE id=?').get(old.occurrence_id))
      .toEqual({is_current:0,ended_at:'2026-10-10T00:00:00Z'});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE source_item_id=?').get(itemId)).toEqual({n:2});
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(old.listing_id)).toEqual({status:'inactive'});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_properties WHERE id=?').get(old.property_id)).toEqual({n:1});
    expect(db.prepare('SELECT COUNT(*) n FROM source_item_versions WHERE source_item_id=?').get(itemId)).toEqual({n:2});
  });

  it('produces order-independent cross-source canonical topology for same and separate offers', () => {
    const runOrder=(order:Array<'FACEBOOK_GROUP'|'KHMER24'>,differentOffer:boolean)=>{
      const fixtureDb=new DatabaseSync(':memory:');runMigrations(fixtureDb);
      const repo=new SourceIngestionRepository(fixtureDb);const service=new CanonicalShadowService(fixtureDb);
      for(const sourceType of order){
        const source=repo.upsertSource({sourceType,externalSourceId:`order-${sourceType}-${differentOffer}`,name:`${sourceType} fixture`});
        const fb=sourceType==='FACEBOOK_GROUP';const price=fb?(differentOffer?420:350):350;const phone=fb&&differentOffer?'+855999111222':'+85512345678';
        const code=fb&&differentOffer?'ORDER-FB':'ORDER-42';
        const facts={title_en:'2BR apartment Wat Bo',description_en:'Furnished apartment for rent in Wat Bo',price,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,bathrooms:1,city:'siem_reap',sangkat:'Wat Bo',property_code:code,offer_type:'rent',lease_term_text:fb&&differentOffer?'12 month lease':'Flexible lease'};
        repo.upsertSourceItemDetailed(source,{sourceType,externalId:fb?'fb-order-1':'adid-9001',rawText:`2BR apartment Wat Bo rent $${price} monthly`,contentHash:`${sourceType}-${differentOffer}`,classification:'HOUSING_SUPPLY',sourceUrl:fb?'https://facebook.com/groups/order/posts/1':'https://khmer24.example/adid-9001',rawPayload:{...(fb?{listingExtraction:facts}:{listingFacts:facts}),photos:[`${fb?'https://fb.example':'https://k24.example'}/one.jpg`,`${fb?'https://fb.example':'https://k24.example'}/two.jpg`],imagePhashes:[HASH_A,HASH_B]}});
        repo.replaceIdentifiers(Number((fixtureDb.prepare('SELECT id FROM source_items WHERE external_id=?').get(fb?'fb-order-1':'adid-9001') as {id:number}).id),[
          {type:'PROPERTY_CODE',normalizedValue:code},{type:'PHONE',normalizedValue:phone},
        ]);
        service.run({dryRun:false});
      }
      const result={properties:(fixtureDb.prepare('SELECT COUNT(*) n FROM canonical_properties').get() as {n:number}).n,
        listings:(fixtureDb.prepare('SELECT COUNT(*) n FROM canonical_listings').get() as {n:number}).n,
        occurrences:(fixtureDb.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE is_current=1').get() as {n:number}).n,
        decisions:fixtureDb.prepare('SELECT decision FROM dedupe_decisions ORDER BY decision').all() as Array<{decision:string}>,
        listingMemberships:fixtureDb.prepare(`SELECT group_concat(source_type,',') source_types FROM (
          SELECT DISTINCT o.listing_id,r.source_type FROM canonical_listing_source_occurrences o JOIN source_registry r ON r.id=o.source_registry_id
          WHERE o.is_current=1 AND o.source_entity_key='canonical-dedupe-v1' ORDER BY r.source_type) GROUP BY listing_id ORDER BY source_types`).all() as Array<{source_types:string}>};
      fixtureDb.close();return result;
    };
    for(const differentOffer of [false,true]){
      const forward=runOrder(['KHMER24','FACEBOOK_GROUP'],differentOffer);
      const reverse=runOrder(['FACEBOOK_GROUP','KHMER24'],differentOffer);
      if(forward.properties!==1)throw new Error(JSON.stringify({differentOffer,forward,reverse}));
      expect(reverse).toEqual(forward);
      expect(forward.properties).toBe(1);
      expect(forward.listings).toBe(differentOffer?2:1);
      expect(forward.occurrences).toBe(2);
      expect(forward.listingMemberships).toEqual(differentOffer?[{source_types:'FACEBOOK_GROUP'},{source_types:'KHMER24'}]:[{source_types:'FACEBOOK_GROUP,KHMER24'}]);
      expect(forward.decisions).toEqual([{decision:differentOffer?'SAME_PROPERTY_DIFFERENT_LISTING':'SAME_LISTING'}]);
    }
  });

  it('rolls back canonical entities and dedupe decisions when occurrence materialization is interrupted', () => {
    const repo=new SourceIngestionRepository(db);const source=repo.upsertSource({sourceType:'FACEBOOK_GROUP',externalSourceId:'atomic-canonical',name:'Atomic'});
    const itemId=repo.upsertSourceItemDetailed(source,{sourceType:'FACEBOOK_GROUP',externalId:'atomic-1',rawText:'2BR apartment Wat Bo for rent $400',contentHash:'atomic-1',classification:'HOUSING_SUPPLY',
      rawPayload:{listingExtraction:{title_en:'2BR apartment Wat Bo',description_en:'For rent $400',price:400,currency:'USD',property_type:'Apartment',category:'apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',offer_type:'rent'},photos:[]}}).id;
    db.exec(`CREATE TRIGGER fail_occurrence_insert BEFORE INSERT ON canonical_listing_source_occurrences
      WHEN NEW.source_item_id=${itemId} BEGIN SELECT RAISE(ABORT,'simulated interruption before occurrence'); END`);
    const service=new CanonicalShadowService(db);
    expect(()=>service.run({dryRun:false})).toThrow('simulated interruption before occurrence');
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_properties').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) n FROM dedupe_decisions').get()).toEqual({n:0});
    db.exec('DROP TRIGGER fail_occurrence_insert');
    service.run({dryRun:false});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({n:1});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({n:1});
  });
});
