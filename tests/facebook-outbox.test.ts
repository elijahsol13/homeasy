import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushFacebookOutbox, queueFacebookBatch } from '../src/modules/parser/facebook-outbox';

describe('Facebook delivery outbox', () => {
  let directory: string;
  const target = { name: 'Test', url: 'https://www.facebook.com/groups/123', city: 'siem_reap' as const };
  const listings = [{ source_url: 'https://www.facebook.com/groups/123/posts/456', raw_text: '2BR apartment for rent', photos: [] }];
  const url = 'https://api.rustycat.cc/api/v1/internal/facebook/ingest';
  const token = 'secret'.repeat(8);

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-outbox-test-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('keeps an offline batch durably and sends it after reconnection', async () => {
    const offline = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(queueFacebookBatch(target, listings, directory, url, token, offline)).rejects.toThrow('offline');
    expect(fs.readdirSync(directory).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    const online = jest.fn(async () => new Response(JSON.stringify({
      newSourceItems: 1, updatedSourceItems: 0, unchangedSourceItems: 0, errors: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const result = await flushFacebookOutbox(directory, url, token, online);
    expect(result.newSourceItems).toBe(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('acknowledges local durability before a failed network request', async () => {
    const durable = jest.fn(() => {
      const queued = fs.readdirSync(directory).filter((f) => f.endsWith('.json'));
      expect(queued).toHaveLength(1);
      expect((JSON.parse(fs.readFileSync(path.join(directory, queued[0]!), 'utf8')) as { listings: unknown[] }).listings).toHaveLength(1);
    });
    const offline = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(queueFacebookBatch(target, listings, directory, url, token, offline, durable)).rejects.toThrow('offline');
    expect(durable).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge durability if validation rejects a post', async () => {
    const durable = jest.fn();
    await expect(queueFacebookBatch(target, [{ ...listings[0], raw_text: 'x'.repeat(1024 * 1024) }],
      directory, url, token, fetch, durable)).rejects.toThrow('1 MiB');
    expect(durable).not.toHaveBeenCalled();
  });

  it('does not delete a batch if the server reports partial failure', async () => {
    const partial = jest.fn(async () => new Response('{"errors":[{"message":"ingest failed"}]}', { status: 503 })) as unknown as typeof fetch;
    await expect(queueFacebookBatch(target, listings, directory, url, token, partial)).rejects.toThrow();
    expect(fs.readdirSync(directory).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('splits more than ten listings into safe batches and only removes acknowledged ones', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      ...listings[0], source_url: `https://www.facebook.com/groups/123/posts/${456 + i}`,
    }));
    const offline = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(queueFacebookBatch(target, twelve, directory, url, token, offline)).rejects.toThrow('offline');
    const queued = fs.readdirSync(directory).filter((f) => f.endsWith('.json'));
    expect(queued).toHaveLength(2);
    expect(queued.map((f) => (JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8')) as { listings: unknown[] }).listings.length).sort((a, b) => a - b)).toEqual([2, 10]);

    let calls = 0;
    const flaky = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const count = (JSON.parse(init?.body as string) as { listings: unknown[] }).listings.length;
      calls++;
      return new Response(JSON.stringify({ newSourceItems: calls === 1 ? count : 0,
        updatedSourceItems: 0, unchangedSourceItems: 0, errors: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    await expect(flushFacebookOutbox(directory, url, token, flaky)).rejects.toThrow('incomplete');
    expect(fs.readdirSync(directory).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    const recovered = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const count = (JSON.parse(init?.body as string) as { listings: unknown[] }).listings.length;
      return new Response(JSON.stringify({ newSourceItems: 0, updatedSourceItems: 0,
        unchangedSourceItems: count, errors: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    await flushFacebookOutbox(directory, url, token, recovered);
    expect(fs.readdirSync(directory).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('rejects oversized single posts without creating a queue file', async () => {
    await expect(queueFacebookBatch(target, [{ ...listings[0], raw_text: 'x'.repeat(1024 * 1024) }],
      directory, url, token)).rejects.toThrow('1 MiB');
    expect(fs.existsSync(directory) ? fs.readdirSync(directory) : []).toHaveLength(0);
  });
});
