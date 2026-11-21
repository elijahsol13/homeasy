import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrightDataJobStore, buildBrightDataPlan } from '../src/services/brightdata-job-control';
import { buildCollectionArgs } from '../src/brightdata-worker';

describe('admin Bright Data jobs', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-jobs-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('only reviewed jobs enable paid raw reuse', () => {
    const store = new BrightDataJobStore(path.join(dir, 'control.sqlite'));
    const first = store.enqueue(buildBrightDataPlan('top3', 1000), 1, 1, 'one');
    expect(buildCollectionArgs(first)).toEqual(['--full', '--group-ids=385053483002145,201561753758474,cheaprentsiemreap', '--submit']);
    store.claimNext();
    store.recoverInterrupted();
    const resumed = store.resumeReviewed(first.id, first.runId);
    expect(buildCollectionArgs(resumed)).toEqual(['--full', '--submit', '--resume-existing']);
    store.close();
  });

  test('two-week top three plan uses Cambodia calendar and stays below requested provider budget', () => {
    const plan = buildBrightDataPlan('top3', 1000, new Date('2026-11-08T18:00:00Z'));
    expect(plan).toMatchObject({ startDate: '2026-10-26', endDate: '2026-11-09', groupCount: 3, perGroupLimit: 334, maxRequests: 3 });
    expect(plan.groupIds).toEqual(['385053483002145', '201561753758474', 'cheaprentsiemreap']);
    expect(buildBrightDataPlan('all', 500, new Date('2026-11-08T18:00:00Z'))).toMatchObject({
      startDate: '2026-10-10', endDate: '2026-11-09', groupCount: 16, perGroupLimit: 32,
    });
    expect(() => buildBrightDataPlan('top3', 1001)).toThrow();
  });

  test('confirmation idempotency, single paid job, persisted cancel and approval gate', () => {
    const db = path.join(dir, 'control.sqlite');
    const store = new BrightDataJobStore(db);
    const plan = buildBrightDataPlan('top3', 100);
    const first = store.enqueue(plan, 15, 15, '15:27');
    expect(store.enqueue(plan, 15, 15, '15:27').id).toBe(first.id);
    expect(() => store.enqueue(plan, 15, 15, '15:28')).toThrow(/active|review/i);
    expect(store.claimNext()?.id).toBe(first.id);
    store.requestCancel(first.id);
    expect(store.isCancellationRequested(first.id)).toBe(true);
    store.update(first.id, 'cancelled', { error: 'Stopped before next POST' });
    expect(store.latest()?.status).toBe('cancelled');
    expect(store.enqueue(plan, 15, 15, '15:28').status).toBe('queued');
    store.close();
  });

  test('restart after collection prevents any new paid job until reviewed', () => {
    const db = path.join(dir, 'control.sqlite');
    const store = new BrightDataJobStore(db);
    const first = store.enqueue(buildBrightDataPlan('top3', 100), 15, 15, '15:29');
    store.claimNext();
    store.close();
    const restarted = new BrightDataJobStore(db);
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(restarted.get(first.id)?.status).toBe('needs_review');
    expect(() => restarted.enqueue(buildBrightDataPlan('top3', 500), 15, 15, '15:30')).toThrow(/review/i);
    restarted.close();
  });

  test('reviewed original job expands to all groups without changing identity, dates or budget', () => {
    const store = new BrightDataJobStore(path.join(dir, 'control.sqlite'));
    const job = store.enqueue(buildBrightDataPlan('top3', 1000, new Date('2026-11-08T18:00:00Z')), 15, 15, 'original');
    expect(() => store.resumeReviewed(job.id, job.runId)).toThrow(/review/i);
    store.claimNext();
    store.recoverInterrupted();
    expect(() => store.resumeReviewed(job.id, 'wrong-run')).toThrow(/run/i);
    const resumed = store.resumeReviewed(job.id, job.runId);
    expect(resumed).toMatchObject({
      id: job.id, runId: job.runId, createdAt: job.createdAt,
      budget: 1000, startDate: '2026-10-26', endDate: '2026-11-09',
      status: 'queued', scope: 'all', groupIds: [], groupCount: 16,
      perGroupLimit: 45, maxRequests: 16, resumeExisting: true,
    });
    expect(store.claimNext()?.id).toBe(job.id);
    expect(() => store.resumeReviewed(job.id, job.runId)).toThrow(/review/i);
    store.close();
  });
});
