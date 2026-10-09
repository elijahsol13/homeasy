import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { FreshnessScheduler, freshnessJobSkipReason, reserveBrightDataRecords, cancelFreshnessJobAfterRediscovery } from '../src/modules/parser/freshness-scheduler';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';

describe('FreshnessScheduler dry-run', () => {
  let db: DatabaseSync;
  let listingFixture = 0;
  const now = new Date('2026-10-07T00:00:00.000Z');

  beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); listingFixture = 0; });
  afterEach(() => db.close());

  function seedDemand(): void {
    db.prepare("INSERT INTO users(telegram_id) VALUES(1)").run();
    db.prepare(`INSERT INTO search_filters(user_id,type,min_price,max_price,bedrooms,locations,city,is_active)
      VALUES(1,'rent',NULL,60000,2,'["Wat Bo"]','siem_reap',1)`).run();
  }

  function seedListing(lastSeen: string, sourceTypes: Array<'KHMER24' | 'FACEBOOK_GROUP'> = ['KHMER24']): number {
    const fixture = listingFixture++;
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings
      (public_ref,status,availability_status,price,title,city,sangkat,bedrooms,first_seen_at,last_seen_at)
      VALUES('lst_'||lower(hex(randomblob(16))),'active','available',40000,'2BR in Wat Bo','siem_reap','Wat Bo',2,?,?)`).run(lastSeen, lastSeen).lastInsertRowid);
    const repo = new SourceIngestionRepository(db);
    for (const [i, sourceType] of sourceTypes.entries()) {
      const registryId = repo.upsertSource({ sourceType, externalSourceId: `s${fixture}-${i}`, name: sourceType });
      const sourceItemId = repo.upsertSourceItemDetailed(registryId, { sourceType, externalId: `ad-${fixture}-${i}`,
        rawText: '2 bedroom apartment Wat Bo', contentHash: `source-${fixture}-${i}`, classification: 'HOUSING_SUPPLY' }).id;
      db.prepare(`INSERT INTO canonical_listing_source_occurrences
        (source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
        VALUES(?,?,?,?,?,?, 'canonical-dedupe-v1')`).run(sourceItemId, listingId, registryId, `ad-${fixture}-${i}`, lastSeen, lastSeen);
    }
    return listingId;
  }

  it('does not propose checks for stale inventory without active demand', () => {
    const id = seedListing('2026-09-01T00:00:00.000Z');
    const report = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 100, freshnessBudgetPercent: 20,
      reservePercent: 10, now }).plan();
    expect(report.canonicalActiveListings).toBe(1);
    expect(report.stale).toBe(1);
    expect(report.proposed).toHaveLength(0);
    expect(report.skipReasons['no active demand in top-N']).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 0 });
    expect(id).toBeGreaterThan(0);
  });

  it('chooses one cheapest source per demanded listing and accounts for reservations', () => {
    seedDemand();
    const listingId = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP', 'KHMER24']);
    db.prepare(`INSERT INTO freshness_jobs(listing_id,check_type,provider,priority,reason,scheduled_at,status,estimated_cost,estimated_records)
      VALUES(?, 'SOURCE_RECHECK','BRIGHTDATA',1,'existing reservation','2026-10-06T00:00:00Z','QUEUED',1,1)`).run(listingId);
    const report = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 10, freshnessBudgetPercent: 50,
      reservePercent: 10, now }).plan();
    expect(report.proposed).toHaveLength(1);
    expect(report.proposed[0]?.provider).toBe('KHMER24');
    expect(report.proposed[0]?.estimatedBrightDataRecords).toBe(0);
    expect(report.queuedOrReservedRecords).toBe(1);
    expect(report.paidExecutionEnabled).toBe(false);
  });

  it('skips paid work when reserve and queued jobs consume the freshness budget', () => {
    seedDemand();
    const listingId = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP']);
    db.prepare(`INSERT INTO freshness_jobs(listing_id,check_type,provider,priority,reason,scheduled_at,status,estimated_cost,estimated_records)
      VALUES(?, 'SOURCE_RECHECK','BRIGHTDATA',1,'existing reservation','2026-10-06T00:00:00Z','QUEUED',2,2)`).run(listingId);
    const report = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 10, freshnessBudgetPercent: 30,
      reservePercent: 10, now }).plan();
    expect(report.availableFreshnessRecords).toBe(0);
    expect(report.top20PaidChecks).toHaveLength(0);
    expect(report.skipReasons['freshness budget exhausted or reserved']).toBe(1);
  });

  it('marks recently seen inventory fresh and provides a future-worker cancellation preflight', () => {
    seedDemand();
    const id = seedListing('2026-10-06T00:00:00.000Z');
    const report = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0,
      reservePercent: 0, now }).plan();
    expect(report.currentlyFresh).toBe(1);
    expect(report.wouldCheck).toBe(0);
    expect(freshnessJobSkipReason(db, id, '2026-10-05T00:00:00Z', true)).toContain('naturally rediscovered');
  });

  it('proposes one stale, demanded item when budget is available and skips it when exhausted', () => {
    seedDemand();
    seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP']);
    const scheduler = () => new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 100,
      freshnessBudgetPercent: 20, reservePercent: 10, now });
    expect(scheduler().plan().proposed).toHaveLength(1);
    expect(scheduler().plan().proposed[0]?.provider).toBe('BRIGHTDATA');
    db.prepare(`INSERT INTO external_provider_usage(provider,operation,records) VALUES('BRIGHTDATA','DISCOVERY',10)`).run();
    const exhausted = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 10,
      freshnessBudgetPercent: 100, reservePercent: 0, now }).plan();
    expect(exhausted.proposed).toHaveLength(0);
    expect(exhausted.skipReasons['freshness budget exhausted or reserved']).toBe(1);
  });

  it('cancels a queued job after natural rediscovery at zero actual cost', () => {
    seedDemand();
    const listingId = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP']);
    const jobId = Number(db.prepare(`INSERT INTO freshness_jobs(listing_id,check_type,provider,scheduled_at,status,estimated_records)
      VALUES(?,'SOURCE_RECHECK','BRIGHTDATA','2026-10-07T00:00:00.000Z','QUEUED',1)`).run(listingId).lastInsertRowid);
    db.prepare('UPDATE canonical_listings SET last_seen_at=? WHERE id=?').run('2026-10-07T00:01:00.000Z', listingId);
    expect(cancelFreshnessJobAfterRediscovery(db, jobId, '2026-10-07T00:01:01.000Z')).toBe(true);
    expect(db.prepare('SELECT status,actual_cost FROM freshness_jobs WHERE id=?').get(jobId)).toEqual({ status: 'CANCELLED', actual_cost: 0 });
  });

  it('atomically limits concurrent reservations to the remaining record budget', () => {
    const first = seedListing('2026-09-01T00:00:00.000Z');
    const second = seedListing('2026-09-02T00:00:00.000Z');
    expect(reserveBrightDataRecords(db, { listingId: first, estimatedRecords: 1, monthlyBudget: 10,
      freshnessBudgetPercent: 20, reservePercent: 10, now })).toBe(true);
    expect(reserveBrightDataRecords(db, { listingId: second, estimatedRecords: 1, monthlyBudget: 10,
      freshnessBudgetPercent: 20, reservePercent: 10, now })).toBe(false);
    expect(db.prepare(`SELECT COALESCE(SUM(estimated_records),0) n FROM freshness_jobs WHERE provider='BRIGHTDATA'
      AND status IN ('QUEUED','RUNNING')`).get()).toEqual({ n: 1 });
  });
});
