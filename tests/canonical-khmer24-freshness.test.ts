import { DatabaseSync } from 'node:sqlite';
import { backfillKhmer24TerminalConfirmations, runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import {
  CanonicalKhmer24FreshnessExecutor,
  CanonicalKhmer24FreshnessPlanner,
  type CanonicalKhmer24FreshnessPlanItem,
} from '../src/modules/parser/canonical-khmer24-freshness';
import {
  describeKhmer24FetchFailure,
  Khmer24HttpFallbackError,
  Khmer24HttpResponseError,
  Khmer24HttpTransportError,
  type Khmer24FetchDiagnostic,
} from '../src/modules/parser/khmer24-http';

describe('Canonical Khmer24 freshness', () => {
  let db: DatabaseSync;
  let sequence = 0;
  const now = new Date('2026-10-09T00:00:00.000Z');

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    sequence = 0;
  });
  afterEach(() => db.close());

  function seedListing(input: {
    review?: 'approved' | 'pending' | 'rejected';
    offerType?: 'rent' | 'sale';
    lastSeen?: string;
    sourceType?: 'KHMER24' | 'FACEBOOK_GROUP';
    outOfArea?: boolean;
  } = {}): { listingId: number; occurrenceId: number; sourceItemId: number; publicRef: string; sourceUrl: string } {
    const index = ++sequence;
    const lastSeen = input.lastSeen ?? '2026-09-01T00:00:00.000Z';
    const sourceType = input.sourceType ?? 'KHMER24';
    const publicRef = `lst_${String(index).padStart(32, '0')}`;
    const sourceUrl = `https://www.khmer24.com/post-adid-${1000 + index}`;
    const description = input.outOfArea ? 'Apartment for rent in Phnom Penh' : 'Apartment for rent in Wat Bo';
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings(
      public_ref,status,availability_status,price,currency,title,description,category,bedrooms,city,sangkat,
      first_seen_at,last_seen_at,listing_facts_json
    ) VALUES(?,'active','unknown',400,'USD',?,?,'apartment',1,'siem_reap',?,?,?,?)`)
      .run(publicRef, `Fixture ${index}`, description, input.outOfArea ? 'Phnom Penh' : 'Wat Bo', lastSeen, lastSeen,
        JSON.stringify({ offer_type: input.offerType ?? 'rent' })).lastInsertRowid);
    const registryId = Number(db.prepare(`INSERT INTO source_registry(source_key,source_type,external_source_id,name,city)
      VALUES(?,?,?,?,?)`).run(`${sourceType.toLowerCase()}:${index}`, sourceType, `fixture-${index}`, sourceType, 'siem_reap').lastInsertRowid);
    const sourceItemId = Number(db.prepare(`INSERT INTO source_items(
      source_registry_id,source_type,external_id,canonical_url,source_url,raw_text,raw_payload_json,classification,first_seen_at,last_seen_at
    ) VALUES(?,?,?,?,?,?,?,'HOUSING_SUPPLY',?,?)`)
      .run(registryId, sourceType, `fixture-${index}`, sourceUrl, sourceUrl, 'Apartment for rent in Wat Bo', '{}', lastSeen, lastSeen).lastInsertRowid);
    const occurrenceId = Number(db.prepare(`INSERT INTO canonical_listing_source_occurrences(
      source_item_id,listing_id,source_registry_id,external_id,source_url,first_seen_at,last_seen_at,source_entity_key
    ) VALUES(?,?,?,?,?,?,?,'canonical-dedupe-v1')`)
      .run(sourceItemId, listingId, registryId, `fixture-${index}`, sourceUrl, lastSeen, lastSeen).lastInsertRowid);
    db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=? WHERE id=?').run(occurrenceId, listingId);
    db.prepare(`INSERT INTO canonical_listing_moderation(listing_id,review_status,decision_origin)
      VALUES(?,?, 'EXPLICIT_CANONICAL')`).run(listingId, input.review ?? 'approved');
    return { listingId, occurrenceId, sourceItemId, publicRef, sourceUrl };
  }

  function addSavedFilter(): void {
    const userId = Number(db.prepare('INSERT INTO users(telegram_id) VALUES(?)').run(700000 + sequence).lastInsertRowid);
    db.prepare(`INSERT INTO search_filters(user_id,type,locations,city,is_active) VALUES(?,'rent','[]','siem_reap',1)`)
      .run(userId);
  }

  function addDirectInterest(listingId: number): void {
    const userId = Number(db.prepare('INSERT INTO users(telegram_id) VALUES(?)').run(800000 + sequence).lastInsertRowid);
    db.prepare(`INSERT INTO listing_interests(id,user_id,listing_id,search_context_json) VALUES('int_test',?,?, '{}')`)
      .run(userId, listingId);
    db.prepare(`INSERT INTO interest_requests(id,interest_id,user_id,listing_id,status) VALUES('req_test','int_test',?,?,'active')`)
      .run(userId, listingId);
  }

  it('uses the public catalog predicate and only plans a current Khmer24 occurrence', () => {
    const rental = seedListing();
    seedListing({ review: 'rejected' });
    seedListing({ review: 'pending' });
    seedListing({ offerType: 'sale' });
    seedListing({ outOfArea: true });
    seedListing({ sourceType: 'FACEBOOK_GROUP' });
    addSavedFilter();

    const plan = new CanonicalKhmer24FreshnessPlanner(db, { now, topNPerSavedFilter: 5 }).plan();

    expect(plan.proposed).toHaveLength(1);
    expect(plan.proposed[0]).toMatchObject({
      listingId: rental.listingId,
      publicRef: rental.publicRef,
      occurrenceId: rental.occurrenceId,
      sourceUrl: rental.sourceUrl,
    });
    expect(plan.proposed[0]?.reasons).toContain('active saved-filter top-5 match (1)');
  });

  it('raises priority only for the exact Phase 7A interest listing', () => {
    const interested = seedListing({ lastSeen: '2026-10-01T00:00:00.000Z' });
    const other = seedListing({ lastSeen: '2026-10-01T00:00:00.000Z' });
    addDirectInterest(interested.listingId);

    const plan = new CanonicalKhmer24FreshnessPlanner(db, { now }).plan();

    expect(plan.activeDirectInterestRequests).toBe(1);
    expect(plan.proposed).toHaveLength(2);
    const interestedItem = plan.proposed.find((item) => item.listingId === interested.listingId);
    const otherItem = plan.proposed.find((item) => item.listingId === other.listingId);
    expect(interestedItem?.reasons).toContain('exact Phase 7A interest request (1)');
    expect(otherItem?.reasons).not.toContain('exact Phase 7A interest request (1)');
    expect(interestedItem?.priority).toBeGreaterThan(otherItem?.priority ?? 0);
  });

  it('records ALIVE canonically, does not write legacy rows, and is idempotent for one plan key', async () => {
    const listing = seedListing();
    const planItem: CanonicalKhmer24FreshnessPlanItem = {
      planKey: `k24:${listing.occurrenceId}:2026-09-01T00:00:00.000Z`,
      listingId: listing.listingId,
      publicRef: listing.publicRef,
      occurrenceId: listing.occurrenceId,
      sourceUrl: listing.sourceUrl,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      priority: 90,
      reasons: ['fixture'],
    };
    const executor = new CanonicalKhmer24FreshnessExecutor(db);
    const legacyDigestBefore = JSON.stringify(db.prepare('SELECT id,hash,updated_at FROM properties ORDER BY id').all());
    let fetchCalls = 0;
    const disabled = await executor.execute([planItem], { fetchHtml: async () => { fetchCalls++; return ''; } });
    const first = await executor.execute([planItem], {
      maxItems: 1,
      minDelayMs: 0,
      now: () => now,
      fetchHtml: async () => { fetchCalls++; return '<script type="application/ld+json">{"@type":"Product"}</script>'; },
    });
    const second = await executor.execute([planItem], {
      maxItems: 1,
      minDelayMs: 0,
      now: () => now,
      fetchHtml: async () => { fetchCalls++; return '<script type="application/ld+json">{"@type":"Product"}</script>'; },
    });

    expect(disabled).toMatchObject({ disabled: true, checked: 0 });
    expect(first).toMatchObject({ checked: 1, alive: 1, removed: 0, unknown: 0 });
    expect(second).toMatchObject({ checked: 0, skipped: 1 });
    expect(fetchCalls).toBe(1);
    expect(db.prepare('SELECT result FROM availability_checks').all()).toEqual([{ result: 'ALIVE' }]);
    expect(db.prepare('SELECT availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listing.listingId))
      .toEqual({ availability_last_confirmed_at: now.toISOString() });
    expect(JSON.stringify(db.prepare('SELECT id,hash,updated_at FROM properties ORDER BY id').all())).toBe(legacyDigestBefore);
  });

  it('records REMOVED as an observation and leaves canonical availability unchanged', async () => {
    const listing = seedListing();
    const planItem: CanonicalKhmer24FreshnessPlanItem = {
      planKey: `k24:${listing.occurrenceId}:2026-09-01T00:00:00.000Z`,
      listingId: listing.listingId,
      publicRef: listing.publicRef,
      occurrenceId: listing.occurrenceId,
      sourceUrl: listing.sourceUrl,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      priority: 90,
      reasons: ['fixture'],
    };
    const result = await new CanonicalKhmer24FreshnessExecutor(db).execute([planItem], {
      maxItems: 1,
      minDelayMs: 0,
      now: () => now,
      fetchHtml: async () => 'This ad is no longer available',
    });

    expect(result).toMatchObject({ checked: 1, removed: 1 });
    expect(db.prepare('SELECT availability_status FROM canonical_listings WHERE id=?').get(listing.listingId))
      .toEqual({ availability_status: 'unknown' });
    expect(db.prepare('SELECT result FROM availability_checks').all()).toEqual([{ result: 'REMOVED' }]);
  });

  it('ends a source occurrence only after a later terminal confirmation window', async () => {
    const listing = seedListing();
    const base = {
      listingId: listing.listingId, publicRef: listing.publicRef, occurrenceId: listing.occurrenceId,
      sourceUrl: listing.sourceUrl, lastSeenAt: '2026-09-01T00:00:00.000Z', priority: 90, reasons: ['fixture'],
    };
    const executor = new CanonicalKhmer24FreshnessExecutor(db);
    await executor.execute([{ ...base, planKey: 'first-terminal' }], {
      maxItems: 1, minDelayMs: 0, now: () => now,
      fetchHtml: async () => 'This ad is no longer available',
    });
    expect(db.prepare('SELECT availability_status,status FROM canonical_listings WHERE id=?').get(listing.listingId))
      .toEqual({ availability_status: 'unknown', status: 'active' });
    await executor.execute([{ ...base, planKey: 'second-terminal' }], {
      maxItems: 1, minDelayMs: 0, now: () => new Date(now.getTime() + 6 * 60 * 60 * 1_000),
      fetchHtml: async () => 'This ad is no longer available',
    });
    expect(db.prepare('SELECT availability_status,status FROM canonical_listings WHERE id=?').get(listing.listingId))
      .toEqual({ availability_status: 'removed', status: 'inactive' });
    expect(db.prepare('SELECT is_current,ended_at FROM canonical_listing_source_occurrences WHERE id=?').get(listing.occurrenceId))
      .toEqual({ is_current: 0, ended_at: '2026-10-09T06:00:00.000Z' });
  });

  it('backfills a pre-v52 terminal observation as pending and rediscovery cancels it', () => {
    const listing = seedListing();
    db.prepare(`INSERT INTO availability_checks(listing_id,source_occurrence_id,check_type,provider,previous_status,new_status,result,checked_at)
      VALUES(?,?,'SOURCE_RECHECK','KHMER24','unknown','unknown','REMOVED','2026-10-09T01:00:00.000Z')`)
      .run(listing.listingId, listing.occurrenceId);
    expect(backfillKhmer24TerminalConfirmations(db)).toBe(1);
    expect(db.prepare(`SELECT consecutive_terminal_checks,terminal_check_last_seen_at,terminal_check_confirm_after_at,next_check_at
      FROM canonical_listing_source_occurrences WHERE id=?`).get(listing.occurrenceId)).toEqual({
      consecutive_terminal_checks: 1,
      terminal_check_last_seen_at: '2026-09-01T00:00:00.000Z',
      terminal_check_confirm_after_at: '2026-10-09T07:00:00.000Z',
      next_check_at: '2026-10-09T07:00:00.000Z',
    });
    expect(db.prepare('SELECT status,availability_status FROM canonical_listings WHERE id=?').get(listing.listingId))
      .toEqual({ status: 'active', availability_status: 'unknown' });
    new SourceIngestionRepository(db).recordNaturalRediscovery(listing.sourceItemId, '2026-10-09T02:00:00.000Z');
    expect(db.prepare(`SELECT consecutive_terminal_checks,terminal_check_last_seen_at,terminal_check_confirm_after_at,next_check_at
      FROM canonical_listing_source_occurrences WHERE id=?`).get(listing.occurrenceId)).toEqual({
      consecutive_terminal_checks: 0,
      terminal_check_last_seen_at: null,
      terminal_check_confirm_after_at: null,
      next_check_at: null,
    });
  });

  it('uses and closes a supplied browser transport once for a bounded batch', async () => {
    const listing = seedListing();
    const planItem: CanonicalKhmer24FreshnessPlanItem = {
      planKey: `k24:${listing.occurrenceId}:2026-09-01T00:00:00.000Z`, listingId: listing.listingId,
      publicRef: listing.publicRef, occurrenceId: listing.occurrenceId, sourceUrl: listing.sourceUrl,
      lastSeenAt: '2026-09-01T00:00:00.000Z', priority: 90, reasons: ['fixture'],
    };
    const calls: string[] = [];
    const transport = {
      fetchHtml: async (url: string) => { calls.push(`fetch:${url}`); return '<script type="application/ld+json">{"@type":"Product"}</script>'; },
      close: async () => { calls.push('close'); },
    };

    const report = await new CanonicalKhmer24FreshnessExecutor(db).execute([planItem], {
      maxItems: 1, minDelayMs: 0, now: () => now, transport,
    });

    expect(report).toMatchObject({ checked: 1, alive: 1 });
    expect(calls).toEqual([`fetch:${listing.sourceUrl}`, 'close']);
  });

  it('records malformed pages and transport failures as UNKNOWN without changing availability', async () => {
    const malformed = seedListing();
    const blocked = seedListing();
    const plan = [malformed, blocked].map((listing) => ({
      planKey: `k24:${listing.occurrenceId}:2026-09-01T00:00:00.000Z`,
      listingId: listing.listingId,
      publicRef: listing.publicRef,
      occurrenceId: listing.occurrenceId,
      sourceUrl: listing.sourceUrl,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      priority: 90,
      reasons: ['fixture'],
    }));
    const result = await new CanonicalKhmer24FreshnessExecutor(db).execute(plan, {
      maxItems: 2,
      minDelayMs: 0,
      now: () => now,
      fetchHtml: async (url) => {
        if (url === blocked.sourceUrl) throw new Khmer24HttpFallbackError('Khmer24 returned HTTP 403');
        return '<html><body>temporary upstream response</body></html>';
      },
    });

    expect(result).toMatchObject({ checked: 2, unknown: 2, removed: 0 });
    expect(db.prepare('SELECT result FROM availability_checks ORDER BY source_occurrence_id').all())
      .toEqual([{ result: 'UNKNOWN' }, { result: 'UNKNOWN' }]);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listings WHERE availability_status=\'unknown\'').get())
      .toEqual({ count: 2 });
  });

  it('extracts safe, actionable transport diagnostics from synthetic fetch errors', () => {
    const networkError = (message: string, cause: Record<string, unknown>): Error & { cause: Record<string, unknown> } => {
      const error = new Error(message) as Error & { cause: Record<string, unknown> };
      error.cause = cause;
      return error;
    };
    const cases: Array<[string, unknown, Khmer24FetchDiagnostic['category']]> = [
      ['DNS', networkError('fetch failed', { name: 'Error', message: 'getaddrinfo ENOTFOUND www.khmer24.com', code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'www.khmer24.com' }), 'DNS'],
      ['reset', networkError('fetch failed', { name: 'Error', message: 'socket hang up', code: 'ECONNRESET' }), 'CONNECTION_RESET'],
      ['timeout', networkError('fetch failed', { name: 'ConnectTimeoutError', message: 'Connect Timeout Error', code: 'UND_ERR_CONNECT_TIMEOUT' }), 'CONNECT_TIMEOUT'],
      ['TLS', networkError('fetch failed', { name: 'Error', message: 'self signed certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'TLS'],
      ['abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'ABORTED'],
    ];

    for (const [, error, category] of cases) {
      const diagnostic = describeKhmer24FetchFailure(error);
      expect(diagnostic.category).toBe(category);
      expect(diagnostic.error).toEqual(expect.objectContaining({ name: expect.any(String), message: expect.any(String) }));
    }
    const dns = describeKhmer24FetchFailure(cases[0]?.[1]);
    expect(dns.cause).toEqual(expect.objectContaining({ code: 'ENOTFOUND', hostname: 'www.khmer24.com', syscall: 'getaddrinfo' }));
  });

  it('keeps transport and 403 UNKNOWN, while 404/410 are REMOVED observations only', async () => {
    const diagnostics: Khmer24FetchDiagnostic[] = [
      { category: 'DNS', error: { name: 'TypeError', message: 'fetch failed' }, cause: { code: 'ENOTFOUND', hostname: 'www.khmer24.com' } },
      { category: 'CONNECTION_RESET', error: { name: 'TypeError', message: 'fetch failed' }, cause: { code: 'ECONNRESET' } },
      { category: 'CONNECT_TIMEOUT', error: { name: 'TimeoutError', message: 'timed out' } },
      { category: 'REQUEST_TIMEOUT', error: { name: 'TimeoutError', message: 'Khmer24 request timed out after 20000ms' } },
      { category: 'TLS', error: { name: 'TypeError', message: 'certificate verify failed' }, cause: { code: 'CERT_HAS_EXPIRED' } },
      { category: 'ABORTED', error: { name: 'AbortError', message: 'aborted' } },
    ];
    const listings = Array.from({ length: 9 }, () => seedListing());
    const plan = listings.map((listing) => ({
      planKey: `k24:${listing.occurrenceId}:2026-09-01T00:00:00.000Z`,
      listingId: listing.listingId,
      publicRef: listing.publicRef,
      occurrenceId: listing.occurrenceId,
      sourceUrl: listing.sourceUrl,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      priority: 90,
      reasons: ['fixture'],
    }));
    const failures: unknown[] = [
      ...diagnostics.map((diagnostic) => new Khmer24HttpTransportError(diagnostic)),
      new Khmer24HttpResponseError(403, 'https://www.khmer24.com/blocked'),
      new Khmer24HttpResponseError(404, 'https://www.khmer24.com/missing'),
      new Khmer24HttpResponseError(410, 'https://www.khmer24.com/gone'),
    ];
    let failureIndex = 0;
    const report = await new CanonicalKhmer24FreshnessExecutor(db).execute(plan, {
      maxItems: 9,
      minDelayMs: 0,
      now: () => now,
      fetchHtml: async () => { throw failures[failureIndex++]; },
    });

    expect(report).toMatchObject({ checked: 9, unknown: 7, removed: 2, alive: 0 });
    expect(report.items.slice(0, 7).every((item) => item.result === 'UNKNOWN')).toBe(true);
    expect(report.items.slice(7).map((item) => item.result)).toEqual(['REMOVED', 'REMOVED']);
    expect(report.items[0]?.evidence).toContain('DNS');
    expect(report.items[6]?.evidence).toContain('HTTP 403');
    expect(report.items[7]?.evidence).toContain('HTTP 404');
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listings WHERE availability_status=\'unknown\'').get())
      .toEqual({ count: 9 });
    const saved = db.prepare(`SELECT json_extract(raw_response,'$.diagnostic.cause.code') AS code
      FROM availability_checks WHERE source_occurrence_id=?`).get(listings[0]?.occurrenceId);
    expect(saved).toEqual({ code: 'ENOTFOUND' });
  });
});
