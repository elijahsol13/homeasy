import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushFacebookOutbox, queueFacebookBatch } from '../src/modules/parser/facebook-outbox';
import { KHMER24_BATCH_TARGET } from '../src/modules/parser/khmer24-outbox';

describe('Khmer24 raw batch outbox', () => {
  let directory: string;
  const endpoint = 'https://api.rustycat.cc/api/v1/internal/khmer24/ingest';
  const token = 'k'.repeat(40);
  const listings = Array.from({ length: 12 }, (_, i) => ({
    source_url: `https://www.khmer24.com/en/property/test-adid-${1234500 + i}`,
    raw_text: '2 bedroom apartment for rent Siem Reap $500', photos: [],
  }));

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'k24-outbox-test-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('preserves all 12 raw records offline in five-item batches and replays them', async () => {
    const offline = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(queueFacebookBatch(KHMER24_BATCH_TARGET, listings, directory, endpoint, token,
      offline, undefined, 180_000, 'Khmer24', 5)).rejects.toThrow('offline');
    const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(3);
    expect(files.map((file) => (JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as {
      listings: unknown[];
    }).listings.length).sort()).toEqual([2, 5, 5]);

    const delivery = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
      const body = JSON.parse(init?.body as string) as { listings: unknown[] };
      return new Response(JSON.stringify({ newSourceItems: body.listings.length,
        updatedSourceItems: 0, unchangedSourceItems: 0, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await flushFacebookOutbox(directory, endpoint, token, delivery, 180_000, 'Khmer24');
    expect(result.newSourceItems).toBe(12);
    expect(delivery).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(directory)).toHaveLength(0);
  });

  it('retains a failed or incompletely acknowledged batch for safe retry', async () => {
    const unavailable = jest.fn(async () => new Response('Unavailable', { status: 503 })) as unknown as typeof fetch;
    await expect(queueFacebookBatch(KHMER24_BATCH_TARGET, listings.slice(0, 1), directory,
      endpoint, token, unavailable, undefined, 180_000, 'Khmer24', 5)).rejects.toThrow('HTTP 503');
    const incomplete = jest.fn(async () => new Response(JSON.stringify({
      newSourceItems: 0, updatedSourceItems: 0, unchangedSourceItems: 0, errors: [],
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(flushFacebookOutbox(directory, endpoint, token, incomplete, 180_000, 'Khmer24'))
      .rejects.toThrow('incomplete');
    expect(fs.readdirSync(directory).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });
});
