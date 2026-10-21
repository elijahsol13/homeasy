import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import {
  applyKhmer24AliasRepairs, assessKhmer24Alias, auditUnmappedKhmer24Aliases, khmer24AdId,
} from '../src/database/khmer24-alias-repair';

describe('Khmer24 duplicate legacy alias repair', () => {
  let db: DatabaseSync;
  const ref = 'lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const old = 'https://www.khmer24.com/en/cool-room-for-rent-adid-13881722';
  const current = 'https://www.khmer24.com/post-adid-13881722';

  function legacy(id: number, url: string, price = 15000): void {
    db.prepare(`INSERT INTO properties(id,hash,title,price,currency,type,location,city,original_url,source_url,category,review_status,is_active)
      VALUES(?,?,'Room',?,'USD','rent','Wat Bo','siem_reap',?,?,'room','approved',1)`)
      .run(id, String(id), price, url, url);
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO source_registry(id,source_key,source_type,name) VALUES(1,'k24','KHMER24','Khmer24')").run();
    db.prepare(`INSERT INTO canonical_listings(id,public_ref,title,first_seen_at,last_seen_at,price,currency,city,category)
      VALUES(329,?,'Room','2026-10-01','2026-10-02',15000,'USD','siem_reap','room')`).run(ref);
    db.prepare(`INSERT INTO canonical_listing_moderation(listing_id,review_status,decision_origin)
      VALUES(329,'approved','MIGRATED_LEGACY')`).run();
    db.prepare(`INSERT INTO source_items(id,source_registry_id,source_type,external_id,canonical_url,source_url,raw_payload_json,classification)
      VALUES(1,1,'KHMER24','adid:13881722',?,?,'{}','HOUSING_SUPPLY')`).run(current, current);
    db.prepare(`INSERT INTO canonical_listing_source_occurrences(source_item_id,listing_id,source_registry_id,
      first_seen_at,last_seen_at,source_entity_key,is_current) VALUES(1,329,1,'2026-10-01','2026-10-02','v1',1)`).run();
    legacy(215, current);
    legacy(22, old);
    db.prepare(`INSERT INTO canonical_listing_aliases(namespace,alias,listing_id)
      VALUES('legacy_property_id','215',329)`).run();
  });
  afterEach(() => db.close());

  it('parses only supported Khmer24 listing URL shapes and exact hosts', () => {
    expect(khmer24AdId(old)).toBe('13881722');
    expect(khmer24AdId(current)).toBe('13881722');
    expect(khmer24AdId('http://khmer24.com/post-adid-13881722?foo=1')).toBe('13881722');
    expect(khmer24AdId('https://khmer24.com.evil.tld/post-adid-13881722')).toBeNull();
    expect(khmer24AdId('https://khmer24.com@evil.tld/post-adid-13881722')).toBeNull();
    expect(khmer24AdId('https://www.khmer24.com/photos/post-adid-13881722')).toBeNull();
    expect(khmer24AdId('https://www.khmer24.com/en/post-adid-13881722')).toBeNull();
  });

  it('audits safe candidates without writing, then applies only their missing aliases atomically', () => {
    expect(assessKhmer24Alias(db, 22)).toMatchObject({
      status: 'safe', listingId: 329, publicRef: ref, siblingLegacyId: 215,
    });
    expect(auditUnmappedKhmer24Aliases(db)).toEqual([expect.objectContaining({ legacyId: 22, status: 'safe' })]);
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listing_aliases').get()).toEqual({ n: 1 });
    expect(applyKhmer24AliasRepairs(db, [22])).toEqual([expect.objectContaining({ status: 'safe', listingId: 329 })]);
    expect(assessKhmer24Alias(db, 22).status).toBe('already_mapped');
    expect(applyKhmer24AliasRepairs(db, [22])).toEqual([expect.objectContaining({ status: 'already_mapped' })]);
    expect(db.prepare("SELECT namespace,alias,listing_id FROM canonical_listing_aliases ORDER BY alias").all())
      .toEqual([
        { namespace: 'legacy_property_id', alias: '215', listing_id: 329 },
        { namespace: 'legacy_property_id', alias: '22', listing_id: 329 },
      ]);
    expect(db.prepare('SELECT review_status,decision_origin FROM canonical_listing_moderation').get())
      .toEqual({ review_status: 'approved', decision_origin: 'MIGRATED_LEGACY' });
  });

  it('fails closed for incompatible legacy price, city and moderation', () => {
    db.prepare('UPDATE properties SET price=16000 WHERE id=22').run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('canonical_fields_mismatch');
    db.prepare("UPDATE properties SET price=15000,city='phnom_penh' WHERE id=22").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('canonical_fields_mismatch');
    db.prepare("UPDATE properties SET city='siem_reap',review_status='pending' WHERE id=22").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('legacy_not_approved_active_rental');
  });

  it('accepts a price revision only with an existing trusted alias and matching independent identity fields', () => {
    db.prepare('UPDATE properties SET price=14000,bedrooms=2 WHERE id=215').run();
    db.prepare('UPDATE properties SET bedrooms=2 WHERE id=22').run();
    db.prepare('UPDATE canonical_listings SET bedrooms=2 WHERE id=329').run();
    expect(assessKhmer24Alias(db, 22)).toMatchObject({
      status: 'safe', reason: 'verified_price_revision_same_source',
      siblingLegacyId: 215, listingId: 329,
    });
    db.prepare("UPDATE properties SET title='Unrelated room' WHERE id=215").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
    db.prepare("UPDATE properties SET title='Room',bedrooms=3 WHERE id=215").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
    db.prepare('UPDATE properties SET bedrooms=2 WHERE id=215').run();
    db.prepare("UPDATE canonical_listings SET title='Different offer' WHERE id=329").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
    db.prepare("UPDATE canonical_listings SET title='Room' WHERE id=329").run();
    db.prepare("UPDATE properties SET title='  ' WHERE id IN (22,215)").run();
    db.prepare("UPDATE canonical_listings SET title='  ' WHERE id=329").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
    db.prepare("UPDATE properties SET title='Room',bedrooms=0 WHERE id IN (22,215)").run();
    db.prepare("UPDATE canonical_listings SET title='Room',bedrooms=0 WHERE id=329").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
    db.prepare("DELETE FROM canonical_listing_aliases WHERE namespace='legacy_property_id' AND alias='215'").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
  });

  it('requires a verified existing duplicate sibling and refuses mismatched source IDs', () => {
    db.prepare("DELETE FROM canonical_listing_aliases WHERE alias='215' AND namespace='legacy_property_id'").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('trusted_sibling_alias_not_found');
    db.prepare("UPDATE source_items SET canonical_url='https://www.khmer24.com/post-adid-111111' WHERE id=1").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('canonical_source_url_mismatch');
  });

  it('rejects conflicting source aliases and independently ambiguous canonical sources', () => {
    db.prepare(`INSERT INTO canonical_listings(id,public_ref,title,first_seen_at,last_seen_at,price,currency,city,category)
      VALUES(330,'lst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','Other','2026-10-01','2026-10-02',15000,'USD','siem_reap','room')`).run();
    db.prepare("INSERT INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('legacy_property_id','22',330)").run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('legacy_alias_collision');
    db.prepare("DELETE FROM canonical_listing_aliases WHERE alias='22' AND namespace='legacy_property_id'").run();
    db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(330,'approved')").run();
    db.prepare("INSERT INTO source_items(id,source_registry_id,source_type,external_id,canonical_url,source_url,raw_payload_json) VALUES(2,1,'KHMER24','13881722',?,?,'{}')").run(current, current);
    db.prepare(`INSERT INTO canonical_listing_source_occurrences(source_item_id,listing_id,source_registry_id,
      first_seen_at,last_seen_at,source_entity_key,is_current) VALUES(2,330,1,'2026-10-01','2026-10-02','v1',1)`).run();
    expect(assessKhmer24Alias(db, 22).reason).toBe('ambiguous_canonical_source');
  });

  it('rolls back the whole batch if even one candidate is blocked', () => {
    legacy(23, 'https://www.khmer24.com/en/other-room-adid-99999999');
    expect(() => applyKhmer24AliasRepairs(db, [22, 23])).toThrow('Unsafe Khmer24 alias 23');
    expect(db.prepare("SELECT listing_id FROM canonical_listing_aliases WHERE namespace='legacy_property_id' AND alias='22'").get()).toBeUndefined();
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
