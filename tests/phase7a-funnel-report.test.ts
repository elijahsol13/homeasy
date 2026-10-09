import { DatabaseSync } from 'node:sqlite';
import { buildPhase7AFunnelReport } from '../src/services/phase7a-funnel-report';

describe('Phase 7A funnel report', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_id INTEGER);
      CREATE TABLE canonical_listings (id INTEGER PRIMARY KEY, public_ref TEXT NOT NULL, title TEXT);
      CREATE TABLE listing_interests (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, listing_id INTEGER NOT NULL, search_context_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE usage_events (id INTEGER PRIMARY KEY, user_id INTEGER, telegram_id INTEGER, event_type TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES (1,111), (2,8441221953);
      INSERT INTO canonical_listings VALUES (1,'lst_one','First listing'), (2,'lst_two','Second listing'), (3,'lst_internal','Internal listing');
      INSERT INTO listing_interests VALUES
        ('int_one',1,1,'{"city":"siem_reap","type":"rent","sort":"newest"}','2026-10-08T12:02:00.000Z'),
        ('int_two',1,2,'{"city":"siem_reap","locations":["Wat Bo"]}','2026-10-08T12:04:00.000Z'),
        ('int_internal',2,3,'{}','2026-10-08T12:05:00.000Z');
      INSERT INTO usage_events VALUES
        (1,1,111,'listing_view','{"listing_public_ref":"lst_one"}','2026-10-08T12:00:00.000Z'),
        (2,1,111,'interest_created','{"listing_public_ref":"lst_one"}','2026-10-08T12:02:00.000Z'),
        (3,1,111,'contact_granted','{"listing_public_ref":"lst_one"}','2026-10-08T12:02:00.000Z'),
        (4,1,111,'telegram_contact_dispatched','{"listing_public_ref":"lst_one"}','2026-10-08T12:02:01.000Z'),
        (5,1,111,'telegram_contact_dispatched','{"listing_public_ref":"lst_one"}','2026-10-08T12:02:02.000Z'),
        (6,1,111,'listing_view','{"listing_public_ref":"lst_two"}','2026-10-08T12:03:00.000Z'),
        (7,1,111,'interest_created','{"listing_public_ref":"lst_two"}','2026-10-08T12:04:00.000Z'),
        (8,1,111,'contact_granted','{"listing_public_ref":"lst_two"}','2026-10-08T12:04:00.000Z'),
        (9,1,111,'telegram_contact_dispatched','{"listing_public_ref":"lst_two"}','2026-10-08T12:04:01.000Z'),
        (10,2,8441221953,'listing_view','{"listing_public_ref":"lst_internal"}','2026-10-08T12:05:00.000Z'),
        (11,2,8441221953,'interest_created','{"listing_public_ref":"lst_internal"}','2026-10-08T12:05:01.000Z');
    `);
  });

  afterEach(() => db.close());

  it('excludes operational accounts and reports the baseline funnel without writing', () => {
    const report = buildPhase7AFunnelReport({
      db,
      period: '24h',
      endAt: new Date('2026-10-09T00:00:00.000Z'),
    });

    expect(report.funnel).toMatchObject({
      uniqueListingViewUsers: 1,
      uniqueListingsViewed: 2,
      listingViewEvents: 2,
      uniqueInterestUsers: 1,
      uniqueInterestedListings: 2,
      interestCreatedEvents: 2,
      telegramContactDispatchedEvents: 3,
      viewToInterestUserRate: 1,
      viewedToInterestedListingRate: 1,
      grantsPerInterestHealth: 1,
    });
    expect(report.dispatch).toMatchObject({
      uniqueUserListingPairs: 2,
      repeatDispatchEvents: 1,
      pairsWithRepeatDispatches: 1,
      topRepeatedPairs: [{ telegramId: 111, publicRef: 'lst_one', dispatches: 2 }],
    });
    expect(report.interestsPerUser).toEqual({ usersWithOneInterest: 0, usersWithMultipleInterests: 1, average: 2, max: 2 });
    expect(report.context).toMatchObject({ direct: 0, broad: 1, filtered: 1, invalid: 0 });
    expect(report.topListingsByInterest).toEqual([
      { publicRef: 'lst_one', title: 'First listing', interests: 1 },
      { publicRef: 'lst_two', title: 'Second listing', interests: 1 },
    ]);
    expect(report.viewToInterest).toEqual({ matchedInterests: 2, unmatchedInterests: 0, medianSeconds: 90 });
    expect(db.prepare('SELECT COUNT(*) count FROM usage_events').get()).toEqual({ count: 11 });
  });
});
