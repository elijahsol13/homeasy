import { DatabaseSync } from 'node:sqlite';
import {
  evaluateCorroboratedCrossposts, reviewDefaultPending,
  type CurrentModerationSource, type ModerationCandidate,
} from '../src/modules/parser/canonical-moderation-policy';

const date = new Date().toISOString();
const raw = 'Apartment for rent in Siem Reap. 2 bedrooms, 2 bathrooms. Rent $350/month. '
  + 'Located in Svay Dangkum, comfortable living room, fully furnished kitchen, '
  + 'quiet garden, parking for motorcycles, recently renovated and available immediately. '
  + 'Large balcony, shaded courtyard, private laundry area, peaceful neighborhood, and secure gate.';
const payload = (userUrl: string, price = 350) => JSON.stringify({ userUrl,
  listingExtraction: { price, bedrooms: 2, bathrooms: 2, city: 'Siem Reap', type: 'rent' } });

const base: ModerationCandidate = {
  id: 1, status: 'active', availability_status: 'available',
  title: 'Apartment for rent', description: 'Two bedrooms', price: 35000,
  bedrooms: 2, bathrooms: 2, city: 'siem_reap', category: 'apartment', property_type: 'Apartment',
  review_reason: null, source_type: 'FACEBOOK_GROUP',
  source_url: 'https://www.facebook.com/groups/123/posts/1/',
  raw_text: raw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123'),
  current_count: 2, conflicting_url: 0, legacy_aliases: 0,
  original_published_at: date, first_source_seen_at: date,
  matching_active_listings: 0, primary_source_occurrence_id: 10,
};
const sources: CurrentModerationSource[] = [
  { occurrence_id: 10, source_item_id: 100, source_type: 'FACEBOOK_GROUP',
    source_url: base.source_url, raw_text: raw, raw_payload_json: base.raw_payload_json },
  { occurrence_id: 11, source_item_id: 101, source_type: 'FACEBOOK_GROUP',
    source_url: 'https://www.facebook.com/groups/456/posts/2/',
    raw_text: raw, raw_payload_json: base.raw_payload_json },
];

const askingRaw = raw.replace('Rent $350/month.', 'Asking Price: $450.');
const askingPayload = payload('https://www.facebook.com/profile.php?id=123', 450);

describe('corroborated Facebook crossposts', () => {
  it('accepts two independent identical originals of the same rental', () => {
    expect(evaluateCorroboratedCrossposts(base, sources)).toEqual({ approved: true, reasons: [] });
  });

  it('shares rent-context price evidence across identical crossposts without assuming all groups are rental groups', () => {
    const row = { ...base, price: 45000, raw_text: askingRaw, raw_payload_json: askingPayload };
    const contextualSources: CurrentModerationSource[] = [
      { ...sources[0]!, group_name: 'Cheap Rent Siem Reap', raw_text: askingRaw, raw_payload_json: askingPayload },
      { ...sources[1]!, group_name: 'Siem Reap Real Estate', raw_text: askingRaw, raw_payload_json: askingPayload },
    ];
    expect(evaluateCorroboratedCrossposts(row, contextualSources)).toEqual({ approved: true, reasons: [] });
    expect(evaluateCorroboratedCrossposts(row, contextualSources.map(source => ({ ...source, group_name: 'Siem Reap Real Estate' }))).reasons)
      .toContain('MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE');
  });

  it('holds when any current crosspost carries an explicit unsupported AI decision', () => {
    const unsupported = JSON.stringify({ userUrl: 'https://www.facebook.com/profile.php?id=123',
      listingExtraction: { price: 350, bedrooms: 2, bathrooms: 2, city: 'Siem Reap', type: 'rent',
        is_supported_listing: false } });
    const result = evaluateCorroboratedCrossposts(base, [sources[0]!,
      { ...sources[1]!, raw_payload_json: unsupported }]);
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain('AI_CLASSIFIED_UNSUPPORTED');
  });

  it('accepts minor repeated-word changes only with the same author and numerical facts', () => {
    const changed = raw + ' kitchen kitchen';
    expect(evaluateCorroboratedCrossposts(base, [sources[0]!, { ...sources[1]!, raw_text: changed }]))
      .toEqual({ approved: true, reasons: [] });
    expect(evaluateCorroboratedCrossposts(base, [sources[0]!, { ...sources[1]!, raw_text: changed,
      raw_payload_json: payload('https://www.facebook.com/profile.php?id=999') }]).reasons)
      .toContain('AMBIGUOUS_SOURCE_BINDINGS');
  });

  it('accepts short exact crossposts from the same author when source facts independently pass', () => {
    const shortRaw = 'Shophouse for rent in Siem Reap, located in Svay Dangkum. Rent $500/month. ' + 'ok '.repeat(25);
    const row = { ...base, price: 50000, bedrooms: null, bathrooms: null,
      title: 'Shophouse for rent', description: 'Office use allowed.', category: 'house', property_type: 'Shophouse',
      raw_text: shortRaw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 500) };
    const shortSources = [
      { ...sources[0]!, raw_text: shortRaw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 500) },
      { ...sources[1]!, raw_text: shortRaw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 500) },
    ];
    expect(shortRaw.length).toBeLessThan(160);
    expect(evaluateCorroboratedCrossposts(row, shortSources)).toEqual({ approved: true, reasons: [] });
    expect(evaluateCorroboratedCrossposts(row, [shortSources[0]!, { ...shortSources[1]!,
      raw_payload_json: payload('https://www.facebook.com/profile.php?id=999', 500) }]).reasons)
      .toContain('AMBIGUOUS_SOURCE_BINDINGS');
  });

  it('holds identical crossposts when the canonical bedroom count is not in either original', () => {
    const shortRaw = 'Shophouse for rent in Siem Reap, Svay Dangkum. Rent $500/month. ' + 'ok '.repeat(25);
    const row = { ...base, price: 50000, bedrooms: 5, bathrooms: null, title: 'Shophouse',
      description: 'A five-bedroom shophouse for office use.', category: 'house', property_type: 'Shophouse',
      raw_text: shortRaw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 500) };
    const repeated = [
      { ...sources[0]!, raw_text: shortRaw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 500) },
      { ...sources[1]!, raw_text: shortRaw, raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 500) },
    ];
    expect(evaluateCorroboratedCrossposts(row, repeated).reasons)
      .toContain('UNSUPPORTED_CANONICAL_BEDROOM_COUNT');
  });

  it('holds two nearly identical offers with different property identifiers', () => {
    const first = raw + ' Property code 112233.';
    const second = raw + ' Property code 445566.';
    expect(evaluateCorroboratedCrossposts(base, [
      { ...sources[0]!, raw_text: first }, { ...sources[1]!, raw_text: second },
    ]).reasons).toContain('AMBIGUOUS_SOURCE_BINDINGS');
  });

  it('holds contradictions in any current source, even when texts look very similar', () => {
    const variants = [
      { raw_text: raw.replace('$350/month', '$450/month') },
      { raw_text: raw.replace('2 bedrooms', '3 bedrooms') },
      { raw_text: raw + ' Also for sale at $75,000.' },
      { raw_text: raw.replace('Siem Reap', 'Phnom Penh').replace('Svay Dangkum', 'Tuol Kouk') },
    ];
    for (const variant of variants) {
      expect(evaluateCorroboratedCrossposts(base, [sources[0]!, { ...sources[1]!, ...variant }]).approved)
        .toBe(false);
    }
    expect(evaluateCorroboratedCrossposts(base, [sources[0]!, { ...sources[1]!,
      raw_payload_json: payload('https://www.facebook.com/profile.php?id=123', 450) }]))
      .toEqual({ approved: true, reasons: [] });
  });

  it('preserves conflicting bindings, missing provenance, original freshness and manual holds', () => {
    expect(evaluateCorroboratedCrossposts(base, [sources[0]!, { ...sources[1]!, source_url: sources[0]!.source_url }]).approved)
      .toBe(false);
    expect(evaluateCorroboratedCrossposts(base, [sources[0]!]).approved).toBe(false);
    expect(evaluateCorroboratedCrossposts({ ...base, primary_source_occurrence_id: 99 }, sources).approved)
      .toBe(false);
    expect(evaluateCorroboratedCrossposts({ ...base, original_published_at: '2025-01-01T00:00:00Z' }, sources).reasons)
      .toContain('ORIGINAL_PUBLICATION_TOO_OLD');
    expect(evaluateCorroboratedCrossposts({ ...base, review_reason: 'manual' }, sources).reasons)
      .toContain('PRIOR_MANUAL_REVIEW_REASON');
    expect(evaluateCorroboratedCrossposts({ ...base, conflicting_url: 1 }, sources).reasons)
      .toContain('SOURCE_URL_CONFLICT');
  });

  it('reviews an actual DEFAULT_PENDING row through all current source occurrences', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE canonical_listings (id INTEGER PRIMARY KEY,status TEXT,availability_status TEXT,
        title TEXT,description TEXT,price INTEGER,bedrooms INTEGER,bathrooms INTEGER,city TEXT,
        category TEXT,property_type TEXT,primary_source_occurrence_id INTEGER);
        CREATE TABLE canonical_listing_moderation (listing_id INTEGER PRIMARY KEY,review_status TEXT,
          review_reason TEXT,decision_origin TEXT,policy_version TEXT,decision_evidence_json TEXT,
          previous_review_status TEXT,decided_at TEXT,decision_actor TEXT,updated_at TEXT);
        CREATE TABLE source_items (id INTEGER PRIMARY KEY,source_type TEXT,canonical_url TEXT,source_url TEXT,
          raw_text TEXT,raw_payload_json TEXT,published_at TEXT);
        CREATE TABLE canonical_listing_source_occurrences (id INTEGER PRIMARY KEY,source_item_id INTEGER,
          listing_id INTEGER,is_current INTEGER,source_url TEXT,posted_at TEXT,first_seen_at TEXT,group_name TEXT);
        CREATE TABLE canonical_listing_aliases (listing_id INTEGER,namespace TEXT);`);
      db.prepare(`INSERT INTO canonical_listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        1,base.status,base.availability_status,base.title,base.description,base.price,
        base.bedrooms,base.bathrooms,base.city,base.category,base.property_type,10);
      db.exec(`INSERT INTO canonical_listing_moderation
        (listing_id,review_status,review_reason,decision_origin)
        VALUES (1,'pending','Canonical-only listing requires explicit moderation','DEFAULT_PENDING')`);
      for (const source of sources) {
        db.prepare('INSERT INTO source_items VALUES (?,?,?,?,?,?,?)').run(source.source_item_id,
          source.source_type,source.source_url,source.source_url,source.raw_text,source.raw_payload_json,date);
        db.prepare('INSERT INTO canonical_listing_source_occurrences VALUES (?,?,?,?,?,?,?,?)').run(
          source.occurrence_id,source.source_item_id,1,1,source.source_url,date,date,source.group_name ?? null);
      }
      db.prepare(`INSERT INTO canonical_listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        2,base.status,base.availability_status,'Separate legacy rental',base.description,base.price,
        base.bedrooms,base.bathrooms,base.city,base.category,base.property_type,20);
      db.exec(`INSERT INTO canonical_listing_moderation
        (listing_id,review_status,review_reason,decision_origin)
        VALUES (2,'pending','INGESTION_VALIDATED_V1: held for manual review (PRICE_NOT_EXPLICITLY_SUPPORTED)',
          'INGESTION_VALIDATED_V1')`);
      const legacyUrl = 'https://www.facebook.com/groups/789/posts/3/';
      db.prepare('INSERT INTO source_items VALUES (?,?,?,?,?,?,?)').run(200,'FACEBOOK_GROUP',legacyUrl,
        legacyUrl,raw,payload('https://www.facebook.com/profile.php?id=123'),date);
      db.prepare('INSERT INTO canonical_listing_source_occurrences VALUES (?,?,?,?,?,?,?,?)').run(
        20,200,2,1,legacyUrl,date,date,null);

      expect(reviewDefaultPending(db)).toEqual({ approved: 2, held: 0 });
      const decision = db.prepare('SELECT review_status,decision_evidence_json FROM canonical_listing_moderation WHERE listing_id=1')
        .get() as {review_status: string;decision_evidence_json: string};
      expect(decision.review_status).toBe('approved');
      expect(JSON.parse(decision.decision_evidence_json).verifiedSourceItemIds).toEqual([100, 101]);
      expect(db.prepare('SELECT review_status,policy_version,review_reason FROM canonical_listing_moderation WHERE listing_id=2')
        .get()).toEqual({review_status:'approved',policy_version:'source-corroborated-crossposts-v12',review_reason:null});

      db.prepare(`INSERT INTO canonical_listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        3,base.status,base.availability_status,'Alias-conflict rental',base.description,base.price,
        base.bedrooms,base.bathrooms,base.city,base.category,base.property_type,30);
      db.exec(`INSERT INTO canonical_listing_moderation
        (listing_id,review_status,review_reason,decision_origin)
        VALUES (3,'pending','Legacy identity alias conflict; manual review required','INGESTION_VALIDATED_V1')`);
      db.exec("UPDATE canonical_listing_moderation SET review_status='pending',decision_origin='DEFAULT_PENDING',review_reason='Owner requested manual review' WHERE listing_id=1");
      expect(reviewDefaultPending(db)).toEqual({ approved: 0, held: 1 });
      const manualHold = db.prepare('SELECT review_status,review_reason FROM canonical_listing_moderation WHERE listing_id=1')
        .get() as {review_status:string;review_reason:string};
      expect(manualHold).toEqual({review_status:'pending',review_reason:'Owner requested manual review'});
      expect(db.prepare('SELECT review_status,review_reason FROM canonical_listing_moderation WHERE listing_id=3')
        .get()).toEqual({review_status:'pending',review_reason:'Legacy identity alias conflict; manual review required'});
    } finally { db.close(); }
  });
});
