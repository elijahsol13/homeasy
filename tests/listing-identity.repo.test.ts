import { DatabaseSync } from 'node:sqlite';
import { ListingIdentityRepository } from '../src/database/repositories/listing-identity.repo';

describe('ListingIdentityRepository', () => {
  let db: DatabaseSync;
  let repo: ListingIdentityRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE canonical_listing_aliases(namespace TEXT,alias TEXT,listing_id INTEGER,PRIMARY KEY(namespace,alias));
      CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE properties(id INTEGER PRIMARY KEY);
      CREATE TABLE canonical_listings(id INTEGER PRIMARY KEY,public_ref TEXT UNIQUE);
      CREATE TABLE user_favorites(user_id INTEGER,property_id INTEGER,saved_at TEXT);
      CREATE TABLE canonical_user_favorites(user_id INTEGER,listing_id INTEGER,saved_at TEXT);`);
    repo = new ListingIdentityRepository(db);
    db.exec("INSERT INTO canonical_listings VALUES (9,'lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),(123,'lst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')");
  });

  afterEach(() => db.close());

  it('keeps colliding legacy and canonical numeric IDs in separate namespaces', () => {
    repo.register('legacy_property_id', 123, 9);
    repo.register('canonical_listing_id', 123, 123);
    expect(repo.resolve('legacy_property_id', 123)?.listingId).toBe(9);
    expect(repo.resolve('canonical_listing_id', 123)?.listingId).toBe(123);
    expect(repo.resolve('public_listing_ref', 123)).toBeUndefined();
  });

  it('uses stable public listing references and resolves only registered refs', () => {
    const ref = ListingIdentityRepository.generatePublicRef();
    expect(ref).toMatch(/^lst_[a-f0-9]{32}$/);
    db.prepare('INSERT INTO canonical_listings VALUES(24,?)').run(ref);
    repo.register('public_listing_ref', ref, 24);
    expect(repo.resolvePublicRef(ref)?.listingId).toBe(24);
    expect(repo.resolvePublicRef('lst_00000000000000000000000000000000')).toBeUndefined();
  });

  it('keeps public ref and aliases resolvable after canonical integer ID changes on rebuild', () => {
    const ref='lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    repo.register('public_listing_ref',ref,9);
    repo.register('legacy_property_id',123,9);
    db.prepare('DELETE FROM canonical_listings WHERE id=9').run();
    db.prepare('INSERT INTO canonical_listings VALUES(9001,?)').run(ref);
    db.prepare('UPDATE canonical_listing_aliases SET listing_id=9001 WHERE alias=?').run(ref);
    db.prepare("UPDATE canonical_listing_aliases SET listing_id=9001 WHERE namespace='legacy_property_id' AND alias='123'").run();
    expect(repo.resolvePublicRef(ref)?.listingId).toBe(9001);
    expect(repo.resolve('legacy_property_id',123)?.listingId).toBe(9001);
  });

  it('collapses legacy duplicate favorites to one canonical listing in dry-run', () => {
    db.exec(`INSERT INTO users VALUES (1); INSERT INTO properties VALUES (11),(12);
      INSERT INTO user_favorites VALUES (1,11,'2026-01-01'),(1,12,'2026-01-02');`);
    db.prepare('INSERT INTO canonical_listings VALUES (7,?)').run('lst_77777777777777777777777777777777');
    repo.register('legacy_property_id', 11, 7);
    repo.register('legacy_property_id', 12, 7);
    expect(repo.favoriteMigrationPreview()).toEqual([{ userId: 1, legacyPropertyIds: [11, 12], listingId: 7, publicRef: 'lst_77777777777777777777777777777777' }]);
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_user_favorites').get()).toEqual({ n: 0 });
  });

  it('reports unmapped favorites explicitly while keeping numeric namespaces separate', () => {
    db.exec("INSERT INTO users VALUES (1); INSERT INTO properties VALUES (123),(999);");
    db.prepare('INSERT INTO user_favorites VALUES (1,123,\'2026-01-01\'),(1,999,\'2026-01-02\')').run();
    repo.register('legacy_property_id',123,9);
    repo.register('canonical_listing_id',123,123);
    expect(repo.favoriteMigrationAudit()).toEqual({
      mapped:[{userId:1,legacyPropertyIds:[123],listingId:9,publicRef:'lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}],
      unresolved:[{userId:1,legacyPropertyId:999}],
    });
  });

  it('preserves an opaque public ref across a SQLite backup and canonical ID remap', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homeasy-public-ref-'));
    const backup=path.join(dir,'backup.sqlite');
    try{
      const ref='lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      repo.register('public_listing_ref',ref,9);
      db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
      const restored=new DatabaseSync(backup);
      try{
        const restoredRepo=new ListingIdentityRepository(restored);
        expect(restoredRepo.resolvePublicRef(ref)?.listingId).toBe(9);
        restored.prepare('DELETE FROM canonical_listings WHERE id=9').run();
        restored.prepare('INSERT INTO canonical_listings VALUES(9001,?)').run(ref);
        restored.prepare("UPDATE canonical_listing_aliases SET listing_id=9001 WHERE namespace='public_listing_ref' AND alias=?").run(ref);
        expect(restoredRepo.resolvePublicRef(ref)?.listingId).toBe(9001);
        expect(ref).not.toBe(`lst_${'9001'.padStart(32,'0')}`);
      }finally{restored.close();}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
