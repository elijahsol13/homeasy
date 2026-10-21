import { DatabaseSync } from 'node:sqlite';
import { backfillKhmer24TerminalConfirmations, runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { CanonicalReportsRepository } from '../src/database/repositories/canonical-reports.repo';

describe('SQLite schema compatibility', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('initializes v58 on a fresh database and supports repeated startup', () => {
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 58 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='contact_grants'").get()).toEqual({ name: 'contact_grants' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='canonical_listing_reports'").get())
      .toEqual({ name: 'canonical_listing_reports' });
    expect(db.prepare('SELECT consecutive_terminal_checks FROM canonical_listing_source_occurrences').all()).toEqual([]);

    runMigrations(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 58 });
    expect(db.prepare('SELECT activated_at FROM canonical_review_alert_rollout WHERE id=1').get())
      .toEqual({ activated_at: null });
    expect(db.prepare('PRAGMA table_info(availability_checks)').all().some((column) => column.name === 'observation_id'))
      .toBe(true);
  });

  it('fails closed when the database contains a migration newer than the running code', () => {
    db.prepare('INSERT INTO schema_migrations(version) VALUES(59)').run();
    expect(() => runMigrations(db)).toThrow('migration v59 is not supported');
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 59 });
  });

  it('deduplicates canonical complaints per user without changing a colliding legacy listing', () => {
    const users = [125001, 125002].map((telegramId) => Number(db.prepare(
      'INSERT INTO users(telegram_id) VALUES(?)',
    ).run(telegramId).lastInsertRowid));
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings
      (public_ref,title,first_seen_at,last_seen_at,status,availability_status)
      VALUES('lst_'||lower(hex(randomblob(16))),'Report target','2026-10-01','2026-10-01','active','available')`)
      .run().lastInsertRowid);
    db.prepare(`INSERT INTO properties(id,hash,title,price,type,location,city,reports_count,is_active)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(listingId,'legacy-collision','Different legacy listing',30000,'rent','Center','siem_reap',0,1);
    const reports = new CanonicalReportsRepository(db);

    expect(reports.report(listingId, users[0]!)).toEqual({ added: true, total: 1 });
    expect(reports.report(listingId, users[0]!)).toEqual({ added: false, total: 1 });
    expect(reports.report(listingId, users[1]!)).toEqual({ added: true, total: 2 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM canonical_listing_reports').get()).toEqual({ total: 2 });
    expect(db.prepare('SELECT reports_count,is_active FROM properties WHERE id=?').get(listingId))
      .toEqual({ reports_count: 0, is_active: 1 });
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ status: 'active' });
  });

  it('preserves a Khmer24 REMOVED check as a pending confirmation without closing the listing', () => {
    const firstSeen = '2026-10-01T00:00:00Z';
    const checked = '2026-10-02T00:00:00Z';
    const listingId = Number(db.prepare(`
      INSERT INTO canonical_listings(public_ref,title,first_seen_at,last_seen_at,status,availability_status)
      VALUES('lst_'||lower(hex(randomblob(16))),'Test listing',?,?,'active','available')
    `).run(firstSeen, firstSeen).lastInsertRowid);
    const repo = new SourceIngestionRepository(db);
    const sourceId = repo.upsertSource({ sourceType: 'KHMER24', externalSourceId: 'migration-test', name: 'Khmer24' });
    const sourceItemId = repo.upsertSourceItemDetailed(sourceId, {
      sourceType: 'KHMER24', externalId: 'test-001', rawText: 'Test listing', contentHash: 'migration-test-001',
      classification: 'HOUSING_SUPPLY',
    }).id;
    const occurrenceId = Number(db.prepare(`
      INSERT INTO canonical_listing_source_occurrences
      (source_item_id,listing_id,source_registry_id,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?)
    `).run(sourceItemId, listingId, sourceId, firstSeen, firstSeen).lastInsertRowid);
    db.prepare(`
      INSERT INTO availability_checks(listing_id,source_occurrence_id,check_type,provider,result,checked_at)
      VALUES(?,?,'SOURCE_RECHECK','KHMER24','REMOVED',?)
    `).run(listingId, occurrenceId, checked);

    expect(backfillKhmer24TerminalConfirmations(db)).toBe(1);
    expect(db.prepare(`
      SELECT consecutive_terminal_checks,terminal_check_last_seen_at,
        terminal_check_confirm_after_at,next_check_at,is_current
      FROM canonical_listing_source_occurrences WHERE id=?
    `).get(occurrenceId)).toEqual({
      consecutive_terminal_checks: 1,
      terminal_check_last_seen_at: firstSeen,
      terminal_check_confirm_after_at: '2026-10-02T06:00:00.000Z',
      next_check_at: '2026-10-02T06:00:00.000Z',
      is_current: 1,
    });
    expect(db.prepare('SELECT status,availability_status FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ status: 'active', availability_status: 'available' });
  });
});
