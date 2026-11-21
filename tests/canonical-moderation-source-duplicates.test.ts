import { DatabaseSync } from 'node:sqlite';
import { findSourceGroundedDuplicate, reviewDefaultPending } from '../src/modules/parser/canonical-moderation-policy';

const timestamp = new Date().toISOString();
const original = 'Apartment for rent in Siem Reap, 2 bedrooms and 2 bathrooms. Rent $1000/month. '
  + 'Furnished kitchen and lounge, shared swimming pool, parking, garden, and secure entrance. '
  + 'Very peaceful apartment with a balcony, private laundry area, reliable electricity, and shaded courtyard. '
  + 'Available for a long term lease in Svay Dangkum, Siem Reap.';

function fixture() {
  const db = new DatabaseSync(':memory:');
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
  const add = (id: number, options: {
    aiTitle: string; sourceTitle: string; raw?: string; userUrl?: string;
    price?: number | null; city?: string | null;
    status?: 'pending' | 'approved'; source?: 'KHMER24' | 'FACEBOOK_GROUP';
  }) => {
    const url = `https://www.khmer24.com/post-${id}`;
    const price = options.price === undefined ? 1000 : options.price;
    const payload = JSON.stringify({ userUrl: options.userUrl ?? `https://www.facebook.com/user-${id}`,
      listing: { source_title: options.sourceTitle, price, city: 'Siem Reap', type: 'rent',
        source_price_origin: 'khmer24_json_ld_offer', source_price_currency: 'USD', source_price: price } });
    db.prepare('INSERT INTO canonical_listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id,'active','available',options.aiTitle,'2 bedrooms, 2 bathrooms',price === null ? null : price * 100,
      2,2,options.city === undefined ? 'siem_reap' : options.city,'apartment','Apartment',id);
    db.prepare('INSERT INTO canonical_listing_moderation (listing_id,review_status,review_reason,decision_origin) VALUES (?,?,?,?)')
      .run(id,options.status ?? 'pending', options.status === 'approved' ? null :
        'Canonical-only listing requires explicit moderation',
        options.status === 'approved' ? 'INGESTION_VALIDATED_V1' : 'DEFAULT_PENDING');
    db.prepare('INSERT INTO source_items VALUES (?,?,?,?,?,?,?)').run(id,options.source ?? 'KHMER24',url,url,
      options.raw ?? original,payload,timestamp);
    db.prepare('INSERT INTO canonical_listing_source_occurrences VALUES (?,?,?,?,?,?,?,?)').run(
      id,id,id,1,url,timestamp,timestamp,null);
  };
  return { db, add };
}

describe('source-based duplicate protection during default moderation', () => {
  it('allows different original listings with the same AI-generated title', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Beautiful apartment for rent', sourceTitle: 'Apartment (#034)' });
      add(2, { aiTitle: 'Beautiful apartment for rent', sourceTitle: 'Apartment (#035)',
        raw: original.replace('shared swimming pool', 'private swimming pool') });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
      expect(reviewDefaultPending(db)).toEqual({ approved: 2, held: 0 });
    } finally { db.close(); }
  });

  it('holds an exact original duplicate even when the AI titles differ', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Poolside apartment', sourceTitle: 'Apartment with swimming pool (#034)',
        status: 'approved' });
      add(2, { aiTitle: 'Spacious family apartment', sourceTitle: 'Apartment with swimming pool (#034)' });
      expect(findSourceGroundedDuplicate(db, 2)).toEqual({ listingId: 1, reason: 'MATCHING_ORIGINAL_SOURCE' });
      expect(reviewDefaultPending(db)).toEqual({ approved: 0, held: 1 });
    } finally { db.close(); }
  });

  it('allows the first Pending source listing and holds the later identical source listing', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Apartment near old market', sourceTitle: 'Apartment for rent (#034)' });
      add(2, { aiTitle: 'Quiet apartment', sourceTitle: 'Apartment for rent (#034)' });
      expect(findSourceGroundedDuplicate(db, 1)).toBeNull();
      expect(findSourceGroundedDuplicate(db, 2)).toEqual({ listingId: 1, reason: 'MATCHING_ORIGINAL_SOURCE' });
      expect(reviewDefaultPending(db)).toEqual({ approved: 1, held: 1 });
      expect(db.prepare('SELECT review_status FROM canonical_listing_moderation WHERE listing_id=1').get())
        .toEqual({ review_status: 'approved' });
      expect(db.prepare('SELECT review_status FROM canonical_listing_moderation WHERE listing_id=2').get())
        .toEqual({ review_status: 'pending' });
    } finally { db.close(); }
  });

  it('holds same property code with substantial matching original text', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'First title', sourceTitle: 'Apartment with swimming pool (#034)', status: 'approved' });
      add(2, { aiTitle: 'Different title', sourceTitle: 'Apartment with swimming pool (#034)',
        raw: original.replace('Furnished kitchen and lounge', 'Fully furnished kitchen and large lounge') });
      expect(findSourceGroundedDuplicate(db, 2)).toEqual({ listingId: 1, reason: 'MATCHING_ORIGINAL_PROPERTY_CODE' });
      expect(reviewDefaultPending(db)).toEqual({ approved: 0, held: 1 });
    } finally { db.close(); }
  });

  it('does not treat generic agency text or different property codes as the same listing', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Same AI title', sourceTitle: 'Apartment (#05807)', status: 'approved' });
      add(2, { aiTitle: 'Same AI title', sourceTitle: 'Apartment (#05813)', raw: original });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
      expect(reviewDefaultPending(db)).toEqual({ approved: 1, held: 0 });
    } finally { db.close(); }
  });

  it('keeps same-author, strongly overlapping original Facebook advertisements for review', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Near the old market', sourceTitle: 'Apartment for rent in Siem Reap',
        userUrl: 'https://www.facebook.com/agency-1', source: 'FACEBOOK_GROUP', status: 'approved' });
      add(2, { aiTitle: 'Furnished apartment', sourceTitle: 'Lovely apartment for rent',
        userUrl: 'https://www.facebook.com/agency-1', source: 'FACEBOOK_GROUP',
        raw: original.replace('shared swimming pool', 'shared pool') });
      expect(findSourceGroundedDuplicate(db, 2)).toEqual({ listingId: 1,
        reason: 'NEAR_IDENTICAL_SAME_AUTHOR_SOURCE' });
      expect(reviewDefaultPending(db)).toEqual({ approved: 0, held: 1 });
    } finally { db.close(); }
  });

  it('does not hold matching agency templates when source property codes differ', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Shared AI title', sourceTitle: 'Apartment for rent (#05807)',
        userUrl: 'https://www.facebook.com/agency-1', source: 'FACEBOOK_GROUP', status: 'approved' });
      add(2, { aiTitle: 'Shared AI title', sourceTitle: 'Apartment for rent (#05813)',
        userUrl: 'https://www.facebook.com/agency-1', source: 'FACEBOOK_GROUP',
        raw: original.replace('shared swimming pool', 'shared pool') });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
      expect(reviewDefaultPending(db)).toEqual({ approved: 1, held: 0 });
    } finally { db.close(); }
  });

  it('does not treat another Facebook author using the same generic template as a duplicate', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Shared AI title', sourceTitle: 'Apartment for rent',
        userUrl: 'https://www.facebook.com/agency-1', source: 'FACEBOOK_GROUP', status: 'approved' });
      add(2, { aiTitle: 'Shared AI title', sourceTitle: 'Another apartment for rent',
        userUrl: 'https://www.facebook.com/agency-2', source: 'FACEBOOK_GROUP' });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
      expect(reviewDefaultPending(db)).toEqual({ approved: 1, held: 0 });
    } finally { db.close(); }
  });

  it('holds a corroborated original property ID even when both city fields are missing and headings/authors differ', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Apartment one', sourceTitle: 'One-bedroom near the market', city: null,
        userUrl: 'https://www.facebook.com/agent-a', source: 'FACEBOOK_GROUP',
        raw: `${original} Property ID: SR-01043KN`, status: 'pending' });
      add(2, { aiTitle: 'Apartment two', sourceTitle: 'Ground-floor furnished rental', city: null,
        userUrl: 'https://www.facebook.com/agent-b', source: 'FACEBOOK_GROUP',
        raw: `${original.replace('Furnished kitchen and lounge', 'Furnished kitchen with separate lounge')}`
          + ' Property ID: SR-01043KN' });
      expect(findSourceGroundedDuplicate(db, 2)).toEqual({ listingId: 1,
        reason: 'MATCHING_ORIGINAL_PROPERTY_CODE' });
    } finally { db.close(); }
  });

  it('holds substantially overlapping original source posts with the same code when a canonical price is missing', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Villa 2BR', sourceTitle: 'Villa for rent', city: null, price: 300,
        userUrl: 'https://www.facebook.com/agent-a', source: 'FACEBOOK_GROUP',
        raw: `Code: HR1533. ${original}`, status: 'pending' });
      add(2, { aiTitle: 'Two-bedroom house', sourceTitle: 'House offer', city: null, price: null,
        userUrl: 'https://www.facebook.com/agent-b', source: 'FACEBOOK_GROUP',
        raw: `Code: HR1533. ${original.replace('Furnished kitchen', 'Equipped kitchen')}` });
      expect(findSourceGroundedDuplicate(db, 2)).toEqual({ listingId: 1,
        reason: 'MATCHING_ORIGINAL_PROPERTY_CODE' });
    } finally { db.close(); }
  });

  it('keeps distinct property IDs and generic numbered hashtags separate', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Villa 1', sourceTitle: 'Villa for rent', city: null, price: null,
        raw: `Code: HR1533. ${original} #PropertyForRent2026` });
      add(2, { aiTitle: 'Villa 2', sourceTitle: 'Villa for rent', city: null, price: null,
        raw: `Code: HR1534. ${original.replace('private laundry area', 'spacious laundry area')} #PropertyForRent2026` });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
    } finally { db.close(); }
  });

  it('does not hold another property with the same code when the original descriptions are unrelated', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Villa 1', sourceTitle: 'House for rent', city: null,
        raw: `Code: HR1533. ${original}` });
      add(2, { aiTitle: 'Villa 2', sourceTitle: 'Completely different home', city: null,
        raw: `Code: HR1533. Three-storey wooden residence with eight guest suites, private river access, and commercial kitchen. `
          + 'This building also has a rooftop terrace and secure off-street parking for multiple vans, situated in a separate neighborhood.' });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
    } finally { db.close(); }
  });

  it('does not hold shared source codes when both known canonical prices or cities conflict', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Villa A', sourceTitle: 'First offer', city: null, price: 300,
        raw: `Code: HR1533. ${original}`, status: 'approved' });
      add(2, { aiTitle: 'Villa B', sourceTitle: 'Second offer', city: null, price: 400,
        raw: `Code: HR1533. ${original}` });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();

      add(3, { aiTitle: 'Villa C', sourceTitle: 'Third offer', city: 'phnom_penh', price: 300,
        raw: `Code: HR4999. ${original}` });
      add(4, { aiTitle: 'Villa D', sourceTitle: 'Fourth offer', city: 'siem_reap', price: 300,
        raw: `Code: HR4999. ${original}` });
      expect(findSourceGroundedDuplicate(db, 4)).toBeNull();
    } finally { db.close(); }
  });

  it('does not confuse separate units when original room counts contradict despite an identical code', () => {
    const { db, add } = fixture();
    try {
      add(1, { aiTitle: 'Two-bedroom unit', sourceTitle: 'Rental unit', city: null,
        raw: `Property ID: SR-01043KN. ${original}`, status: 'approved' });
      add(2, { aiTitle: 'Three-bedroom unit', sourceTitle: 'Other rental unit', city: null,
        raw: `Property ID: SR-01043KN. ${original.replace('2 bedrooms and 2 bathrooms', '3 bedrooms and 1 bathroom')}` });
      expect(findSourceGroundedDuplicate(db, 2)).toBeNull();
    } finally { db.close(); }
  });
});
