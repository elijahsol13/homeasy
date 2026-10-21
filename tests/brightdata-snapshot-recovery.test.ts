import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findPendingSnapshots, recoverAcceptedSnapshot } from '../scripts/brightdata-batch-test';
import { newMonitorState } from '../src/modules/parser/facebook-group-monitor';

const groupUrl = 'https://www.facebook.com/groups/495676670504992';

describe('Bright Data accepted snapshot recovery without another paid POST', () => {
  let directory: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeasy-brightdata-recovery-'));
    originalFetch = globalThis.fetch;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function pendingRaw(limit = 2) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const file = path.join(directory, `${stamp}_accepted_raw.json`);
    await fs.writeFile(file, JSON.stringify({
      request: { input: [{ url: groupUrl }], limit_per_input: limit },
      status: 202, response: { snapshot_id: 'sd_accepted123' },
    }));
    return file;
  }

  test('downloads one pending snapshot via GET, applies activity once and never POSTs', async () => {
    await pendingRaw();
    const [job] = await findPendingSnapshots(directory);
    expect(job.snapshotId).toBe('sd_accepted123');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { post_id: 'p1', date_posted: '2026-10-18T07:00:00Z', content: 'Apartment with no price' },
        { post_id: 'p2', date_posted: '2026-10-18T06:00:00Z', content: 'General local discussion' },
      ]), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const state = newMonitorState();
    expect(await recoverAcceptedSnapshot(job, state)).toEqual({ state: 'recovered', records: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(String(url)).toContain('/datasets/v3/');
      expect(options?.method).not.toBe('POST');
    }
    expect(state.groups[groupUrl].seenCount).toBe(2);
    expect(state.groups[groupUrl].observations).toBe(1);
    expect(await findPendingSnapshots(directory)).toHaveLength(0);
    expect((JSON.parse(await fs.readFile(job.file, 'utf8')) as { records: unknown[] }).records).toHaveLength(2);
  });

  test('transport or progress failure leaves accepted job pending for safe retry', async () => {
    await pendingRaw();
    const [job] = await findPendingSnapshots(directory);
    globalThis.fetch = jest.fn().mockRejectedValueOnce(new Error('DNS temporarily unavailable')) as typeof fetch;
    const state = newMonitorState();
    expect(await recoverAcceptedSnapshot(job, state)).toMatchObject({ state: 'waiting', records: 0 });
    expect(await findPendingSnapshots(directory)).toHaveLength(1);
    expect(state.groups[groupUrl]).toBeUndefined();
  });

  test('provider terminal failure is recorded and no longer treated as pending', async () => {
    await pendingRaw();
    const [job] = await findPendingSnapshots(directory);
    globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error_message: 'Scrape failed' }), { status: 200 })) as typeof fetch;
    expect(await recoverAcceptedSnapshot(job)).toEqual({ state: 'failed', records: 0, message: 'Scrape failed' });
    expect(await findPendingSnapshots(directory)).toHaveLength(0);
  });

  test('excess downloaded records are preserved but do not corrupt monitor', async () => {
    await pendingRaw(1);
    const [job] = await findPendingSnapshots(directory);
    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ post_id: 'a' }, { post_id: 'b' }]), { status: 200 })) as typeof fetch;
    const state = newMonitorState();
    await expect(recoverAcceptedSnapshot(job, state)).rejects.toThrow('exceeded');
    expect(state.groups[groupUrl]).toBeUndefined();
    expect((JSON.parse(await fs.readFile(job.file, 'utf8')) as { records: unknown[] }).records).toHaveLength(2);
  });
});
