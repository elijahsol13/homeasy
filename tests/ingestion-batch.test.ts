import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import type { SourceAdapter, SourceRunContext, NormalizedSourceItem } from '../src/modules/parser/ingestion-contracts';
import { FacebookLiveAdapter } from '../src/modules/parser/live-source-adapters';
import { RepostClusteringService } from '../src/modules/parser/repost-clustering';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

interface FixturePost { id: string; text: string; }

class FixtureAdapter implements SourceAdapter<FixturePost> {
  readonly sourceType = 'FACEBOOK_GROUP' as const;
  constructor(private readonly post: FixturePost) {}
  async *fetchNewItems(_context: SourceRunContext): AsyncIterable<FixturePost> { yield this.post; }
  normalize(post: FixturePost): NormalizedSourceItem<FixturePost> {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return {
      sourceIdentity: { sourceType: 'FACEBOOK_GROUP', externalSourceId: 'siem-reap-rentals',
        name: 'Siem Reap Rentals', url: 'https://facebook.com/groups/siem-reap-rentals', city: 'siem_reap' },
      externalId: post.id, raw: post, rawText: post.text,
      contentHash: createHash('sha256').update(post.text).digest('hex'),
      classification: 'HOUSING_SUPPLY',
    };
  }
}

describe('IngestionService.ingestBatch', () => {
  let db: DatabaseSync;
  let ingestion: ReturnType<typeof createContainer>['ingestionService'];

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    ingestion = createContainer({ db }).ingestionService;
  });
  afterEach(() => db.close());

  const context = (ingestionMethod: SourceRunContext['ingestionMethod']): SourceRunContext => ({
    runType: 'REPLAY', ingestionMethod, observedAt: '2026-10-07T00:00:00.000Z',
  });

  it('keeps one source item and preserves the previous version after an edit', async () => {
    const first = await ingestion.ingestBatch(new FixtureAdapter({ id: '123', text: 'For rent $400' }), context('REPLAY'));
    const second = await ingestion.ingestBatch(new FixtureAdapter({ id: '123', text: 'For rent $350' }), {
      ...context('REPLAY'), observedAt: '2026-10-07T01:00:00.000Z',
    });
    expect(first.newSourceItems).toBe(1);
    expect(second.updatedSourceItems).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({ count: 1 });
    const versions = db.prepare('SELECT raw_text FROM source_item_versions ORDER BY id').all();
    expect(versions).toEqual([{ raw_text: 'For rent $400' }, { raw_text: 'For rent $350' }]);
    const lastSeen = db.prepare('SELECT last_seen_at FROM source_items').get() as { last_seen_at: string };
    expect(lastSeen.last_seen_at).toBe('2026-10-07T01:00:00.000Z');
  });

  it('resolves one Facebook group to the same source across Bright Data and Camoufox methods', async () => {
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'a', text: 'House for rent' }), context('BRIGHTDATA'));
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'b', text: 'Apartment for rent' }), context('CAMOUFOX'));
    expect(db.prepare('SELECT COUNT(*) count FROM source_registry').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM processing_run_sources').get()).toEqual({ count: 2 });
  });

  it('dry-run validates and counts without changing the database', async () => {
    const before = db.prepare('SELECT COUNT(*) count FROM source_registry').get();
    const result = await ingestion.ingestBatch(new FixtureAdapter({ id: 'x', text: 'Phone: 012 345 678' }), {
      ...context('REPLAY'), dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.newSourceItems).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_registry').get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) count FROM processing_runs').get()).toEqual({ count: 0 });
  });

  it('skips live AI processing on unchanged discovery while refreshing last_seen', async () => {
    let processCalls = 0;
    const fetcher = async function* () {
      yield { sourceId: 'group-1', sourceName: 'Group 1', groupId: 'group-1', groupName: 'Group 1',
        listing: { title: '2BR apartment Wat Bo', description: 'For rent $400 monthly', raw_text: 'For rent $400 monthly',
          source_url: 'https://facebook.com/groups/group-1/posts/123', city: 'siem_reap', photos: ['https://img.example/a.jpg'] } };
    };
    const adapter = new FacebookLiveAdapter(fetcher, async (_raw, item) => {
      processCalls++;
      return { ...item, aiResults: [{ stage: 'SUPPLY_EXTRACTION', provider: 'fixture', model: 'fixture-v1',
        fallbackDepth: 0, promptVersion: 'listing-v1', success: true, latencyMs: 5 }] };
    });
    const first = await ingestion.ingestBatch(adapter, { runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-07T00:00:00Z' });
    const second = await ingestion.ingestBatch(adapter, { runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-08T00:00:00Z' });
    expect(processCalls).toBe(1);
    expect(first.newSourceItems).toBe(1);
    expect(second.unchangedSourceItems).toBe(1);
    expect(second.providerCounts).toEqual({});
    expect(db.prepare('SELECT COUNT(*) count FROM ai_processing_results').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM source_item_versions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT last_seen_at FROM source_items').get()).toEqual({ last_seen_at: '2026-10-08T00:00:00Z' });
    expect(db.prepare('SELECT COUNT(*) count FROM external_provider_usage').get()).toEqual({ count: 2 });
  });

  it('uses natural rediscovery as last_seen evidence without changing availability confirmation', async () => {
    const adapter = new FixtureAdapter({ id: 'natural-1', text: 'For rent $400' });
    await ingestion.ingestBatch(adapter, { runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-01T00:00:00Z' });
    const source = db.prepare('SELECT id,source_registry_id FROM source_items').get() as { id: number; source_registry_id: number };
    const listingId=(db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(source.id) as {listing_id:number}).listing_id;
    db.prepare("UPDATE canonical_listings SET availability_status='available',availability_last_confirmed_at='2026-09-30T00:00:00Z' WHERE id=?").run(listingId);
    await ingestion.ingestBatch(adapter, { runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-07T00:00:00Z' });
    expect(db.prepare('SELECT last_seen_at,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ last_seen_at: '2026-10-07T00:00:00Z', availability_last_confirmed_at: '2026-09-30T00:00:00Z' });
    expect(db.prepare('SELECT last_seen_at FROM canonical_listing_source_occurrences WHERE listing_id=?').get(listingId))
      .toEqual({ last_seen_at: '2026-10-07T00:00:00Z' });
  });

  it('updates media-only state and history without repeating AI extraction', async () => {
    let processCalls = 0;
    const fetcher = async function* (photo: string) {
      yield { sourceId: 'group-media', sourceName: 'Media Group', groupId: 'group-media',
        listing: { title: '2BR apartment Wat Bo', description: 'For rent $400 monthly', raw_text: 'For rent $400 monthly',
          source_url: 'https://facebook.com/groups/group-media/posts/777', city: 'siem_reap', photos: [photo] } };
    };
    const adapter = (photo: string) => new FacebookLiveAdapter((ctx) => fetcher(photo), async (_raw, item) => {
      processCalls++;
      return { ...item, raw: { ...(item.raw as object), preservedExtraction: { bedrooms: 2 } } as unknown as typeof item.raw,
        aiResults: [{ stage: 'SUPPLY_EXTRACTION', provider: 'fixture', model: 'fixture-v1', success: true }] };
    });
    await ingestion.ingestBatch(adapter('https://img.example/old.jpg'), { ...context('BRIGHTDATA'), runType: 'DISCOVERY' });
    const changed = await ingestion.ingestBatch(adapter('https://img.example/new.jpg'), {
      ...context('BRIGHTDATA'), runType: 'DISCOVERY', observedAt: '2026-10-08T00:00:00Z',
    });
    expect(processCalls).toBe(1);
    expect(changed.updatedSourceItems).toBe(1);
    expect(db.prepare('SELECT media_hash FROM source_items').get()).not.toEqual({ media_hash: null });
    expect(db.prepare("SELECT COUNT(*) count FROM source_item_versions").get()).toEqual({ count: 2 });
    const payload = JSON.parse((db.prepare('SELECT raw_payload_json FROM source_items').get() as { raw_payload_json: string }).raw_payload_json);
    expect(payload.photos).toEqual(['https://img.example/new.jpg']);
    expect(payload.preservedExtraction).toEqual({ bedrooms: 2 });
    expect(changed.incrementalCanonicalItems).toBe(1);
    expect(db.prepare(`SELECT ma.normalized_url FROM media_asset_source_occurrences mo JOIN media_assets ma ON ma.id=mo.media_asset_id
      WHERE mo.source_item_id=(SELECT id FROM source_items WHERE external_id='777')`).all()).toEqual([{normalized_url:'https://img.example/new.jpg'}]);
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_properties').get()).toEqual({n:1});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({n:1});
  });

  it('marks explicit rented edits as availability evidence and keeps source history', async () => {
    const first = new FixtureAdapter({ id: 'availability-1', text: 'For rent $400 Wat Bo' });
    await ingestion.ingestBatch(first, { ...context('REPLAY'), runType: 'DISCOVERY' });
    const source = db.prepare('SELECT id,source_registry_id FROM source_items').get() as { id: number; source_registry_id: number };
    const listingId=(db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(source.id) as {listing_id:number}).listing_id;
    db.prepare("UPDATE canonical_listings SET availability_status='available' WHERE id=?").run(listingId);
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'availability-1', text: 'RENTED — this unit is no longer available' }), {
      ...context('REPLAY'), runType: 'DISCOVERY', observedAt: '2026-10-08T00:00:00Z',
    });
    expect(db.prepare('SELECT availability_status,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ availability_status: 'rented', availability_last_confirmed_at: '2026-10-08T00:00:00Z' });
    expect(db.prepare('SELECT availability_signal FROM canonical_listing_source_occurrences WHERE source_item_id=?').get(source.id))
      .toEqual({ availability_signal: 'unavailable' });
    expect(db.prepare('SELECT check_type,result FROM availability_checks WHERE listing_id=?').get(listingId))
      .toEqual({ check_type: 'CONTENT_CHANGE', result: 'UNAVAILABLE' });
    expect(db.prepare('SELECT COUNT(*) count FROM source_item_versions WHERE source_item_id=?').get(source.id)).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_properties').get()).toEqual({ count: 1 });
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'availability-1', text: 'AVAILABLE now — same Wat Bo unit' }), {
      ...context('REPLAY'), runType: 'DISCOVERY', observedAt: '2026-10-20T00:00:00Z',
    });
    expect(db.prepare('SELECT availability_status,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ availability_status: 'available', availability_last_confirmed_at: '2026-10-20T00:00:00Z' });
    expect(db.prepare('SELECT availability_signal FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(source.id))
      .toEqual({ availability_signal: 'available' });
    expect(db.prepare('SELECT result,new_status FROM availability_checks WHERE listing_id=? ORDER BY id').all(listingId))
      .toEqual([{ result: 'UNAVAILABLE', new_status: 'rented' }, { result: 'ALIVE', new_status: 'available' }]);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_properties').get()).toEqual({ count: 1 });
  });

  it('ingests a new repost into the existing repost cluster and canonical Listing', async () => {
    const fetcher = async function* (externalId: string) {
      yield { sourceId:'fb-repost-group',sourceName:'FB Reposts',groupId:'fb-repost-group',groupName:'FB Reposts',
        listing:{title:'2BR apartment Wat Bo',description:'For rent $400 monthly, property code WAT-42, phone 012 345 678',
          raw_text:'2BR apartment Wat Bo for rent $400 monthly property code WAT-42 phone 012 345 678',
          source_url:`https://facebook.com/groups/fb-repost-group/posts/${externalId}`,city:'siem_reap',photos:['https://img.example/repost.jpg'],
          price:400,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,location:'Wat Bo',
          listing_facts_json:JSON.stringify({title_en:'2BR apartment Wat Bo',description_en:'For rent $400 monthly',price:400,currency:'USD',
            category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',offer_type:'rent'})}};
    };
    const adapter = (id:string) => new FacebookLiveAdapter(() => fetcher(id));
    const first=await ingestion.ingestBatch(adapter('post-a'),{...context('BRIGHTDATA'),runType:'DISCOVERY'});
    const second=await ingestion.ingestBatch(adapter('post-b'),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-08T00:00:00Z'});
    expect(first.globalCanonicalRuns).toBe(1);
    expect(second.incrementalRepostItems).toBe(1);
    expect(second.occurrencesAttached).toBe(1);
    expect(second.globalCanonicalRuns).toBe(0);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({count:2});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_properties').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listings').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:2});
    const repeat=await ingestion.ingestBatch(adapter('post-b'),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-09T00:00:00Z'});
    expect(repeat.unchangedSourceItems).toBe(1);
    expect(repeat.incrementalRepostItems).toBe(0);
    expect(repeat.incrementalCanonicalItems).toBe(0);
    expect(repeat.globalCanonicalRuns).toBe(0);
    expect(repeat.newVersions).toBe(0);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:2});
  });

  it('keeps a changed price on its existing canonical binding through the complete ingestion path', async () => {
    let extractionCalls=0;
    const fetcher = async function* (price:number) {
      yield {sourceId:'fb-price-group',sourceName:'Price Group',groupId:'fb-price-group',groupName:'Price Group',
        listing:{title:'2BR apartment Wat Bo',description:`For rent $${price} monthly`,raw_text:`2BR apartment Wat Bo for rent $${price} monthly`,
          source_url:'https://facebook.com/groups/fb-price-group/posts/price-123',city:'siem_reap',price,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,
          photos:[],location:'Wat Bo',listing_facts_json:JSON.stringify({title_en:'2BR apartment Wat Bo',description_en:`For rent $${price} monthly`,price,currency:'USD',
            category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',offer_type:'rent'})}};
    };
    const adapter=(price:number)=>new FacebookLiveAdapter(()=>fetcher(price),async(_raw,item)=>{
      extractionCalls++;
      return {...item,aiResults:[{stage:'SUPPLY_EXTRACTION',provider:'fixture',model:'fixture-v1',success:true}]};
    });
    await ingestion.ingestBatch(adapter(400),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-01T00:00:00Z'});
    const before=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id,l.price FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.is_current=1`).get() as {occurrence_id:number;listing_id:number;property_id:number;price:number};
    const changed=await ingestion.ingestBatch(adapter(350),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-02T00:00:00Z'});
    const after=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id,l.price,o.price_seen,o.last_seen_at FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.is_current=1`).get();
    expect(extractionCalls).toBe(2);
    expect(changed.updatedSourceItems).toBe(1);
    expect(changed.canonicalBindingsUpdated).toBe(1);
    expect(changed.globalCanonicalRuns).toBe(0);
    expect(after).toEqual({...before,price:35000,price_seen:35000,last_seen_at:'2026-10-02T00:00:00Z'});
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM source_item_versions').get()).toEqual({count:2});
    const repeated=await ingestion.ingestBatch(adapter(350),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-03T00:00:00Z'});
    expect(repeated.unchangedSourceItems).toBe(1);
    expect(repeated.newVersions).toBe(0);
    expect(repeated.incrementalRepostItems).toBe(0);
    expect(repeated.incrementalCanonicalItems).toBe(0);
    expect(repeated.globalCanonicalRuns).toBe(0);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:1});
  });

  it('recovers after an interruption immediately after SourceItem persistence', async () => {
    const fetcher=async function*(){yield {sourceId:'recovery-group',sourceName:'Recovery',groupId:'recovery-group',groupName:'Recovery',
      listing:{title:'2BR apartment Wat Bo',description:'For rent $400 monthly',raw_text:'2BR apartment Wat Bo for rent $400 monthly',
        source_url:'https://facebook.com/groups/recovery-group/posts/1',city:'siem_reap',photos:[]}};};
    const adapter=new FacebookLiveAdapter(fetcher);
    const failOnce=jest.spyOn(RepostClusteringService.prototype,'runIncremental').mockImplementationOnce(()=>{throw new Error('simulated interruption');});
    const first=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY'});
    expect(first.errors).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM dedupe_cluster_members').get()).toEqual({count:0});
    const retried=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-08T00:00:00Z'});
    expect(retried.unchangedSourceItems).toBe(1);
    expect(retried.incrementalRepostItems).toBe(1);
    expect(retried.globalCanonicalRuns).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM dedupe_cluster_members').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:1});
    failOnce.mockRestore();
  });

  it('recovers after repost assignment when canonical occurrence materialization is interrupted', async () => {
    const fetcher=async function*(){yield {sourceId:'canonical-recovery',sourceName:'Canonical Recovery',groupId:'canonical-recovery',groupName:'Canonical Recovery',
      listing:{title:'2BR apartment Wat Bo',description:'For rent $400 monthly',raw_text:'2BR apartment Wat Bo for rent $400 monthly',
        source_url:'https://facebook.com/groups/canonical-recovery/posts/1',city:'siem_reap',photos:[]}};};
    const adapter=new FacebookLiveAdapter(fetcher);
    const failOnce=jest.spyOn(CanonicalShadowService.prototype,'reconcileBoundSourceItems').mockImplementationOnce(()=>{throw new Error('simulated occurrence interruption');});
    const first=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY'});
    expect(first.errors).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) count FROM dedupe_cluster_members').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:0});
    const retry=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-08T00:00:00Z'});
    expect(retry.unchangedSourceItems).toBe(1);
    expect(retry.incrementalRepostItems).toBe(0);
    expect(retry.globalCanonicalRuns).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:1});
    failOnce.mockRestore();
  });
});
