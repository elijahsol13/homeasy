import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';

describe('SourceIngestionRepository', () => {
  let db: DatabaseSync;
  let repo: SourceIngestionRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    repo = new SourceIngestionRepository(db);
  });

  afterEach(() => db.close());

  it('applies the full migration set idempotently without touching legacy properties', () => {
    runMigrations(db);
    const versions = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
    expect(versions.version).toBe(58);
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='properties'").get();
    expect(legacy).toBeDefined();
    const canonical = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_listings'").get();
    expect(canonical).toBeDefined();
  });

  it('requires immutable opaque public refs on canonical listings', () => {
    const publicRefColumn=db.prepare('PRAGMA table_info(canonical_listings)').all().find((row)=>row.name==='public_ref') as {notnull:number}|undefined;
    expect(publicRefColumn?.notnull).toBe(1);
    const ref='lst_0123456789abcdef0123456789abcdef';
    db.prepare(`INSERT INTO canonical_listings(public_ref,title,first_seen_at,last_seen_at) VALUES(?,?,?,?)`).run(ref,'Fixture','2026-10-01','2026-10-01');
    expect(()=>db.prepare('UPDATE canonical_listings SET public_ref=? WHERE public_ref=?').run('lst_fedcba9876543210fedcba9876543210',ref)).toThrow(/immutable/);
    expect(()=>db.prepare(`INSERT INTO canonical_listings(title,first_seen_at,last_seen_at) VALUES('No ref','2026-10-01','2026-10-01')`).run()).toThrow(/required/);
  });

  it('upserts source items idempotently and records a version when content changes', () => {
    const sourceId = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'g-123', name: 'Rentals' });
    const firstId = repo.upsertSourceItem(sourceId, {
      sourceType: 'FACEBOOK_GROUP', externalId: 'post-1', rawText: '1BR, $300', contentHash: 'v1',
      rawPayload: { text: '1BR, $300' },
    });
    const sameId = repo.upsertSourceItem(sourceId, {
      sourceType: 'FACEBOOK_GROUP', externalId: 'post-1', rawText: '1BR, $300', contentHash: 'v1',
      rawPayload: { text: '1BR, $300' },
    });
    expect(sameId).toBe(firstId);

    repo.upsertSourceItem(sourceId, {
      sourceType: 'FACEBOOK_GROUP', externalId: 'post-1', rawText: '1BR, $350', contentHash: 'v2',
      rawPayload: { text: '1BR, $350' },
    }, '2026-10-07T00:00:00.000Z');

    const itemCount = db.prepare('SELECT COUNT(*) AS count FROM source_items').get() as { count: number };
    const version = db.prepare('SELECT content_hash, raw_text FROM source_item_versions WHERE source_item_id = ?').get(firstId) as {
      content_hash: string; raw_text: string;
    };
    expect(itemCount.count).toBe(1);
    expect(version).toEqual({ content_hash: 'v1', raw_text: '1BR, $300' });
  });

  it('records a new source item version when media changes without a text change', () => {
    const sourceId=repo.upsertSource({sourceType:'FACEBOOK_GROUP',externalSourceId:'g-media',name:'Rentals'});
    const itemId=repo.upsertSourceItem(sourceId,{sourceType:'FACEBOOK_GROUP',externalId:'post-media',rawText:'1BR, $300',contentHash:'same-text',mediaHash:null,rawPayload:{photos:[]}});
    repo.upsertSourceItem(sourceId,{sourceType:'FACEBOOK_GROUP',externalId:'post-media',rawText:'1BR, $300',contentHash:'same-text',mediaHash:'photos-v1',rawPayload:{photos:['https://img.example/a.jpg']}});
    const versions=db.prepare('SELECT content_hash,media_hash,raw_payload_json FROM source_item_versions WHERE source_item_id=? ORDER BY id').all(itemId) as Array<{content_hash:string;media_hash:string|null;raw_payload_json:string}>;
    expect(versions).toHaveLength(2);
    expect(versions.map((entry)=>entry.media_hash)).toEqual([null,'photos-v1']);
  });

  it('rolls back all writes in a failed repository transaction', () => {
    expect(() => repo.transaction(() => {
      repo.upsertSource({ sourceType: 'KHMER24', externalSourceId: 'cat-1', name: 'Siem Reap' });
      throw new Error('abort');
    })).toThrow('abort');
    const row = db.prepare('SELECT COUNT(*) AS count FROM source_registry').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('keeps identifiers unique and replaceable on replay', () => {
    const sourceId = repo.upsertSource({ sourceType: 'MANUAL', externalSourceId: 'admin', name: 'Manual' });
    const itemId = repo.upsertSourceItem(sourceId, { sourceType: 'MANUAL', externalId: 'item-1' });
    repo.replaceIdentifiers(itemId, [
      { type: 'PHONE', rawValue: '+855 12 345 678', normalizedValue: '+85512345678' },
      { type: 'PHONE', rawValue: '012 345 678', normalizedValue: '+85512345678' },
    ]);
    repo.replaceIdentifiers(itemId, [
      { type: 'TELEGRAM', rawValue: '@owner', normalizedValue: 'owner' },
    ]);
    const rows = db.prepare('SELECT type, normalized_value FROM source_item_identifiers').all() as Array<{
      type: string; normalized_value: string;
    }>;
    expect(rows).toEqual([{ type: 'TELEGRAM', normalized_value: 'owner' }]);
  });

  it('preserves a closed canonical binding and allows a new current binding for the same source item', () => {
    const sourceId = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'repurposed', name: 'Group' });
    const itemId = repo.upsertSourceItem(sourceId, { sourceType: 'FACEBOOK_GROUP', externalId: 'post-1', classification: 'HOUSING_SUPPLY' });
    const propertyA = Number(db.prepare("INSERT INTO canonical_properties(city) VALUES('siem_reap')").run().lastInsertRowid);
    const listingA = Number(db.prepare("INSERT INTO canonical_listings(property_id,public_ref,status,title,first_seen_at,last_seen_at) VALUES(?,'lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','active','Old','2026-10-01','2026-10-01')").run(propertyA).lastInsertRowid);
    db.prepare(`INSERT INTO canonical_listing_source_occurrences(source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
      VALUES(?,?,?,'post-1','2026-10-01','2026-10-01','canonical-dedupe-v1')`).run(itemId, listingA, sourceId);
    expect(repo.closeCurrentCanonicalBindings(itemId, 'canonical-dedupe-v1', '2026-10-10')).toBe(1);
    const propertyB = Number(db.prepare("INSERT INTO canonical_properties(city) VALUES('siem_reap')").run().lastInsertRowid);
    const listingB = Number(db.prepare("INSERT INTO canonical_listings(property_id,public_ref,status,title,first_seen_at,last_seen_at) VALUES(?,'lst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','active','New','2026-10-10','2026-10-10')").run(propertyB).lastInsertRowid);
    db.prepare(`INSERT INTO canonical_listing_source_occurrences(source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
      VALUES(?,?,?,'post-1','2026-10-10','2026-10-10','canonical-dedupe-v1')`).run(itemId, listingB, sourceId);
    const bindings = db.prepare(`SELECT listing_id,is_current,ended_at FROM canonical_listing_source_occurrences
      WHERE source_item_id=? ORDER BY id`).all(itemId);
    expect(bindings).toEqual([
      { listing_id: listingA, is_current: 0, ended_at: '2026-10-10' },
      { listing_id: listingB, is_current: 1, ended_at: null },
    ]);
  });

  it('promotes the earliest published remaining source after closing a binding', () => {
    const sourceId = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'chronological', name: 'Chronological group' });
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings(public_ref,title,first_seen_at,last_seen_at)
      VALUES('lst_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','Chronological rent','2026-10-01','2026-10-01')`).run().lastInsertRowid);
    const add = (externalId: string, publishedAt: string | null, firstSeenAt: string): { item: number; occurrence: number } => {
      const item = repo.upsertSourceItem(sourceId, { sourceType: 'FACEBOOK_GROUP', externalId, classification: 'HOUSING_SUPPLY' });
      db.prepare('UPDATE source_items SET published_at=? WHERE id=?').run(publishedAt, item);
      const occurrence = Number(db.prepare(`INSERT INTO canonical_listing_source_occurrences
        (source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
        VALUES(?,?,?, ?,?,?,'canonical-dedupe-v1')`)
        .run(item, listingId, sourceId, externalId, firstSeenAt, firstSeenAt).lastInsertRowid);
      return { item, occurrence };
    };
    const removed = add('removed', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
    add('seen-first', '2026-09-20T00:00:00Z', '2026-10-01T00:00:00Z');
    const oldestRemaining = add('published-first', '2026-09-10T00:00:00Z', '2026-10-09T00:00:00Z');
    db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=? WHERE id=?').run(removed.occurrence, listingId);
    expect(repo.closeCurrentCanonicalBindings(removed.item, 'canonical-dedupe-v1', '2026-10-12T00:00:00Z')).toBe(1);
    expect(db.prepare('SELECT primary_source_occurrence_id,status FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ primary_source_occurrence_id: oldestRemaining.occurrence, status: 'active' });
  });

  it('reconciles independent source availability, replay and expiry without losing history', () => {
    const sourceId = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'availability', name: 'Group' });
    const first = repo.upsertSourceItem(sourceId, { sourceType: 'FACEBOOK_GROUP', externalId: 'post-a', classification: 'HOUSING_SUPPLY' });
    const second = repo.upsertSourceItem(sourceId, { sourceType: 'FACEBOOK_GROUP', externalId: 'post-b', classification: 'HOUSING_SUPPLY' });
    const listing = Number(db.prepare(`INSERT INTO canonical_listings(public_ref,title,first_seen_at,last_seen_at,availability_status)
      VALUES('lst_11111111111111111111111111111111','Wat Bo apartment','2026-10-01','2026-10-01','available')`).run().lastInsertRowid);
    const bind = db.prepare(`INSERT INTO canonical_listing_source_occurrences
      (source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
      VALUES(?,?,?,?,'2026-10-01','2026-10-01','canonical-dedupe-v1')`);
    bind.run(first, listing, sourceId, 'post-a');
    bind.run(second, listing, sourceId, 'post-b');

    // An old "for rent" heading does not suppress a later explicit status edit.
    expect(repo.recordExplicitAvailabilityEdit(first, 'For rent Wat Bo — ALREADY RENTED', '2026-10-02T00:00:00Z')).toBe(1);
    expect(db.prepare('SELECT availability_status FROM canonical_listings WHERE id=?').get(listing)).toEqual({ availability_status: 'rented' });
    expect(repo.recordExplicitAvailabilityEdit(second, 'AVAILABLE for rent again', '2026-10-03T00:00:00Z')).toBe(1);
    expect(db.prepare('SELECT availability_status,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listing))
      .toEqual({ availability_status: 'available', availability_last_confirmed_at: '2026-10-03T00:00:00Z' });

    // A stale replay of the unavailable source cannot replace its later confirmation.
    repo.recordExplicitAvailabilityEdit(first, 'For rent — available again', '2026-09-30T00:00:00Z');
    repo.recordExplicitAvailabilityEdit(second, 'Already rented', '2026-10-01T00:00:00Z');
    expect(db.prepare('SELECT availability_signal,availability_signal_at FROM canonical_listing_source_occurrences WHERE source_item_id=?').get(second))
      .toEqual({ availability_signal: 'available', availability_signal_at: '2026-10-03T00:00:00Z' });
    expect(db.prepare('SELECT availability_status FROM canonical_listings WHERE id=?').get(listing)).toEqual({ availability_status: 'available' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM availability_checks').get()).toEqual({ n: 2 });

    // Fresh unavailability outranks independent availability evidence older than 30 days.
    repo.recordExplicitAvailabilityEdit(first, 'No longer available', '2026-11-15T00:00:00Z');
    expect(db.prepare('SELECT availability_status,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listing))
      .toEqual({ availability_status: 'rented', availability_last_confirmed_at: '2026-11-15T00:00:00Z' });
    repo.recordExplicitAvailabilityEdit(first, 'No longer available', '2026-11-15T00:00:00Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM availability_checks').get()).toEqual({ n: 2 });

    expect(repo.closeCurrentCanonicalBindings(first, 'canonical-dedupe-v1', '2026-11-16T00:00:00Z')).toBe(1);
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(listing)).toEqual({ status: 'active' });
    expect(repo.closeCurrentCanonicalBindings(second, 'canonical-dedupe-v1', '2026-11-16T00:00:00Z')).toBe(1);
    expect(db.prepare('SELECT status FROM canonical_listings WHERE id=?').get(listing)).toEqual({ status: 'inactive' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listing_source_occurrences').get()).toEqual({ n: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('does not mistake negated rental language for a confirmed rented unit', () => {
    const sourceId = repo.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'negated', name: 'Group' });
    const sourceItem = repo.upsertSourceItem(sourceId, { sourceType: 'FACEBOOK_GROUP', externalId: 'post-negated' });
    const listing = Number(db.prepare(`INSERT INTO canonical_listings(public_ref,title,first_seen_at,last_seen_at,availability_status)
      VALUES('lst_22222222222222222222222222222222','Available unit','2026-10-01','2026-10-01','available')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO canonical_listing_source_occurrences(source_item_id,listing_id,source_registry_id,external_id,first_seen_at,last_seen_at,source_entity_key)
      VALUES(?,?,?,'post-negated','2026-10-01','2026-10-01','canonical-dedupe-v1')`).run(sourceItem, listing, sourceId);
    expect(repo.recordExplicitAvailabilityEdit(sourceItem, 'Not rented yet, for rent', '2026-10-02T00:00:00Z')).toBe(0);
    expect(repo.recordExplicitAvailabilityEdit(sourceItem, 'Not available anymore', '2026-10-03T00:00:00Z')).toBe(1);
    expect(db.prepare('SELECT availability_status FROM canonical_listings WHERE id=?').get(listing)).toEqual({ availability_status: 'rented' });
  });
});
