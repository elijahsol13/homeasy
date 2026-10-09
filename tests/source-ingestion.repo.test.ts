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
    expect(versions.version).toBe(50);
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
});
