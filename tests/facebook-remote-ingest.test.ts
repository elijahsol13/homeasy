import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { env } from '../src/config/env';
import { buildApiServer } from '../src/modules/api/server';
import type { FastifyInstance } from 'fastify';
import type { Api } from 'grammy';
import { assertFacebookLocalHost } from '../src/modules/parser/fb-runtime';
import * as facebookIngestion from '../src/modules/parser/facebook-ingestion';
import { AlertService } from '../src/services/alert.service';

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
  let container: ReturnType<typeof createContainer>;
  const telegramSend = jest.fn().mockResolvedValue({});
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
    container = createContainer({ db });
    container.alertService = new AlertService({ sendMessage: telegramSend } as unknown as Api, [98765]);
    app = await buildApiServer({ container });
    await app.ready();
    // Webhook registration rewires the bot API, so restore the offline transport after registration.
    container.alertService.setApi({ sendMessage: telegramSend } as unknown as Api);
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
    const info = jest.spyOn(app.log, 'info').mockImplementation(() => {});
    const child = jest.spyOn(app.log, 'child').mockReturnValue(app.log);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', headers,
      payload: { ...payload, listings: [{ ...payload.listings[0], source_url: 'https://evil.example/posts/1' }] } });
    expect(bad.statusCode).toBe(400);

    const first = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().newSourceItems).toBe(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ingestion_batch_completed', source: 'facebook', inputItems: 1,
      processedItems: 1, failedItems: 0, runId: expect.any(Number),
      elapsedMs: expect.any(Number),
    }), 'Ingestion batch completed');
    const repeated = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest', headers, payload });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().newSourceItems).toBe(0);
    const count = db.prepare('SELECT count(*) AS n FROM source_items WHERE external_id = ?').get('909877111') as { n: number };
    expect(count.n).toBe(1);
    child.mockRestore();
    info.mockRestore();
  });

  it('alerts on an uncaught ingestion failure without including exception details', async () => {
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = 'b'.repeat(40);
    const ingest = jest.spyOn(facebookIngestion, 'ingestFacebookGroupListings')
      .mockRejectedValueOnce(new Error('private parser details'));
    const warn = jest.spyOn(container.alertService, 'warnWithDeliveryResult').mockResolvedValue(true);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/internal/facebook/ingest',
        headers: { authorization: `Bearer ${'b'.repeat(40)}` }, payload });
      expect(response.statusCode).toBe(500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Facebook'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private parser details');
    } finally {
      ingest.mockRestore();
      warn.mockRestore();
    }
  });

  it('alerts on a failed batch, throttles retries, rearms after recovery, and preserves HTTP 503 on alert failure', async () => {
    (env as { FB_INGEST_TOKEN?: string }).FB_INGEST_TOKEN = 'b'.repeat(40);
    const request = { method: 'POST' as const, url: '/api/v1/internal/facebook/ingest',
      headers: { authorization: `Bearer ${'b'.repeat(40)}` }, payload };
    // End the previous test's simulated crash incident before testing a fresh failure window.
    expect((await app.inject(request)).statusCode).toBe(200);
    telegramSend.mockClear();
    const failed = {
      inputItems: 1, processedItems: 0, runId: 9001,
      newSourceItems: 0, updatedSourceItems: 0, unchangedSourceItems: 0,
      errors: [{ externalId: '909877111', message: 'secret listing details' }],
    } as Awaited<ReturnType<typeof facebookIngestion.ingestFacebookGroupListings>>;
    const recovered = { ...failed, errors: [], processedItems: 1 };
    const ingest = jest.spyOn(facebookIngestion, 'ingestFacebookGroupListings');
    const warn = jest.spyOn(container.alertService, 'warnWithDeliveryResult');
    try {
      ingest.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(recovered).mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(recovered).mockResolvedValueOnce(failed);
      expect((await app.inject(request)).statusCode).toBe(503);
      expect((await app.inject(request)).statusCode).toBe(503);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Facebook');
      expect(warn.mock.calls[0][0]).toContain('9001');
      expect(warn.mock.calls[0][0]).not.toContain('secret listing details');
      expect(telegramSend).toHaveBeenCalledTimes(1);
      expect(telegramSend.mock.calls[0][0]).toBe(98765);
      expect(telegramSend.mock.calls[0][1]).not.toContain('secret listing details');
      expect((await app.inject(request)).statusCode).toBe(200);
      warn.mockRejectedValueOnce(new Error('Telegram offline with sensitive internals'));
      expect((await app.inject(request)).statusCode).toBe(503);
      expect(warn).toHaveBeenCalledTimes(2);
      expect((await app.inject(request)).statusCode).toBe(200);
      expect((await app.inject(request)).statusCode).toBe(503);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      ingest.mockRestore();
      warn.mockRestore();
    }
  });
});
