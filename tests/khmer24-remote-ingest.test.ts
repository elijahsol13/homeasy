import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { env } from '../src/config/env';
import { buildApiServer } from '../src/modules/api/server';
import * as khmer24Scraper from '../src/modules/parser/khmer24.scraper';

describe('Khmer24 Mac-to-VPS raw ingest', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  const initialToken = (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN;
  const payload = {
    target: { name: 'Khmer24 Siem Reap', url: 'https://www.khmer24.com/en', city: 'siem_reap' },
    listings: [{
      source_url: 'https://www.khmer24.com/en/property/two-bedroom-apartment-adid-12345678',
      title: 'Two bedroom apartment for rent', raw_text: 'Two bedroom apartment for rent in Siem Reap, $500/month.',
      city: 'siem_reap', photos: [],
    }],
  };

  beforeAll(async () => {
    jest.spyOn(khmer24Scraper, 'enrichListingsWithLLM').mockImplementation(async (listings) =>
      listings.map((listing) => ({ ...listing, is_real_estate: true })));
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    app = await buildApiServer({ container: createContainer({ db }) });
    await app.ready();
  });

  afterAll(async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = initialToken;
    await app.close();
    db.close();
    jest.restoreAllMocks();
  });

  it('requires a token and rejects a mismatched source or invalid detail URL', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = undefined;
    expect((await app.inject({ method: 'POST', url: '/api/v1/internal/khmer24/ingest', payload })).statusCode).toBe(503);
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const target = '/api/v1/internal/khmer24/ingest';
    expect((await app.inject({ method: 'POST', url: target, payload })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${'k'.repeat(40)}` };
    expect((await app.inject({ method: 'POST', url: target, headers,
      payload: { ...payload, target: { ...payload.target, city: 'phnom_penh' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: target, headers,
      payload: { ...payload, listings: [{ ...payload.listings[0], source_url: 'https://evil.example/adid-12345678' }] } })).statusCode).toBe(400);
  });

  it('ingests a raw post to canonical source once, then recognizes replay without another LLM call', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const request = { method: 'POST' as const, url: '/api/v1/internal/khmer24/ingest',
      headers: { authorization: `Bearer ${'k'.repeat(40)}` }, payload };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(first.json().newSourceItems).toBe(1);
    expect(khmer24Scraper.enrichListingsWithLLM).toHaveBeenCalledTimes(1);
    const repeated = await app.inject(request);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().newSourceItems).toBe(0);
    expect(khmer24Scraper.enrichListingsWithLLM).toHaveBeenCalledTimes(1);
    const count = db.prepare('SELECT count(*) AS n FROM source_items WHERE external_id = ?').get('12345678') as { n: number };
    expect(count.n).toBe(1);
  });
});
