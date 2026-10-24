import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { env } from '../src/config/env';
import { buildApiServer } from '../src/modules/api/server';
import type { FastifyInstance } from 'fastify';
import { assertFacebookLocalHost } from '../src/modules/parser/fb-runtime';

describe('Facebook automation host interlock', () => {
  const originalRole = process.env.HOMEASY_DEPLOYMENT_ROLE;
  afterEach(() => {
    if (originalRole === undefined) delete process.env.HOMEASY_DEPLOYMENT_ROLE;
    else process.env.HOMEASY_DEPLOYMENT_ROLE = originalRole;
  });

  it('fails closed when accidentally invoked in a VPS container', () => {
    process.env.HOMEASY_DEPLOYMENT_ROLE = 'vps';
    expect(() => assertFacebookLocalHost()).toThrow('disabled on the Homeasy VPS');
  });
});

describe('Facebook Mac-to-VPS ingest', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  const initialToken = (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN;
  const payload = {
    target: { name: 'Test group', url: 'https://www.facebook.com/groups/siemreaprealestate', city: 'siem_reap' },
    listings: [{
      source_url: 'https://www.facebook.com/groups/siemreaprealestate/posts/909877111/',
      facebook_post_id: '909877111',
      raw_text: 'For rent two bedroom apartment in Siem Reap, price $500 per month. Call us for details.',
      is_real_estate: true, city: 'siem_reap', photos: [],
    }],
  };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    app = await buildApiServer({ container: createContainer({ db }) });
    await app.ready();
  });

  afterAll(async () => {
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = initialToken;
    await app.close();
    db.close();
  });

  it('fails closed without a configured token and rejects unauthorized requests', async () => {
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = undefined;
    expect((await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', payload })).statusCode).toBe(503);
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = 'a'.repeat(40);
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', payload });
    expect(unauthorized.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', payload, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
  });

  it('rejects malformed batches and imports the same Facebook post idempotently', async () => {
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = 'b'.repeat(40);
    const headers = { authorization: 'Bearer ' + 'b'.repeat(40) };
    const bad = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', headers,
      payload: { ...payload, listings: [{ ...payload.listings[0], source_url: 'https://evil.example/posts/1' }] } });
    expect(bad.statusCode).toBe(400);

    const first = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().newSourceItems).toBe(1);
    const repeated = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', headers, payload });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().newSourceItems).toBe(0);
    const count = db.prepare('SELECT count(*) AS n FROM source_items WHERE external_id = ?').get('909877111') as { n: number };
    expect(count.n).toBe(1);
  });
});
