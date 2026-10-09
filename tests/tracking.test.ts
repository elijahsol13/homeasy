import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { buildApiServer } from '../src/modules/api/server';
import { env } from '../src/config/env';
import { TrackingLinkService } from '../src/services/tracking.service';
import type { FastifyInstance } from 'fastify';

describe('Tracking gateway /r/:slug', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let container: ReturnType<typeof createContainer>;
  const ADMIN_TG_ID = 299321244;

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    container = createContainer({ db });
    if (!env.ADMIN_IDS.includes(ADMIN_TG_ID)) env.ADMIN_IDS.push(ADMIN_TG_ID);
    app = await buildApiServer({ container, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('returns 404 HTML for unknown slugs', async () => {
    const res = await app.inject({ method: 'GET', url: '/r/doesnotexist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('mints a link as admin and redirects clicks to the Mini App deep link', async () => {
    const prevMiniApp = env.TELEGRAM_MINIAPP_URL;
    const prevBotUser = env.TELEGRAM_BOT_USERNAME;
    const prevTrackingUrl = env.TRACKING_PUBLIC_URL;
    env.TELEGRAM_MINIAPP_URL = 'https://t.me/HomeasyTestBot/app';
    env.TELEGRAM_BOT_USERNAME = '';
    env.TRACKING_PUBLIC_URL = 'https://go.rustycat.cc';
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/links',
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
        payload: {
          kind: 'miniapp',
          payload: 'req_42',
          source: 'facebook',
          campaign: 'demand-outreach',
          groupId: 'g1',
          postId: 'p1',
          requestId: 'req_42',
        },
      });
      expect(create.statusCode).toBe(200);
      const { slug, url } = create.json();
      expect(slug).toHaveLength(8);
      expect(url).toBe('https://go.rustycat.cc/r/' + slug);

      const click = await app.inject({ method: 'GET', url: `/r/${slug}` });
      expect(click.statusCode).toBe(302);
      expect(click.headers.location).toBe(`https://t.me/HomeasyTestBot/app?startapp=${slug}`);

      const stored = container.trackedLinksRepo.findBySlug(slug)!;
      expect(stored.clicks_count).toBe(1);
      expect(stored.last_clicked_at).not.toBeNull();
      expect(stored.source).toBe('facebook');

      const event = db
        .prepare(`SELECT event_type, metadata FROM usage_events WHERE event_type = 'tracking_link_clicked'`)
        .get() as { event_type: string; metadata: string };
      expect(event).toBeDefined();
      const meta = JSON.parse(event.metadata);
      expect(meta.slug).toBe(slug);
      expect(meta.request_id).toBe('req_42');
    } finally {
      env.TELEGRAM_MINIAPP_URL = prevMiniApp;
      env.TELEGRAM_BOT_USERNAME = prevBotUser;
      env.TRACKING_PUBLIC_URL = prevTrackingUrl;
    }
  });

  it('falls back to t.me/<bot_username>?startapp= when TELEGRAM_MINIAPP_URL is missing', async () => {
    const prevMiniApp = env.TELEGRAM_MINIAPP_URL;
    const prevBotUser = env.TELEGRAM_BOT_USERNAME;
    env.TELEGRAM_MINIAPP_URL = '';
    env.TELEGRAM_BOT_USERNAME = 'HomeasyTestBot';
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/links',
        headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
        payload: { kind: 'miniapp', payload: 'req_42' },
      });
      expect(create.statusCode).toBe(200);
      const { slug } = create.json();

      const click = await app.inject({ method: 'GET', url: `/r/${slug}` });
      expect(click.statusCode).toBe(302);
      expect(click.headers.location).toBe(`https://t.me/HomeasyTestBot?startapp=${slug}`);
    } finally {
      env.TELEGRAM_MINIAPP_URL = prevMiniApp;
      env.TELEGRAM_BOT_USERNAME = prevBotUser;
    }
  });

  it('redirects kind=url links to the payload URL', async () => {
    const link = container.trackedLinksRepo.createLink({
      kind: 'url',
      payload: 'https://example.com/listing/123',
      source: 'telegram',
    });
    const res = await app.inject({ method: 'GET', url: `/r/${link.slug}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/listing/123');
  });

  it('rejects link creation for non-admins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      headers: { 'x-dev-telegram-id': '111222333' },
      payload: { kind: 'miniapp', payload: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unauthenticated link creation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      payload: { kind: 'miniapp', payload: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects kind=url with a non-http payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
      payload: { kind: 'url', payload: 'javascript:alert(1)' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('records miniapp_opened event when Mini App reports a tracked link open', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
      payload: {
        kind: 'miniapp',
        payload: 'test_payload',
        source: 'facebook',
        campaign: 'demand-outreach',
        groupId: 'g1',
        postId: 'p1',
        requestId: 'req_42',
      },
    });
    const { slug } = create.json();

    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/links/${slug}/opened`,
      headers: { 'x-dev-telegram-id': '123456789' },
      payload: { telegram_user_id: 123456789, telegram_username: 'tester' },
    });
    expect(opened.statusCode).toBe(200);
    const body = opened.json();
    expect(body.ok).toBe(true);
    expect(body.attribution.source).toBe('facebook');
    expect(body.attribution.request_id).toBe('req_42');

    const event = db
      .prepare(
        `SELECT event_type, telegram_id, metadata FROM usage_events WHERE event_type = 'miniapp_opened'`,
      )
      .get() as { event_type: string; telegram_id: number; metadata: string };
    expect(event).toBeDefined();
    expect(event.telegram_id).toBe(123456789);
    const meta = JSON.parse(event.metadata);
    expect(meta.slug).toBe(slug);
    expect(meta.campaign).toBe('demand-outreach');
  });

  it('returns 404 for opened event on unknown slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/links/unknown/opened',
      headers: { 'x-dev-telegram-id': String(ADMIN_TG_ID) },
      payload: { telegram_user_id: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('resolves legacy numeric and public-ref tracked links to one listing without rewriting history', () => {
    const propertyId=Number(db.prepare("INSERT INTO canonical_properties(city) VALUES('siem_reap')").run().lastInsertRowid);
    const canonicalId=123;
    const listingId=700;
    const publicRef='lst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    db.prepare(`INSERT INTO canonical_listings(id,property_id,public_ref,status,title,first_seen_at,last_seen_at)
      VALUES(123,?,'lst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','active','collision','2026-01-01','2026-01-01')`).run(propertyId);
    db.prepare(`INSERT INTO canonical_listings(id,property_id,public_ref,status,title,first_seen_at,last_seen_at)
      VALUES(?,?,?,'active','target','2026-01-01','2026-01-01')`).run(listingId,propertyId,publicRef);
    container.listingIdentityRepo.register('legacy_property_id',canonicalId,listingId);
    container.listingIdentityRepo.register('canonical_listing_id',canonicalId,canonicalId);
    container.listingIdentityRepo.register('public_listing_ref',publicRef,listingId);

    const oldLink=container.trackedLinksRepo.createLink({kind:'miniapp',payload:'old',listingId:canonicalId,metadata:{fixture:'old'}});
    const before=db.prepare('SELECT listing_id,listing_public_ref,metadata,clicks_count FROM tracked_links WHERE id=?').get(oldLink.id);
    const service=new TrackingLinkService(container);
    expect(service.resolveAttribution(oldLink)).toMatchObject({listing_id:canonicalId,listing_public_ref:publicRef});
    const prevMiniApp=env.TELEGRAM_MINIAPP_URL;
    env.TELEGRAM_MINIAPP_URL='https://t.me/HomeasyTestBot/app';
    try{
      const newLink=service.createLink({kind:'miniapp',payload:'new',listingPublicRef:publicRef}).link;
      expect(newLink.listing_id).toBe(listingId);
      expect(newLink.listing_public_ref).toBe(publicRef);
      expect(()=>service.createLink({kind:'miniapp',payload:'bad',listingPublicRef:'lst_ffffffffffffffffffffffffffffffff'})).toThrow('Unknown canonical listing public_ref');
      expect(db.prepare('SELECT listing_id,listing_public_ref,metadata,clicks_count FROM tracked_links WHERE id=?').get(oldLink.id)).toEqual(before);
    }finally{env.TELEGRAM_MINIAPP_URL=prevMiniApp;}
  });
});
