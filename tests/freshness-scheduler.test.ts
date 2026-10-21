import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { FreshnessScheduler, freshnessJobSkipReason, reserveBrightDataRecords, cancelFreshnessJobAfterRediscovery } from '../src/modules/parser/freshness-scheduler';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { applyCanonicalSourceCheckResult } from '../src/database/repositories/canonical-source-check.repo';
import { stageCanonicalKhmer24Freshness } from '../src/modules/parser/canonical-freshness-stager';
import { CanonicalFreshnessExecutor } from '../src/modules/parser/canonical-freshness-executor';

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
        (source_item_id,listing_id,source_registry_id,external_id,source_url,first_seen_at,last_seen_at,source_entity_key)
        VALUES(?,?,?,?,?,?,?, 'canonical-dedupe-v1')`).run(sourceItemId, listingId, registryId, `ad-${fixture}-${i}`,
        sourceType === 'KHMER24' ? `https://www.khmer24.com/en/ad-adid-${fixture + 1}${i + 1}` : null, lastSeen, lastSeen);
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
    const reservedListingId = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP']);
    db.prepare(`INSERT INTO freshness_jobs(listing_id,check_type,provider,priority,reason,scheduled_at,status,estimated_cost,estimated_records)
      VALUES(?, 'SOURCE_RECHECK','BRIGHTDATA',1,'existing reservation','2026-10-06T00:00:00Z','QUEUED',1,1)`).run(reservedListingId);
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
    const reservedListingId = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP']);
    db.prepare(`INSERT INTO freshness_jobs(listing_id,check_type,provider,priority,reason,scheduled_at,status,estimated_cost,estimated_records)
      VALUES(?, 'SOURCE_RECHECK','BRIGHTDATA',1,'existing reservation','2026-10-06T00:00:00Z','QUEUED',2,2)`).run(reservedListingId);
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

  it('uses the selected source due time, never another source\'s earlier check date', () => {
    seedDemand();
    const id = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP', 'KHMER24']);
    const rows = db.prepare(`SELECT o.id,r.source_type FROM canonical_listing_source_occurrences o
      JOIN source_registry r ON r.id=o.source_registry_id WHERE o.listing_id=?`).all(id) as Array<{ id: number; source_type: string }>;
    const khmer = rows.find((row) => row.source_type === 'KHMER24')!.id;
    const fb = rows.find((row) => row.source_type === 'FACEBOOK_GROUP')!.id;
    db.prepare('UPDATE canonical_listing_source_occurrences SET next_check_at=? WHERE id=?')
      .run('2026-10-07T06:00:00.000Z', khmer);
    db.prepare('UPDATE canonical_listing_source_occurrences SET next_check_at=? WHERE id=?')
      .run('2026-10-06T00:00:00.000Z', fb);
    const planner = () => new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 100,
      freshnessBudgetPercent: 20, reservePercent: 10, now }).plan();
    expect(planner().proposed).toHaveLength(0);
    expect(planner().skipReasons['next_check_at is in the future']).toBe(1);
    db.prepare('UPDATE canonical_listing_source_occurrences SET next_check_at=? WHERE id=?')
      .run('2026-10-06T00:00:00.000Z', khmer);
    db.prepare('UPDATE canonical_listing_source_occurrences SET next_check_at=? WHERE id=?')
      .run('2026-10-08T00:00:00.000Z', fb);
    expect(planner().proposed).toEqual([expect.objectContaining({ listingId: id, sourceOccurrenceId: khmer, provider: 'KHMER24' })]);
  });

  it('respects the Khmer24 confirmation deadline before planning its second check', () => {
    seedDemand();
    const id = seedListing('2026-09-01T00:00:00.000Z');
    const occurrenceId = (db.prepare('SELECT id FROM canonical_listing_source_occurrences WHERE listing_id=?').get(id) as { id: number }).id;
    expect(applyCanonicalSourceCheckResult(db, { occurrenceId, observationId: 'khmer24-first-check',
      checkedAt: '2026-10-06T19:00:00Z', outcome: 'DEAD' }))
      .toBe('pending_confirmation');
    const config = { monthlyBrightDataRecordBudget: 100, freshnessBudgetPercent: 20, reservePercent: 10 };
    expect(new FreshnessScheduler(db, { ...config, now }).plan().proposed).toHaveLength(0);
    const due = new FreshnessScheduler(db, { ...config, now: new Date('2026-10-07T01:00:00Z') }).plan();
    expect(due.proposed).toEqual([expect.objectContaining({ listingId: id, sourceOccurrenceId: occurrenceId, provider: 'KHMER24' })]);
  });

  it('checks due Khmer24 confirmation even when a different Facebook source is freshly observed', () => {
    seedDemand();
    const listingId = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP', 'KHMER24']);
    const rows = db.prepare(`SELECT o.id,o.source_item_id,r.source_type
      FROM canonical_listing_source_occurrences o JOIN source_registry r ON r.id=o.source_registry_id
      WHERE o.listing_id=?`).all(listingId) as Array<{ id: number; source_item_id: number; source_type: string }>;
    const khmer = rows.find((row) => row.source_type === 'KHMER24')!;
    const facebook = rows.find((row) => row.source_type === 'FACEBOOK_GROUP')!;
    expect(applyCanonicalSourceCheckResult(db, { occurrenceId: khmer.id, observationId: 'khmer-multi-source-dead-1',
      checkedAt: '2026-10-06T19:00:00Z', outcome: 'DEAD' })).toBe('pending_confirmation');
    new SourceIngestionRepository(db).recordNaturalRediscovery(facebook.source_item_id, '2026-10-07T00:10:00Z');
    const config = { monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0 };
    const before = new FreshnessScheduler(db, { ...config, now: new Date('2026-10-07T00:30:00Z') }).plan();
    expect(before.proposed).toHaveLength(0);
    const due = new FreshnessScheduler(db, { ...config, now: new Date('2026-10-07T01:00:00Z') }).plan();
    expect(due.proposed).toEqual([expect.objectContaining({ listingId, sourceOccurrenceId: khmer.id,
      provider: 'KHMER24', estimatedBrightDataRecords: 0 })]);
    expect(due.proposed[0]?.reason).toContain('due Khmer24 terminal confirmation');
    expect(due.paidExecutionEnabled).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM freshness_jobs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(facebook.id))
      .toEqual({ is_current: 1 });
  });

  it('does not propose a second queued job or reserve the same listing twice', () => {
    seedDemand();
    const id = seedListing('2026-09-01T00:00:00.000Z', ['FACEBOOK_GROUP']);
    const input = { listingId: id, estimatedRecords: 1, monthlyBudget: 100,
      freshnessBudgetPercent: 20, reservePercent: 10, now };
    expect(reserveBrightDataRecords(db, input)).toBe(true);
    expect(reserveBrightDataRecords(db, input)).toBe(false);
    const report = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 100,
      freshnessBudgetPercent: 20, reservePercent: 10, now }).plan();
    expect(report.proposed).toHaveLength(0);
    expect(report.skipReasons['freshness job already queued or running']).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 1 });
  });

  it('does not schedule a listing without a current canonical source', () => {
    seedDemand();
    const id = seedListing('2026-09-01T00:00:00.000Z');
    db.prepare('UPDATE canonical_listing_source_occurrences SET is_current=0 WHERE listing_id=?').run(id);
    const report = new FreshnessScheduler(db, { monthlyBrightDataRecordBudget: 100,
      freshnessBudgetPercent: 20, reservePercent: 10, now }).plan();
    expect(report.proposed).toHaveLength(0);
    expect(report.skipReasons['no current canonical source occurrence']).toBe(1);
  });

  it('previews Khmer24 staging without writes, then stores a bounded free job with provenance', () => {
    seedDemand();
    const khmer = seedListing('2026-09-01T00:00:00Z', ['FACEBOOK_GROUP', 'KHMER24']);
    seedListing('2026-09-01T00:00:00Z', ['FACEBOOK_GROUP']);
    const config = { monthlyBrightDataRecordBudget: 100, freshnessBudgetPercent: 50, reservePercent: 0, now };
    const preview = stageCanonicalKhmer24Freshness(db, config);
    expect(preview).toMatchObject({ mode: 'DRY_RUN', considered: 1, deferred: 0, stagedIds: [] });
    expect(preview.eligible).toEqual([expect.objectContaining({ listingId: khmer, provider: 'KHMER24' })]);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 0 });

    const staged = stageCanonicalKhmer24Freshness(db, config, { apply: true });
    expect(staged.mode).toBe('STAGED');
    expect(staged.stagedIds).toHaveLength(1);
    const row = db.prepare('SELECT * FROM freshness_jobs WHERE id=?').get(staged.stagedIds[0]) as Record<string, unknown>;
    expect(row).toMatchObject({ listing_id: khmer, provider: 'KHMER24', check_type: 'SOURCE_RECHECK',
      status: 'QUEUED', scheduled_at: now.toISOString(), estimated_records: 0, estimated_cost: 0,
      priority: staged.eligible[0].priority, source_occurrence_id: staged.eligible[0].sourceOccurrenceId });
    expect(JSON.parse(row.reason as string)).toEqual(staged.eligible[0].reason);
    expect(stageCanonicalKhmer24Freshness(db, config, { apply: true }).stagedIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 1 });
  });

  it('rejects untrusted or missing Khmer24 URLs and respects a conflicting paid job', () => {
    seedDemand();
    const badUrl = seedListing('2026-09-01T00:00:00Z');
    const missingUrl = seedListing('2026-09-01T00:00:00Z');
    const busy = seedListing('2026-09-01T00:00:00Z');
    db.prepare('UPDATE canonical_listing_source_occurrences SET source_url=? WHERE listing_id=?')
      .run('https://www.khmer24.com.attacker.invalid/ad', badUrl);
    db.prepare('UPDATE canonical_listing_source_occurrences SET source_url=NULL WHERE listing_id=?').run(missingUrl);
    db.prepare(`INSERT INTO freshness_jobs(listing_id,check_type,provider,scheduled_at,status,estimated_records)
      VALUES(?,'SOURCE_RECHECK','BRIGHTDATA',?,'QUEUED',1)`).run(busy, now.toISOString());
    const result = stageCanonicalKhmer24Freshness(db, {
      monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0, now,
    }, { apply: true });
    expect(result.stagedIds).toEqual([]);
    expect(result.skipped).toEqual([
      { listingId: badUrl, reason: 'missing or untrusted Khmer24 URL' },
      { listingId: missingUrl, reason: 'missing or untrusted Khmer24 URL' },
    ]);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 1 });
  });

  it('stages due Khmer24 confirmation even after a Facebook rediscovery, then executes with a fake fetcher', async () => {
    seedDemand();
    const id = seedListing('2026-09-01T00:00:00Z', ['FACEBOOK_GROUP', 'KHMER24']);
    const bindings = db.prepare(`SELECT o.id,o.source_item_id,r.source_type
      FROM canonical_listing_source_occurrences o JOIN source_registry r ON r.id=o.source_registry_id
      WHERE o.listing_id=?`).all(id) as Array<{ id: number; source_item_id: number; source_type: string }>;
    const khmer = bindings.find((row) => row.source_type === 'KHMER24')!;
    const facebook = bindings.find((row) => row.source_type === 'FACEBOOK_GROUP')!;
    expect(applyCanonicalSourceCheckResult(db, { occurrenceId: khmer.id, observationId: 'stager-first-terminal',
      checkedAt: '2026-10-06T18:00:00Z', outcome: 'DEAD' })).toBe('pending_confirmation');
    new SourceIngestionRepository(db).recordNaturalRediscovery(facebook.source_item_id, '2026-10-07T00:00:00Z');
    const at = new Date('2026-10-07T00:01:00Z');
    const result = stageCanonicalKhmer24Freshness(db, {
      monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0, now: at,
    }, { apply: true });
    expect(result.stagedIds).toHaveLength(1);
    expect(result.eligible[0].reason).toContain('due Khmer24 terminal confirmation');
    const fetcher = jest.fn(async () => ({ outcome: 'ALIVE' as const }));
    const worker = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher, now: () => at });
    expect(await worker.runOne()).toMatchObject({ status: 'completed', jobId: result.stagedIds[0], disposition: 'recorded' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(khmer.id))
      .toEqual({ is_current: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM availability_checks WHERE source_occurrence_id=?').get(khmer.id))
      .toEqual({ n: 2 });
  });

  it('limits staging to small batches and never queues fresh or no-longer-current sources', () => {
    seedDemand();
    const stale = seedListing('2026-09-01T00:00:00Z');
    const removed = seedListing('2026-09-01T00:00:00Z');
    seedListing('2026-10-06T00:00:00Z');
    db.prepare('UPDATE canonical_listing_source_occurrences SET is_current=0 WHERE listing_id=?').run(removed);
    const config = { monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0, now };
    expect(() => stageCanonicalKhmer24Freshness(db, config, { limit: 26 })).toThrow('limit must be 1-25');
    expect(stageCanonicalKhmer24Freshness(db, config, { limit: 1 })).toMatchObject({
      considered: 1, deferred: 0, eligible: [expect.objectContaining({ listingId: stale })], stagedIds: [],
    });
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 0 });
  });

  it('defers excess Khmer24 candidates and advances to the next batch without duplicating work', () => {
    seedDemand();
    const first = seedListing('2026-09-01T00:00:00Z');
    const second = seedListing('2026-09-01T00:00:00Z');
    const config = { monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0, now };
    expect(stageCanonicalKhmer24Freshness(db, config, { limit: 1 })).toMatchObject({
      mode: 'DRY_RUN', considered: 1, deferred: 1,
      eligible: [expect.objectContaining({ listingId: first })], stagedIds: [],
    });
    const firstBatch = stageCanonicalKhmer24Freshness(db, config, { apply: true, limit: 1 });
    expect(firstBatch.stagedIds).toHaveLength(1);
    expect(firstBatch.deferred).toBe(1);
    const secondBatch = stageCanonicalKhmer24Freshness(db, config, { apply: true, limit: 1 });
    expect(secondBatch).toMatchObject({ considered: 1, deferred: 0,
      eligible: [expect.objectContaining({ listingId: second })] });
    expect(secondBatch.stagedIds).toHaveLength(1);
    expect(stageCanonicalKhmer24Freshness(db, config, { apply: true, limit: 1 }).stagedIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 2 });
  });

  it('rolls back all staged jobs if a later insertion fails', () => {
    seedDemand();
    seedListing('2026-09-01T00:00:00Z');
    const blocked = seedListing('2026-09-01T00:00:00Z');
    const config = { monthlyBrightDataRecordBudget: 0, freshnessBudgetPercent: 0, reservePercent: 0, now };
    db.exec(`CREATE TRIGGER reject_second_freshness_job BEFORE INSERT ON freshness_jobs
      WHEN NEW.listing_id = ${blocked}
      BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END;`);
    expect(() => stageCanonicalKhmer24Freshness(db, config, { apply: true }))
      .toThrow('fixture insertion failure');
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM freshness_jobs').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER reject_second_freshness_job');
    expect(stageCanonicalKhmer24Freshness(db, config, { apply: true }).stagedIds).toHaveLength(2);
  });
});
