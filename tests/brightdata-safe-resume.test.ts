import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrightDataJobStore, buildBrightDataPlan } from '../src/services/brightdata-job-control';
import {
  getGroupsToTest, inspectSavedBrightDataResponse, prioritizeHousingYield,
  distributeRemainingRecordCaps, findPendingSnapshots,
} from '../scripts/brightdata-batch-test';

describe('paid Bright Data resume safeguards', () => {
  const ordered = prioritizeHousingYield(getGroupsToTest());
  const first = ordered[0];
  const request = {
    input: [{ url: first.url, start_date: '2026-10-26', end_date: '2026-11-09', user_to_not_include: '' }],
    limit_per_input: 334,
  };
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brightdata-resume-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function save(overrides: Record<string, unknown>) {
    const filename = path.join(dir, 'saved_raw.json');
    await fs.writeFile(filename, JSON.stringify({
      request, status: 202, state: 'snapshot_recovered', records: [{ post_id: '123', content: 'Room for rent' }],
      ...overrides,
    }));
    return filename;
  }

  test('orders previously most productive groups before the others', () => {
    expect(ordered.slice(0, 5).map((g) => g.url.split('/').pop())).toEqual([
      '385053483002145', '201561753758474', 'cheaprentsiemreap',
      'siemreaprealestate', '1979336498978784',
    ]);
    expect(new Set(ordered.map((g) => g.url)).size).toBe(16);
  });

  test('accepts the recovered 334-slot request with the exact original dates', async () => {
    const file = await save({});
    await expect(inspectSavedBrightDataResponse(file, first, '2026-10-26', '2026-11-09'))
      .resolves.toMatchObject({ requestLimit: 334, httpStatus: 202, records: [{ post_id: '123' }] });
  });

  test('allocates exactly 666 remaining paid slots across 15 groups in priority order', () => {
    const allocation = distributeRemainingRecordCaps(ordered.map((g) => g.url), new Set([first.url]), 1000, 334);
    expect(allocation.get(first.url)).toBeUndefined();
    expect([...allocation.values()]).toEqual([...Array(6).fill(45), ...Array(9).fill(44)]);
    expect([...allocation.values()].reduce((sum, cap) => sum + cap, 334)).toBe(1000);
  });

  test('resumes all 16 groups using the existing 334 posts and exactly 666 new request slots', async () => {
    const store = new BrightDataJobStore(path.join(dir, 'control.sqlite'));
    const original = store.enqueue(buildBrightDataPlan('top3', 1000, new Date('2026-11-08T18:00:00Z')), 1, 1, 'paid-original');
    store.claimNext();
    store.recoverInterrupted();
    const job = store.resumeReviewed(original.id, original.runId);
    store.close();
    const rawKey = `${first.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50)}_${crypto.createHash('sha256').update(first.url).digest('hex').slice(0, 10)}`;
    await fs.writeFile(path.join(dir, `${job.runId}_${rawKey}_raw.json`), JSON.stringify({
      request, status: 202, state: 'snapshot_recovered', snapshotId: 'already-billed',
      records: Array.from({ length: 334 }, (_, i) => ({ post_id: `paid-${i}`, original_post: { content: 'Room for rent' } })),
    }));

    const keys = ['BRIGHTDATA_RUN_ID', 'BRIGHTDATA_OUTPUT_DIR', 'BRIGHTDATA_START_DATE', 'BRIGHTDATA_END_DATE',
      'BRIGHTDATA_RECORD_BUDGET', 'BRIGHTDATA_PER_GROUP_LIMIT', 'BRIGHTDATA_STRICT_BUDGET',
      'BRIGHTDATA_CONTROL_JOB_ID', 'BRIGHTDATA_CONTROL_DB', 'BRIGHTDATA_API_KEY'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const originalArgv = process.argv;
    const originalFetch = global.fetch;
    const requests: Array<{ url: string; limit: number }> = [];
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      Object.assign(process.env, {
        BRIGHTDATA_RUN_ID: job.runId, BRIGHTDATA_OUTPUT_DIR: dir,
        BRIGHTDATA_START_DATE: job.startDate, BRIGHTDATA_END_DATE: job.endDate,
        BRIGHTDATA_RECORD_BUDGET: '1000', BRIGHTDATA_PER_GROUP_LIMIT: '45',
        BRIGHTDATA_STRICT_BUDGET: 'true', BRIGHTDATA_CONTROL_JOB_ID: job.id,
        BRIGHTDATA_CONTROL_DB: path.join(dir, 'control.sqlite'), BRIGHTDATA_API_KEY: 'local-test-only',
      });
      process.argv = ['node', 'batch', '--full', '--submit', '--resume-existing'];
      global.fetch = jest.fn(async (url, options) => {
        if (options?.method !== 'POST' || !String(url).includes('/scrape?')) throw new Error('Unexpected external request');
        const body = JSON.parse(String(options.body)) as { input: Array<{ url: string }>; limit_per_input: number };
        requests.push({ url: body.input[0].url, limit: body.limit_per_input });
        return new Response(JSON.stringify(Array.from({ length: body.limit_per_input }, (_, i) => ({
          post_id: `${requests.length}-${i}`, original_post: { content: 'Room for rent' },
        }))), { status: 200 });
      }) as typeof fetch;
      let run: typeof import('../scripts/brightdata-batch-test').runBrightDataBatch;
      jest.isolateModules(() => { run = require('../scripts/brightdata-batch-test').runBrightDataBatch; });
      await run!();

      expect(requests.map((row) => row.url)).toEqual(ordered.slice(1).map((group) => group.url));
      expect(requests.map((row) => row.limit)).toEqual([...Array(6).fill(45), ...Array(9).fill(44)]);
      const plan = JSON.parse(await fs.readFile(path.join(dir, `${job.runId}_resume_plan.json`), 'utf8'));
      expect(plan.groups.map((group: { cap: number }) => group.cap)).toEqual([334, ...Array(6).fill(45), ...Array(9).fill(44)]);
      expect(plan.maxExpectedRecords).toBe(1000);
      const summary = JSON.parse(await fs.readFile(path.join(dir, `${job.runId}_summary.json`), 'utf8'));
      expect(summary).toMatchObject({ totalGroups: 16, groupsAttempted: 16, recordsReceived: 1000, stopReason: null });
      expect((await fs.readdir(dir)).filter((filename) => filename.endsWith('_raw.json'))).toHaveLength(16);
    } finally {
      global.fetch = originalFetch;
      process.argv = originalArgv;
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      log.mockRestore();
    }
  }, 45000);

  test.each(['request_prepared', 'transport_error'])(
    'blocks a possibly billable %s request before any new POST', async (state) => {
      const file = path.join(dir, '2026-11-09T09-24-59_abcd00_test_raw.json');
      await fs.writeFile(file, JSON.stringify({ request, state, status: null, response: null }));
      await expect(findPendingSnapshots(dir, Date.parse('2026-11-09T10:00:00Z'))).rejects.toThrow(/ambiguous|manual/i);
    },
  );

  test.each([
    [{ request: { ...request, limit_per_input: 0 } }, /group\/dates\/limit/],
    [{ request: { ...request, input: [{ ...request.input[0], start_date: '2026-10-25' }] } }, /group\/dates\/limit/],
    [{ status: 202, records: undefined, response: { snapshot_id: 'pending' } }, /unresolved/],
    [{ state: 'request_prepared', status: null, records: undefined }, /not confirmed/],
    [{ records: [{ error: 'Private group' }] }, /error record/],
    [{ request: { ...request, limit_per_input: 1 }, records: [{ post_id: '1' }, { post_id: '2' }] }, /exceeded/],
  ])('refuses ambiguous, mismatched, failed or over-budget saved requests', async (overrides, error) => {
    const file = await save(overrides);
    await expect(inspectSavedBrightDataResponse(file, first, '2026-10-26', '2026-11-09')).rejects.toThrow(error);
  });
});
