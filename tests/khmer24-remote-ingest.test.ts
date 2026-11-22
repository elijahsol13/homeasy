import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { Api } from 'grammy';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { env } from '../src/config/env';
import { buildApiServer } from '../src/modules/api/server';
import * as khmer24Scraper from '../src/modules/parser/khmer24.scraper';
import { ingestKhmer24Listings } from '../src/modules/parser/khmer24-ingestion';
import { AlertService } from '../src/services/alert.service';

describe('Khmer24 Mac-to-VPS raw ingest', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  let container: ReturnType<typeof createContainer>;
  const telegramSend = jest.fn().mockResolvedValue({});
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
    container = createContainer({ db });
    container.alertService = new AlertService({ sendMessage: telegramSend } as unknown as Api, [98765]);
    app = await buildApiServer({ container });
    await app.ready();
    container.alertService.setApi({ sendMessage: telegramSend } as unknown as Api);
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

  it('keeps enrichment paired to the right source version when a batch repeats one detail URL', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const url = 'https://www.khmer24.com/en/property/repeated-adid-89123457';
    const first = { ...payload.listings[0], source_url: url, raw_text: 'Version one $410/month' };
    const second = { ...first, raw_text: 'Version two $420/month' };
    jest.mocked(khmer24Scraper.enrichListingsWithLLM).mockImplementationOnce(async (listings) =>
      listings.map((listing, index) => ({ ...listing, title: `Enriched version ${index + 1}`, is_real_estate: true })));

    const response = await app.inject({
      method: 'POST', url: '/api/v1/internal/khmer24/ingest',
      headers: { authorization: `Bearer ${'k'.repeat(40)}` },
      payload: { ...payload, listings: [first, second] },
    });

    expect(response.statusCode).toBe(200);
    const versions = db.prepare(`SELECT raw_text, raw_payload_json FROM source_item_versions
      WHERE source_item_id = (SELECT id FROM source_items WHERE external_id = '89123457')
      ORDER BY id`).all() as { raw_text: string; raw_payload_json: string }[];
    expect(versions.map((version) => ({
      rawText: version.raw_text,
      enrichedTitle: (JSON.parse(version.raw_payload_json) as { listing: { title: string } }).listing.title,
    }))).toEqual([
      { rawText: first.raw_text, enrichedTitle: 'Enriched version 1' },
      { rawText: second.raw_text, enrichedTitle: 'Enriched version 2' },
    ]);
  });

  it('enriches changed listings in order even when an unchanged listing sits between them', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const headers = { authorization: `Bearer ${'k'.repeat(40)}` };
    const endpoint = '/api/v1/internal/khmer24/ingest';
    const unchanged = { ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/unchanged-adid-89123458' };
    const first = { ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/first-adid-89123459', raw_text: 'First $410/month' };
    const last = { ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/last-adid-89123460', raw_text: 'Last $420/month' };

    expect((await app.inject({ method: 'POST', url: endpoint, headers,
      payload: { ...payload, listings: [unchanged] } })).statusCode).toBe(200);

    const enrich = jest.mocked(khmer24Scraper.enrichListingsWithLLM);
    enrich.mockImplementationOnce(async (listings) => listings.map((listing, index) => ({
      ...listing, title: `Changed ${index + 1}`, is_real_estate: true,
    })));
    const response = await app.inject({ method: 'POST', url: endpoint, headers,
      payload: { ...payload, listings: [first, unchanged, last] },
    });

    expect(response.statusCode).toBe(200);
    expect(enrich).toHaveBeenLastCalledWith([first, last], { inclusive: true });
    const versions = db.prepare(`SELECT s.external_id, v.raw_payload_json
      FROM source_item_versions v JOIN source_items s ON s.id = v.source_item_id
      WHERE s.external_id IN ('89123459', '89123460') ORDER BY s.external_id`).all() as {
      external_id: string; raw_payload_json: string;
    }[];
    expect(versions.map((version) => ({
      id: version.external_id,
      title: (JSON.parse(version.raw_payload_json) as { listing: { title: string } }).listing.title,
    }))).toEqual([
      { id: '89123459', title: 'Changed 1' },
      { id: '89123460', title: 'Changed 2' },
    ]);
  });

  it('retries every changed listing when AI returns fewer results than the changed cohort', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const first = { ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/first-adid-89123461', raw_text: 'First $410/month' };
    const second = { ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/second-adid-89123462', raw_text: 'Second $420/month' };
    const request = { method: 'POST' as const, url: '/api/v1/internal/khmer24/ingest',
      headers: { authorization: `Bearer ${'k'.repeat(40)}` },
      payload: { ...payload, listings: [first, second] },
    };
    jest.mocked(khmer24Scraper.enrichListingsWithLLM).mockImplementationOnce(async (listings) => [
      { ...listings[1], title: 'Must not land on first listing', is_real_estate: true },
    ]);

    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().errors).toEqual([
      { externalId: '89123461', message: 'LLM extraction unavailable' },
      { externalId: '89123462', message: 'LLM extraction unavailable' },
    ]);
    for (const id of ['89123461', '89123462']) {
      expect(db.prepare('SELECT classification FROM source_items WHERE external_id = ?').get(id))
        .toMatchObject({ classification: 'UNCLASSIFIED' });
    }

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().errors).toEqual([]);
  });

  it('keeps the explicit noEnrich path free of AI calls', async () => {
    const enrich = jest.mocked(khmer24Scraper.enrichListingsWithLLM);
    enrich.mockClear();
    const listing = { ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/raw-adid-89123463' };

    const result = await ingestKhmer24Listings(container, [listing], true);

    expect(result.errors).toEqual([]);
    expect(enrich).not.toHaveBeenCalled();
    expect(db.prepare('SELECT classification FROM source_items WHERE external_id = ?')
      .get('89123463')).toMatchObject({ classification: 'UNCLASSIFIED' });
  });

  it('keeps a failed AI enrichment batch retryable and classifies it on replay', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const listing = {
      ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/room-adid-87654321',
    };
    const request = {
      method: 'POST' as const,
      url: '/api/v1/internal/khmer24/ingest',
      headers: { authorization: `Bearer ${'k'.repeat(40)}` },
      payload: { ...payload, listings: [listing] },
    };
    const enrich = jest.mocked(khmer24Scraper.enrichListingsWithLLM);
    const warn = jest.spyOn(app.log, 'warn').mockImplementation(() => {});
    const info = jest.spyOn(app.log, 'info').mockImplementation(() => {});
    const child = jest.spyOn(app.log, 'child').mockReturnValue(app.log);
    const telegram = jest.spyOn(container.alertService, 'warnWithDeliveryResult');
    enrich.mockImplementationOnce(async (listings) => listings.map((item) => ({
      ...item,
      is_real_estate: null,
      review_status: 'pending',
      review_reason: 'LLM extraction unavailable',
    })));

    const first = await app.inject(request);
    expect(first.statusCode).toBe(503);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls[0][0]).toContain('Khmer24');
    expect(telegram.mock.calls[0][0]).not.toContain(listing.raw_text);
    expect(telegramSend.mock.calls.at(-1)?.[0]).toBe(98765);
    expect(telegramSend.mock.calls.at(-1)?.[1]).toContain('Khmer24 import failed');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ingestion_batch_failed', source: 'khmer24', inputItems: 1,
      processedItems: 1, failedItems: 1, runId: expect.any(Number),
      elapsedMs: expect.any(Number),
    }), 'Ingestion batch needs retry');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(listing.raw_text);
    expect(first.json().errors).toEqual([{
      externalId: '87654321', message: 'LLM extraction unavailable',
    }]);
    expect(db.prepare('SELECT classification FROM source_items WHERE external_id = ?')
      .get('87654321')).toMatchObject({ classification: 'UNCLASSIFIED' });
    expect(db.prepare(`SELECT items_input, items_processed, items_success, items_failed, status
      FROM processing_runs ORDER BY id DESC LIMIT 1`).get()).toMatchObject({
      items_input: 1, items_processed: 1, items_success: 0, items_failed: 1, status: 'failed',
    });
    expect(db.prepare(`SELECT records_input, records_success, records_failed FROM processing_run_sources
      ORDER BY id DESC LIMIT 1`).get()).toMatchObject({
      records_input: 1, records_success: 0, records_failed: 1,
    });
    expect(db.prepare('SELECT failed_items FROM external_provider_usage ORDER BY id DESC LIMIT 1').get())
      .toMatchObject({ failed_items: 1 });

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ingestion_batch_completed', source: 'khmer24', inputItems: 1,
      processedItems: 1, failedItems: 0, runId: expect.any(Number),
      elapsedMs: expect.any(Number),
    }), 'Ingestion batch completed');
    expect(replay.json().errors).toEqual([]);
    expect(db.prepare('SELECT classification FROM source_items WHERE external_id = ?')
      .get('87654321')).toMatchObject({ classification: 'HOUSING_SUPPLY' });
    expect((db.prepare('SELECT count(*) AS count FROM source_items WHERE external_id = ?')
      .get('87654321') as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT count(*) AS count FROM source_item_versions WHERE source_item_id = (SELECT id FROM source_items WHERE external_id = ?)')
      .get('87654321')).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM canonical_listing_source_occurrences WHERE source_item_id = (SELECT id FROM source_items WHERE external_id = ?) AND is_current = 1')
      .get('87654321')).toMatchObject({ count: 1 });
    expect(db.prepare(`SELECT items_success, items_failed FROM processing_runs ORDER BY id DESC LIMIT 1`).get())
      .toMatchObject({ items_success: 1, items_failed: 0 });
    child.mockRestore();
    warn.mockRestore();
    info.mockRestore();
    telegram.mockRestore();
  });

  it('retains a batch for replay when AI enrichment omits an expected listing', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const listing = {
      ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/room-adid-87654323',
    };
    const request = {
      method: 'POST' as const,
      url: '/api/v1/internal/khmer24/ingest',
      headers: { authorization: `Bearer ${'k'.repeat(40)}` },
      payload: { ...payload, listings: [listing] },
    };
    jest.mocked(khmer24Scraper.enrichListingsWithLLM).mockResolvedValueOnce([]);

    const first = await app.inject(request);
    expect(first.statusCode).toBe(503);
    expect(first.json().errors).toEqual([{
      externalId: '87654323', message: 'LLM extraction unavailable',
    }]);
    expect(db.prepare('SELECT classification FROM source_items WHERE external_id = ?')
      .get('87654323')).toMatchObject({ classification: 'UNCLASSIFIED' });

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().errors).toEqual([]);
    expect(db.prepare('SELECT classification FROM source_items WHERE external_id = ?')
      .get('87654323')).toMatchObject({ classification: 'HOUSING_SUPPLY' });
    expect(db.prepare('SELECT count(*) AS count FROM source_items WHERE external_id = ?')
      .get('87654323')).toMatchObject({ count: 1 });
    expect(db.prepare(`SELECT count(*) AS count FROM source_item_versions WHERE source_item_id =
      (SELECT id FROM source_items WHERE external_id = ?)`).get('87654323')).toMatchObject({ count: 1 });
  });

  it('preserves a source-verified map pin from a failed AI attempt through classification and later map refresh', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const original = {
      ...payload.listings[0],
      source_url: 'https://www.khmer24.com/en/property/pinned-room-adid-87654322',
      latitude: 13.358721, longitude: 103.857632,
      maps_url: 'https://www.google.com/maps?q=13.358721,103.857632',
    };
    const send = (listing: typeof original) => app.inject({
      method: 'POST', url: '/api/v1/internal/khmer24/ingest',
      headers: { authorization: `Bearer ${'k'.repeat(40)}` },
      payload: { ...payload, listings: [listing] },
    });
    jest.mocked(khmer24Scraper.enrichListingsWithLLM).mockImplementationOnce(async (listings) =>
      listings.map((item) => ({ ...item, is_real_estate: null, review_reason: 'LLM extraction unavailable' })));
    expect((await send(original)).statusCode).toBe(503);
    const recovered = await send({ ...original, latitude: undefined as unknown as number,
      longitude: undefined as unknown as number, maps_url: undefined as unknown as string });
    expect(recovered.statusCode).toBe(200);
    const row = db.prepare(`SELECT s.raw_payload_json, l.listing_facts_json
      FROM source_items s JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1
      JOIN canonical_listings l ON l.id=o.listing_id WHERE s.external_id='87654322'`).get() as {
      raw_payload_json: string; listing_facts_json: string;
    };
    expect(JSON.parse(row.raw_payload_json).listingExtraction).toMatchObject({
      latitude: 13.358721, longitude: 103.857632,
      maps_url: 'https://www.google.com/maps?q=13.358721,103.857632',
    });
    expect(JSON.parse(row.listing_facts_json)).toMatchObject({ latitude: 13.358721, longitude: 103.857632 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM source_item_versions WHERE source_item_id=
      (SELECT id FROM source_items WHERE external_id='87654322')`).get()).toEqual({ n: 1 });

    const updated = await send({ ...original, latitude: 13.359721, longitude: 103.858632,
      maps_url: 'https://www.google.com/maps?q=13.359721,103.858632' });
    expect(updated.statusCode).toBe(200);
    const latest = db.prepare(`SELECT l.listing_facts_json FROM canonical_listings l
      JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id AND o.is_current=1
      JOIN source_items s ON s.id=o.source_item_id WHERE s.external_id='87654322'`).get() as { listing_facts_json: string };
    expect(JSON.parse(latest.listing_facts_json)).toMatchObject({ latitude: 13.359721, longitude: 103.858632 });
  });

  it('notifies on thrown AI enrichment errors while preserving the retryable HTTP failure', async () => {
    (env as { K24_INGEST_TOKEN?: string }).K24_INGEST_TOKEN = 'k'.repeat(40);
    const warn = jest.spyOn(container.alertService, 'warnWithDeliveryResult').mockResolvedValue(true);
    jest.mocked(khmer24Scraper.enrichListingsWithLLM)
      .mockRejectedValueOnce(new Error('private provider response'));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/internal/khmer24/ingest',
        headers: { authorization: `Bearer ${'k'.repeat(40)}` },
        payload: { ...payload, listings: [{ ...payload.listings[0],
          source_url: 'https://www.khmer24.com/en/property/ai-failure-adid-89123456' }] },
      });
      expect(response.statusCode).toBe(500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Khmer24'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private provider response');
    } finally {
      warn.mockRestore();
    }
  });
});
