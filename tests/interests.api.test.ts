import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { buildApiServer } from '../src/modules/api/server';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

describe('Phase 7A interest flow', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let publicRef: string;
  const userHeaders = { 'X-Dev-Telegram-Id': '77112233' };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    const container = createContainer({ db });
    const sourceRepo = new SourceIngestionRepository(db);
    const sourceId = sourceRepo.upsertSource({
      sourceType: 'FACEBOOK_GROUP', externalSourceId: 'phase7-interest', name: 'Phase 7 interest fixture', city: 'siem_reap',
    });
    const itemId = sourceRepo.upsertSourceItemDetailed(sourceId, {
      sourceType: 'FACEBOOK_GROUP', externalId: 'phase7-interest-listing', contentHash: 'phase7-interest-listing',
      sourceUrl: 'https://facebook.com/groups/phase7/posts/interest-listing',
      rawText: 'Phase 7 apartment for rent in Siem Reap, $450/month.', classification: 'HOUSING_SUPPLY',
      rawPayload: {
        listingExtraction: {
          title_en: 'Phase 7 apartment', description_en: 'Apartment for rent in Siem Reap', price: 450,
          currency: 'USD', category: 'apartment', property_type: 'Apartment', bedrooms: 1,
          city: 'siem_reap', sangkat: 'Wat Bo', offer_type: 'rent',
        }, photos: [],
      },
    }).id;
    new CanonicalShadowService(db).run({ dryRun: false });
    const listing = db.prepare(`SELECT l.id,l.public_ref FROM canonical_listings l
      JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id
      WHERE o.source_item_id=? AND o.is_current=1`).get(itemId) as { id: number; public_ref: string };
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(listing.id);
    publicRef = listing.public_ref;
    app = await buildApiServer({ container, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    db.close();
  });

  it('requires Telegram authentication', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/listings/${publicRef}/interest` });
    expect(res.statusCode).toBe(401);
  });

  it('creates the Interest → Request → Offer → ContactGrant chain once and retains search context', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/listings/${publicRef}/interest`,
      headers: userHeaders,
      payload: {
        searchContext: {
          city: 'siem_reap', locations: ['Wat Bo'], category: 'apartment', bedrooms: [1],
          maxPrice: 500, query: 'quiet apartment', sort: 'price_asc', ignored: 'do-not-store',
        },
        contactChannel: 'telegram',
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as Record<string, unknown>;
    expect(firstBody).toMatchObject({ ok: true, publicRef, interestCreated: true, contactGrantCreated: true });
    expect(firstBody.requestId).toMatch(/^req_/);
    expect(firstBody.offerId).toMatch(/^off_/);
    expect(firstBody.contactGrantId).toMatch(/^cgr_/);

    const second = await app.inject({
      method: 'POST', url: `/api/v1/listings/${publicRef}/interest`, headers: userHeaders,
      payload: { searchContext: { city: 'phnom_penh', query: 'must not overwrite' }, contactChannel: 'telegram' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as Record<string, unknown>;
    expect(secondBody).toMatchObject({ interestCreated: false, contactGrantCreated: false });
    expect(secondBody.interestId).toBe(firstBody.interestId);
    expect(secondBody.requestId).toBe(firstBody.requestId);
    expect(secondBody.offerId).toBe(firstBody.offerId);
    expect(secondBody.contactGrantId).toBe(firstBody.contactGrantId);

    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM listing_interests) interests,
      (SELECT COUNT(*) FROM interest_requests) requests,
      (SELECT COUNT(*) FROM listing_offers) offers,
      (SELECT COUNT(*) FROM contact_grants) grants`).get() as Record<string, number>;
    expect(counts).toEqual({ interests: 1, requests: 1, offers: 1, grants: 1 });

    const context = db.prepare('SELECT search_context_json FROM listing_interests').get() as { search_context_json: string };
    expect(JSON.parse(context.search_context_json)).toEqual({
      city: 'siem_reap', locations: ['Wat Bo'], category: 'apartment', bedrooms: [1],
      maxPrice: 500, query: 'quiet apartment', sort: 'price_asc',
    });
    const events = db.prepare(`SELECT event_type,COUNT(*) count FROM usage_events
      WHERE event_type IN ('interest_created','contact_granted','telegram_contact_dispatched') GROUP BY event_type ORDER BY event_type`)
      .all() as Array<{ event_type: string; count: number }>;
    expect(events).toEqual([
      { event_type: 'contact_granted', count: 1 },
      { event_type: 'interest_created', count: 1 },
      { event_type: 'telegram_contact_dispatched', count: 2 },
    ]);
  });

  it('records an authenticated Mini App listing view', async () => {
    const view = await app.inject({ method: 'POST', url: `/api/v1/listings/${publicRef}/view`, headers: userHeaders });
    expect(view.statusCode).toBe(200);
    const event = db.prepare("SELECT metadata FROM usage_events WHERE event_type='listing_view' ORDER BY id DESC LIMIT 1")
      .get() as { metadata: string };
    expect(JSON.parse(event.metadata)).toMatchObject({ listing_public_ref: publicRef, surface: 'miniapp' });
  });

  it('does not create a lead for a listing that is no longer public', async () => {
    const listing = db.prepare('SELECT listing_id FROM canonical_listing_aliases WHERE namespace=? AND alias=?')
      .get('public_listing_ref', publicRef) as { listing_id: number };
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(listing.listing_id);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/listings/${publicRef}/interest`, headers: { 'X-Dev-Telegram-Id': '88990011' },
    });
    expect(res.statusCode).toBe(404);
  });
});
