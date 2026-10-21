import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { CanonicalFreshnessExecutor, safeKhmer24Url } from '../src/modules/parser/canonical-freshness-executor';
import type { CanonicalFreshnessFetcher } from '../src/modules/parser/canonical-freshness-executor';

describe('canonical free Khmer24 freshness executor (offline)', () => {
  let db: DatabaseSync;
  let repo: SourceIngestionRepository;
  let now: Date;
  let serial: number;
  const clock = () => now;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    repo = new SourceIngestionRepository(db);
    now = new Date('2026-10-07T12:00:00.000Z');
    serial = 0;
  });
  afterEach(() => db.close());

  function fixture(options: { provider?: string; type?: 'KHMER24' | 'FACEBOOK_GROUP'; url?: string; maxAttempts?: number } = {}) {
    const suffix = ++serial;
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings
      (public_ref,status,availability_status,title,first_seen_at,last_seen_at)
      VALUES(?,'active','available','House','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`)
      .run(`lst_${String(suffix).padStart(32, '0')}`).lastInsertRowid);
    const type = options.type ?? 'KHMER24';
    const registry = repo.upsertSource({ sourceType: type, externalSourceId: `source-${suffix}`, name: type });
    const item = repo.upsertSourceItem(registry, { sourceType: type, externalId: `ad-${suffix}` });
    const occurrenceId = Number(db.prepare(`INSERT INTO canonical_listing_source_occurrences
      (source_item_id,listing_id,source_registry_id,external_id,source_url,first_seen_at,last_seen_at,source_entity_key)
      VALUES(?,?,?,?,?,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','canonical-dedupe-v1')`)
      .run(item, listingId, registry, `ad-${suffix}`, options.url ?? `https://www.khmer24.com/en/ad-adid-${suffix}`).lastInsertRowid);
    const jobId = Number(db.prepare(`INSERT INTO freshness_jobs
      (listing_id,source_occurrence_id,check_type,provider,scheduled_at,status,estimated_records,max_attempts)
      VALUES(?,?,'SOURCE_RECHECK',?,'2026-10-07T11:00:00Z','QUEUED',0,?)`)
      .run(listingId, occurrenceId, options.provider ?? 'KHMER24', options.maxAttempts ?? 3).lastInsertRowid);
    return { listingId, occurrenceId, item, jobId };
  }

  const job = (id: number) => db.prepare(`SELECT status,attempts,result,observation_id,claim_token FROM freshness_jobs WHERE id=?`)
    .get(id) as { status: string; attempts: number; result: string; observation_id: string | null; claim_token: string | null };

  it('only accepts exact HTTPS Khmer24 listing URLs without parser normalization', () => {
    for (const url of [
      'https://www.khmer24.com/en/house-for-rent-adid-10802208',
      'https://www.khmer24.com/en/440-adid-13034478',
      'https://www.khmer24.com/en/villa-for-rent-_-6-rooms-_2500month-adid-13686523',
      'https://www.khmer24.com/post-adid-13984021',
      'https://khmer24.com/en/offer-adid-123/',
    ]) expect(safeKhmer24Url(url)).toBe(url);

    for (const url of [
      null, 'https://www.khmer24.com/en', 'https://www.khmer24.com/search',
      'https://www.khmer24.com/account', 'https://www.khmer24.com/en/ad',
      'https://www.khmer24.com/en/ad-adid-0', 'https://www.khmer24.com/en/ad-adid-001',
      'https://www.khmer24.com/en/ad-adid-123?track=1',
      'https://www.khmer24.com/en/ad-adid-123#fragment',
      'https://www.khmer24.com/en/../ad-adid-123',
      'https://www.khmer24.com/en/%2e%2e/ad-adid-123',
      'https://www.khmer24.com/en%2fad-adid-123',
      'https://www.khmer24.com/en\\ad-adid-123',
      'https://www.khmer24.com//en/ad-adid-123',
      'https://www.khmer24.com:443/en/ad-adid-123',
      'https://user@www.khmer24.com/en/ad-adid-123',
      'https://www.khmer24.com.evil.test/en/ad-adid-123',
      'http://www.khmer24.com/en/ad-adid-123',
      'https://www.khmer24.com/en/ad-adid-123\n',
    ]) expect(safeKhmer24Url(url)).toBeNull();
  });

  it('cancels a queued job with a non-listing URL without fetching or changing inventory', async () => {
    const { jobId, occurrenceId, listingId } = fixture({ url: 'https://www.khmer24.com/search' });
    const fetcher = jest.fn(async () => ({ outcome: 'DEAD' as const }));
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher, now: clock });
    expect(await executor.runOne()).toMatchObject({ status: 'cancelled', jobId,
      reason: 'missing or untrusted Khmer24 URL' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(occurrenceId))
      .toEqual({ is_current: 1 });
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ status: 'active' });
  });

  it('defaults to dry-run with no fetch or job mutation', async () => {
    const { jobId } = fixture();
    const fetcher = jest.fn(async () => ({ outcome: 'DEAD' as const }));
    const executor = new CanonicalFreshnessExecutor(db, { fetcher, now: clock });
    expect(await executor.runOne()).toMatchObject({ status: 'dry_run', jobId });
    expect(job(jobId)).toMatchObject({ status: 'QUEUED', attempts: 0, observation_id: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('records a successful observation once and closes no live source', async () => {
    const { jobId, occurrenceId } = fixture();
    const fetcher = jest.fn(async () => ({ outcome: 'ALIVE' as const }));
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher, now: clock });
    expect(await executor.runOne()).toMatchObject({ status: 'completed', jobId, disposition: 'recorded', replayed: false });
    expect(job(jobId)).toMatchObject({ status: 'DONE', attempts: 1, result: 'recorded', claim_token: null });
    expect(job(jobId).observation_id).toBeTruthy();
    expect(db.prepare('SELECT observation_id FROM availability_checks WHERE source_occurrence_id=?').get(occurrenceId))
      .toEqual({ observation_id: job(jobId).observation_id });
    expect(await executor.runOne()).toEqual({ status: 'idle' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires two physical DEAD observations six hours apart to close a source', async () => {
    const first = fixture();
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, now: clock,
      fetcher: async () => ({ outcome: 'DEAD' }) });
    expect(await executor.runOne()).toMatchObject({ disposition: 'pending_confirmation' });
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(first.occurrenceId))
      .toEqual({ is_current: 1 });
    const firstId = job(first.jobId).observation_id;
    db.prepare(`INSERT INTO freshness_jobs(listing_id,source_occurrence_id,check_type,provider,scheduled_at,status,estimated_records)
      VALUES(?,?,'SOURCE_RECHECK','KHMER24','2026-10-07T18:01:00Z','QUEUED',0)`)
      .run(first.listingId, first.occurrenceId);
    now = new Date('2026-10-07T18:02:00Z');
    expect(await executor.runOne()).toMatchObject({ disposition: 'source_closed' });
    expect(job(first.jobId).observation_id).toBe(firstId);
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(first.listingId))
      .toEqual({ status: 'inactive' });
    expect(db.prepare('SELECT COUNT(DISTINCT observation_id) AS n FROM availability_checks WHERE source_occurrence_id=?')
      .get(first.occurrenceId)).toEqual({ n: 2 });
  });

  it('retries thrown transport failures with a delay, then persists UNKNOWN safely', async () => {
    const { jobId } = fixture();
    const fetcher = jest.fn<ReturnType<CanonicalFreshnessFetcher>, Parameters<CanonicalFreshnessFetcher>>()
      .mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ outcome: 'UNKNOWN', reason: 'Cloudflare' });
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher, now: clock });
    expect(await executor.runOne()).toEqual({ status: 'retry_scheduled', jobId });
    expect(job(jobId)).toMatchObject({ status: 'QUEUED', attempts: 1, observation_id: null });
    expect(await executor.runOne()).toEqual({ status: 'idle' });
    now = new Date('2026-10-07T12:06:00Z');
    expect(await executor.runOne()).toMatchObject({ status: 'completed', disposition: 'recorded' });
    expect(job(jobId)).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(db.prepare('SELECT result FROM availability_checks').get()).toEqual({ result: 'UNKNOWN' });
  });

  it('does not let a retry overwrite the original queue time and hide rediscovery', async () => {
    const { jobId, item, occurrenceId } = fixture();
    const fetcher = jest.fn().mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValue({ outcome: 'DEAD' as const });
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher, now: clock });
    expect(await executor.runOne()).toEqual({ status: 'retry_scheduled', jobId });
    expect(db.prepare('SELECT scheduled_at,retry_at FROM freshness_jobs WHERE id=?').get(jobId)).toEqual({
      scheduled_at: '2026-10-07T11:00:00Z', retry_at: '2026-10-07T12:05:00.000Z',
    });
    repo.recordNaturalRediscovery(item, '2026-10-07T12:02:00Z');
    now = new Date('2026-10-07T12:06:00Z');
    expect(await executor.runOne()).toMatchObject({ status: 'cancelled', jobId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(occurrenceId))
      .toEqual({ is_current: 1 });
  });

  it('replays a durable result after worker death without a second fetch', async () => {
    const { jobId } = fixture();
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true,
      fetcher: jest.fn(async () => ({ outcome: 'ALIVE' as const })), now: clock, leaseMs: 10_000 });
    const claim = executor.claimNext();
    if (!claim || 'status' in claim) throw new Error('Missing claim');
    expect(executor.recordObservation(claim, { outcome: 'DEAD' })).toBe(true);
    const physicalObservation = job(jobId).observation_id;
    now = new Date('2026-10-07T12:00:11Z');
    expect(await executor.runOne()).toMatchObject({ status: 'completed', disposition: 'pending_confirmation', replayed: true });
    expect(job(jobId)).toMatchObject({ status: 'DONE', attempts: 1, observation_id: physicalObservation });
    expect(db.prepare('SELECT observation_id FROM availability_checks').get()).toEqual({ observation_id: physicalObservation });
    expect(executor.settle(claim)).toEqual({ status: 'lost_claim', jobId });
  });

  it('fences a worker when a crashed/expired claim is reclaimed', async () => {
    const { jobId } = fixture();
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher: async () => ({ outcome: 'ALIVE' }),
      now: clock, leaseMs: 10_000 });
    const old = executor.claimNext();
    if (!old || 'status' in old) throw new Error('Missing first claim');
    now = new Date('2026-10-07T12:00:11Z');
    const fresh = executor.claimNext();
    if (!fresh || 'status' in fresh) throw new Error('Missing re-claim');
    expect(fresh.claimToken).not.toEqual(old.claimToken);
    expect(executor.recordObservation(old, { outcome: 'DEAD' })).toBe(false);
    expect(executor.recordObservation(fresh, { outcome: 'ALIVE' })).toBe(true);
    expect(executor.settle(fresh)).toMatchObject({ disposition: 'recorded' });
    expect(job(jobId)).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(db.prepare('SELECT result FROM availability_checks').get()).toEqual({ result: 'ALIVE' });
  });

  it('rejects untrusted URLs, replaced bindings and non-free providers before fetching', async () => {
    const untrusted = fixture({ url: 'https://www.khmer24.com.attacker.test/deleted' });
    const replaced = fixture();
    db.prepare('UPDATE canonical_listing_source_occurrences SET is_current=0 WHERE id=?').run(replaced.occurrenceId);
    const paid = fixture({ provider: 'BRIGHTDATA', type: 'FACEBOOK_GROUP' });
    const fetcher = jest.fn(async () => ({ outcome: 'DEAD' as const }));
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, fetcher, now: clock });
    expect(await executor.runOne()).toMatchObject({ status: 'cancelled', jobId: untrusted.jobId });
    expect(await executor.runOne()).toMatchObject({ status: 'cancelled', jobId: replaced.jobId });
    expect(await executor.runOne()).toEqual({ status: 'idle' });
    expect(job(paid.jobId).status).toBe('QUEUED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not close a newly rediscovered source from an in-flight stale result', async () => {
    const { jobId, item, occurrenceId } = fixture();
    const executor = new CanonicalFreshnessExecutor(db, { enabled: true, now: clock,
      fetcher: async () => {
        repo.recordNaturalRediscovery(item, '2026-10-07T12:01:00Z');
        return { outcome: 'DEAD' };
      } });
    expect(await executor.runOne()).toMatchObject({ status: 'completed', jobId, disposition: 'stale' });
    expect(job(jobId).status).toBe('CANCELLED');
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(occurrenceId))
      .toEqual({ is_current: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM availability_checks').get()).toEqual({ n: 0 });
  });
});
