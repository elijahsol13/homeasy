import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository, SourceType } from '../src/database/repositories/source-ingestion.repo';
import { applyCanonicalSourceCheckResult as applyResult } from '../src/database/repositories/canonical-source-check.repo';
import type { CanonicalSourceCheckInput } from '../src/database/repositories/canonical-source-check.repo';

describe('canonical source check result lifecycle (offline)', () => {
  let db: DatabaseSync;
  let repo: SourceIngestionRepository;
  let counter: number;
  let observation: number;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    repo = new SourceIngestionRepository(db);
    counter = 0;
    observation = 0;
  });
  afterEach(() => db.close());

  function listing(status = 'active'): { id: number; publicRef: string } {
    const publicRef = `lst_${(++counter).toString(16).padStart(32, '0')}`;
    const id = Number(db.prepare(`INSERT INTO canonical_listings
      (public_ref,status,title,first_seen_at,last_seen_at,availability_status)
      VALUES(?,?,'Wat Bo flat','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','available')`)
      .run(publicRef, status).lastInsertRowid);
    return { id, publicRef };
  }

  function occurrence(listingId: number, sourceType: SourceType = 'KHMER24', existingItem?: number): { id: number; item: number } {
    const suffix = ++counter;
    const registry = existingItem === undefined
      ? repo.upsertSource({ sourceType, externalSourceId: `source-${suffix}`, name: `Source ${suffix}` })
      : (db.prepare('SELECT source_registry_id FROM source_items WHERE id=?').get(existingItem) as { source_registry_id: number }).source_registry_id;
    const item = existingItem ?? repo.upsertSourceItem(registry, { sourceType, externalId: `post-${suffix}` });
    const id = Number(db.prepare(`INSERT INTO canonical_listing_source_occurrences
      (source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
      VALUES(?,?,?,?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','canonical-dedupe-v1')`)
      .run(item, listingId, registry, `post-${suffix}`).lastInsertRowid);
    db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=COALESCE(primary_source_occurrence_id,?) WHERE id=?')
      .run(id, listingId);
    return { id, item };
  }

  const apply = (database: DatabaseSync, input: Omit<CanonicalSourceCheckInput, 'observationId'>) =>
    applyResult(database, { ...input, observationId: `test-observation-${++observation}` });
  const dead = (id: number, checkedAt: string) => apply(db, { occurrenceId: id, checkedAt, outcome: 'DEAD', reason: 'HTTP 410' });
  const alive = (id: number, checkedAt: string) => apply(db, { occurrenceId: id, checkedAt, outcome: 'ALIVE' });

  it('requires two independent Khmer24 terminal checks at least six hours apart', () => {
    const l = listing(); const o = occurrence(l.id);
    expect(dead(o.id, '2026-10-02T00:00:00Z')).toBe('pending_confirmation');
    expect(db.prepare(`SELECT consecutive_terminal_checks,terminal_check_last_seen_at,
        terminal_check_confirm_after_at,next_check_at,source_alive,is_current,last_checked_at
      FROM canonical_listing_source_occurrences WHERE id=?`).get(o.id)).toEqual({
      consecutive_terminal_checks: 1, terminal_check_last_seen_at: '2026-10-01T00:00:00.000Z',
      terminal_check_confirm_after_at: '2026-10-02T06:00:00.000Z', next_check_at: '2026-10-02T06:00:00.000Z',
      source_alive: null, is_current: 1, last_checked_at: '2026-10-02T00:00:00.000Z',
    });
    expect(dead(o.id, '2026-10-02T05:59:59Z')).toBe('pending_confirmation');
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(o.id)).toEqual({ is_current: 1 });
    expect(dead(o.id, '2026-10-02T06:00:00Z')).toBe('source_closed');
    expect(db.prepare('SELECT status,primary_source_occurrence_id,id,public_ref FROM canonical_listings WHERE id=?').get(l.id))
      .toEqual({ id: l.id, public_ref: l.publicRef, status: 'inactive', primary_source_occurrence_id: null });
    expect(db.prepare('SELECT consecutive_terminal_checks,source_alive,is_current,ended_at FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ consecutive_terminal_checks: 2, source_alive: 0, is_current: 0, ended_at: '2026-10-02T06:00:00.000Z' });
    expect(db.prepare('SELECT result FROM availability_checks ORDER BY id').all()).toEqual([
      { result: 'REMOVED' }, { result: 'REMOVED' }, { result: 'REMOVED' },
    ]);
  });

  it('deduplicates replayed checks and rejects older outcomes, including a conflicting result at the same time', () => {
    const l = listing(); const o = occurrence(l.id);
    expect(dead(o.id, '2026-10-02T00:00:00Z')).toBe('pending_confirmation');
    expect(dead(o.id, '2026-10-02T00:00:00Z')).toBe('duplicate');
    expect(alive(o.id, '2026-10-02T00:00:00Z')).toBe('duplicate');
    expect(apply(db, { occurrenceId: o.id, checkedAt: '2026-10-01T23:00:00Z', outcome: 'UNKNOWN' })).toBe('stale');
    expect(db.prepare('SELECT COUNT(*) n FROM availability_checks WHERE source_occurrence_id=?').get(o.id)).toEqual({ n: 1 });
    expect(db.prepare('SELECT consecutive_terminal_checks FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ consecutive_terminal_checks: 1 });
  });

  it('does not count a second delivery of the same physical Khmer24 observation with a new timestamp', () => {
    const l = listing(); const o = occurrence(l.id);
    const first = { occurrenceId: o.id, observationId: 'physical-fetch-42', checkedAt: '2026-10-02T00:00:00Z', outcome: 'DEAD' as const };
    expect(applyResult(db, first)).toBe('pending_confirmation');
    expect(applyResult(db, { ...first, checkedAt: '2026-10-02T08:00:00Z' })).toBe('duplicate');
    expect(db.prepare('SELECT consecutive_terminal_checks,is_current,last_checked_at FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ consecutive_terminal_checks: 1, is_current: 1, last_checked_at: '2026-10-02T00:00:00.000Z' });
    expect(db.prepare('SELECT COUNT(*) n FROM availability_checks WHERE source_occurrence_id=?').get(o.id)).toEqual({ n: 1 });
    expect(applyResult(db, { ...first, observationId: 'physical-fetch-43', checkedAt: '2026-10-02T08:00:00Z' }))
      .toBe('source_closed');
  });

  it('rejects a reused physical observation identity for a different source', () => {
    const first = occurrence(listing().id);
    const second = occurrence(listing().id);
    expect(applyResult(db, { occurrenceId: first.id, observationId: 'shared-check', checkedAt: '2026-10-02T00:00:00Z', outcome: 'ALIVE' }))
      .toBe('recorded');
    expect(() => applyResult(db, { occurrenceId: second.id, observationId: 'shared-check', checkedAt: '2026-10-02T08:00:00Z', outcome: 'DEAD' }))
      .toThrow('different occurrence');
    expect(db.prepare('SELECT COUNT(*) n FROM availability_checks').get()).toEqual({ n: 1 });
  });

  it('closes only the confirmed Khmer24 source and promotes the remaining source', () => {
    const l = listing(); const k = occurrence(l.id); const fb = occurrence(l.id, 'FACEBOOK_GROUP');
    expect(dead(k.id, '2026-10-02T00:00:00Z')).toBe('pending_confirmation');
    expect(dead(k.id, '2026-10-02T06:00:00Z')).toBe('source_closed');
    expect(db.prepare('SELECT status,primary_source_occurrence_id FROM canonical_listings WHERE id=?').get(l.id))
      .toEqual({ status: 'active', primary_source_occurrence_id: fb.id });
    expect(db.prepare('SELECT is_current FROM canonical_listing_source_occurrences WHERE id=?').get(fb.id))
      .toEqual({ is_current: 1 });
  });

  it('promotes the earliest published surviving source after two confirmed Khmer24 closure checks', () => {
    const l = listing();
    const k = occurrence(l.id);
    const repost = occurrence(l.id, 'FACEBOOK_GROUP');
    const oldest = occurrence(l.id, 'FACEBOOK_GROUP');
    db.prepare('UPDATE source_items SET published_at=? WHERE id=?').run('2026-09-01T00:00:00Z', k.item);
    db.prepare('UPDATE source_items SET published_at=? WHERE id=?').run('2026-09-20T00:00:00Z', repost.item);
    db.prepare('UPDATE source_items SET published_at=? WHERE id=?').run('2026-09-10T00:00:00Z', oldest.item);
    db.prepare('UPDATE canonical_listing_source_occurrences SET first_seen_at=? WHERE id=?')
      .run('2026-10-02T00:00:00Z', oldest.id);
    expect(dead(k.id, '2026-10-02T00:00:00Z')).toBe('pending_confirmation');
    expect(dead(k.id, '2026-10-02T06:00:00Z')).toBe('source_closed');
    expect(db.prepare('SELECT primary_source_occurrence_id,status FROM canonical_listings WHERE id=?').get(l.id))
      .toEqual({ primary_source_occurrence_id: oldest.id, status: 'active' });
  });

  it('treats Facebook dead responses and UNKNOWN results as inconclusive', () => {
    const l = listing(); const fb = occurrence(l.id, 'FACEBOOK_GROUP');
    expect(dead(fb.id, '2026-10-02T00:00:00Z')).toBe('recorded');
    expect(apply(db, { occurrenceId: fb.id, checkedAt: '2026-10-02T01:00:00Z', outcome: 'UNKNOWN' })).toBe('recorded');
    expect(db.prepare('SELECT result FROM availability_checks ORDER BY id').all())
      .toEqual([{ result: 'UNKNOWN' }, { result: 'UNKNOWN' }]);
    expect(db.prepare('SELECT is_current,consecutive_terminal_checks,source_alive FROM canonical_listing_source_occurrences WHERE id=?').get(fb.id))
      .toEqual({ is_current: 1, consecutive_terminal_checks: 0, source_alive: null });
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(l.id)).toEqual({ status: 'active' });
  });

  it('requires consecutive terminal evidence and resets pending on UNKNOWN or ALIVE', () => {
    const l = listing(); const o = occurrence(l.id);
    dead(o.id, '2026-10-02T00:00:00Z');
    expect(apply(db, { occurrenceId: o.id, checkedAt: '2026-10-02T02:00:00Z', outcome: 'UNKNOWN' })).toBe('recorded');
    expect(dead(o.id, '2026-10-02T06:00:00Z')).toBe('pending_confirmation');
    expect(db.prepare('SELECT terminal_check_confirm_after_at FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ terminal_check_confirm_after_at: '2026-10-02T12:00:00.000Z' });
    expect(alive(o.id, '2026-10-02T07:00:00Z')).toBe('recorded');
    expect(db.prepare(`SELECT consecutive_terminal_checks,terminal_check_confirm_after_at,source_alive,last_seen_at
      FROM canonical_listing_source_occurrences WHERE id=?`).get(o.id)).toEqual({
      consecutive_terminal_checks: 0, terminal_check_confirm_after_at: null, source_alive: 1,
      last_seen_at: '2026-10-01T00:00:00.000Z',
    });
    expect(dead(o.id, '2026-10-02T06:59:00Z')).toBe('stale');
    expect(dead(o.id, '2026-10-02T12:00:00Z')).toBe('pending_confirmation');
  });

  it('a new natural rediscovery prevents an old pending DEAD from closing a source', () => {
    const l = listing(); const o = occurrence(l.id);
    dead(o.id, '2026-10-02T00:00:00Z');
    repo.recordNaturalRediscovery(o.item, '2026-10-02T04:00:00Z');
    repo.recordNaturalRediscovery(o.item, '2026-10-01T21:00:00Z'); // old replay must not reverse freshness
    expect(db.prepare('SELECT last_seen_at FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ last_seen_at: '2026-10-02T04:00:00Z' });
    expect(dead(o.id, '2026-10-02T03:00:00Z')).toBe('stale');
    expect(dead(o.id, '2026-10-02T06:00:00Z')).toBe('pending_confirmation');
    expect(db.prepare('SELECT terminal_check_confirm_after_at,is_current FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ terminal_check_confirm_after_at: '2026-10-02T12:00:00.000Z', is_current: 1 });
    expect(dead(o.id, '2026-10-02T12:00:00Z')).toBe('source_closed');
  });

  it('a delayed discovery replay cannot cancel a terminal observation recorded afterward', () => {
    const l = listing(); const o = occurrence(l.id);
    repo.recordNaturalRediscovery(o.item, '2026-10-02T01:00:00Z');
    expect(dead(o.id, '2026-10-02T03:00:00Z')).toBe('pending_confirmation');
    const pending = db.prepare(`SELECT consecutive_terminal_checks,terminal_check_confirm_after_at,next_check_at
      FROM canonical_listing_source_occurrences WHERE id=?`).get(o.id);
    repo.recordNaturalRediscovery(o.item, '2026-10-02T02:00:00Z');
    expect(db.prepare(`SELECT consecutive_terminal_checks,terminal_check_confirm_after_at,next_check_at
      FROM canonical_listing_source_occurrences WHERE id=?`).get(o.id)).toEqual(pending);
  });

  it('out-of-order source replay cannot move observed freshness backward across canonical entities', () => {
    const l = listing(); const o = occurrence(l.id);
    const propertyId = Number(db.prepare(`INSERT INTO canonical_properties(city,last_observed_at)
      VALUES('siem_reap','2026-10-01T00:00:00Z')`).run().lastInsertRowid);
    db.prepare('UPDATE canonical_listings SET property_id=? WHERE id=?').run(propertyId, l.id);
    db.prepare('UPDATE source_items SET last_seen_at=? WHERE id=?').run('2026-10-01T00:00:00Z', o.item);
    const registryId = (db.prepare('SELECT source_registry_id FROM source_items WHERE id=?').get(o.item) as { source_registry_id: number }).source_registry_id;
    const externalId = (db.prepare('SELECT external_id FROM source_items WHERE id=?').get(o.item) as { external_id: string }).external_id;
    const input = { sourceType: 'KHMER24' as const, externalId, contentHash: 'freshness-replay-unchanged' };
    const newest = '2026-10-03T00:00:00Z';
    const older = '2026-10-02T00:00:00Z';
    repo.upsertSourceItem(registryId, input, newest);
    repo.recordNaturalRediscovery(o.item, newest);
    repo.upsertSourceItem(registryId, input, older);
    repo.recordNaturalRediscovery(o.item, older);
    expect(db.prepare('SELECT last_seen_at FROM source_items WHERE id=?').get(o.item)).toEqual({ last_seen_at: newest });
    expect(db.prepare('SELECT last_seen_at FROM canonical_listing_source_occurrences WHERE id=?').get(o.id))
      .toEqual({ last_seen_at: newest });
    expect(db.prepare('SELECT last_seen_at,public_ref FROM canonical_listings WHERE id=?').get(l.id))
      .toEqual({ last_seen_at: newest, public_ref: l.publicRef });
    expect(db.prepare('SELECT last_observed_at FROM canonical_properties WHERE id=?').get(propertyId))
      .toEqual({ last_observed_at: newest });
    expect(db.prepare('SELECT id FROM canonical_listing_source_occurrences WHERE listing_id=?').all(l.id))
      .toEqual([{ id: o.id }]);
  });

  it('cannot close a replacement binding of a repurposed Facebook post', () => {
    const old = listing(); const fresh = listing();
    const original = occurrence(old.id, 'FACEBOOK_GROUP');
    expect(repo.closeCurrentCanonicalBindings(original.item, 'canonical-dedupe-v1', '2026-10-02T00:00:00Z')).toBe(1);
    const newer = occurrence(fresh.id, 'FACEBOOK_GROUP', original.item);
    expect(dead(original.id, '2026-10-03T00:00:00Z')).toBe('not_current');
    expect(alive(original.id, '2026-10-03T01:00:00Z')).toBe('not_current');
    expect(db.prepare('SELECT is_current,listing_id FROM canonical_listing_source_occurrences WHERE id=?').get(newer.id))
      .toEqual({ is_current: 1, listing_id: fresh.id });
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(fresh.id)).toEqual({ status: 'active' });
  });

  it('never reactivates an archived listing', () => {
    const l = listing('archived'); const o = occurrence(l.id);
    expect(alive(o.id, '2026-10-02T00:00:00Z')).toBe('recorded');
    expect(dead(o.id, '2026-10-03T00:00:00Z')).toBe('pending_confirmation');
    expect(dead(o.id, '2026-10-03T06:00:00Z')).toBe('source_closed');
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(l.id)).toEqual({ status: 'archived' });
  });

  it('retains identity, favorites, aliases, moderation, history and first publication event', () => {
    const l = listing(); const o = occurrence(l.id);
    db.prepare('INSERT INTO users(telegram_id) VALUES(555)').run();
    const user = (db.prepare('SELECT id FROM users WHERE telegram_id=555').get() as { id: number }).id;
    db.prepare('INSERT INTO canonical_user_favorites(user_id,listing_id) VALUES(?,?)').run(user, l.id);
    db.prepare("INSERT INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('legacy_url','https://example.com/old',?)")
      .run(l.id);
    db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'pending')").run(l.id);
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved',decision_origin='EXPLICIT_CANONICAL' WHERE listing_id=?")
      .run(l.id);
    const publicationsBefore = db.prepare('SELECT COUNT(*) n FROM canonical_publication_events').get();
    dead(o.id, '2026-10-02T00:00:00Z');
    dead(o.id, '2026-10-02T06:00:00Z');
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_publication_events').get()).toEqual(publicationsBefore);
    expect(db.prepare('SELECT listing_id FROM canonical_user_favorites').all()).toEqual([{ listing_id: l.id }]);
    expect(db.prepare('SELECT listing_id FROM canonical_listing_aliases WHERE namespace=?').all('legacy_url')).toEqual([{ listing_id: l.id }]);
    expect(db.prepare('SELECT review_status FROM canonical_listing_moderation WHERE listing_id=?').get(l.id))
      .toEqual({ review_status: 'approved' });
    expect(db.prepare('SELECT COUNT(*) n FROM availability_checks').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT id,public_ref FROM canonical_listings').all()).toEqual([{ id: l.id, public_ref: l.publicRef }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('resumes the historical v52 Khmer24 terminal confirmation without counting its replay twice', () => {
    const l = listing(); const o = occurrence(l.id);
    db.prepare(`INSERT INTO availability_checks(listing_id,source_occurrence_id,check_type,provider,result,checked_at)
      VALUES(?,?,'SOURCE_RECHECK','KHMER24','REMOVED','2026-10-02T00:00:00.000Z')`).run(l.id, o.id);
    db.prepare(`UPDATE canonical_listing_source_occurrences SET consecutive_terminal_checks=1,
      terminal_check_last_seen_at=last_seen_at,terminal_check_confirm_after_at='2026-10-02T06:00:00.000Z',
      next_check_at='2026-10-02T06:00:00.000Z' WHERE id=?`).run(o.id);
    expect(dead(o.id, '2026-10-02T00:00:00Z')).toBe('duplicate');
    expect(dead(o.id, '2026-10-02T06:00:00Z')).toBe('source_closed');
  });

  it('supports an enclosing transaction and safely rejects invalid inputs', () => {
    const l = listing(); const o = occurrence(l.id);
    repo.transaction(() => {
      expect(alive(o.id, '2026-10-02T00:00:00Z')).toBe('recorded');
    });
    expect(() => dead(o.id, 'not-a-date')).toThrow('Invalid check timestamp');
    expect(() => apply(db, { occurrenceId: 0, checkedAt: '2026-10-03T00:00:00Z', outcome: 'DEAD' })).toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM availability_checks').get()).toEqual({ n: 1 });
  });
});
