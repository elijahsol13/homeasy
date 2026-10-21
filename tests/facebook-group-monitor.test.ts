import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newMonitorState, observeGroup, planGroups, applyGroupClassifications } from '../src/modules/parser/facebook-group-monitor';
import { importSavedObservations } from '../scripts/brightdata-group-monitor';
import { GROUPS, groupRoute } from '../scripts/brightdata-batch-test';

const groupUrl = 'https://www.facebook.com/groups/385053483002145';
const one = { name: 'Rental & Sale', url: groupUrl, role: 'mixed', priority: 'A' as const, route: 'BRIGHTDATA' as const };

function samples(prefix: string, from: string, count: number, stepMinutes = 10): unknown[] {
  const end = Date.parse(from);
  return Array.from({ length: count }, (_, i) => ({
    post_id: `${prefix}${i}`, date_posted: new Date(end - i * stepMinutes * 60_000).toISOString(),
    user_url: 'https://facebook.com/a', content: `Available apartment in Siem Reap - unit ${i} newly refurbished`,
  }));
}

describe('Facebook group activity and adaptive planner', () => {
  test('uses all posts for velocity, including irrelevant ones; samples remain idempotent', () => {
    const state = newMonitorState();
    const rows = samples('p', '2026-10-18T06:00:00Z', 20);
    const first = observeGroup(state, { key: 'first', groupUrl, observedAt: '2026-10-18T07:00:00Z', requestedLimit: 20, records: rows,
      classes: Object.fromEntries(rows.map((row, i) => [(row as { post_id: string }).post_id, i === 0 ? 'HOUSING_SUPPLY' : 'IRRELEVANT'])) });
    expect(first.seenCount).toBe(20);
    expect(first.estimatedPostsPerHour).toBeGreaterThan(5);
    expect(first.supply).toBe(1);
    expect(first.irrelevant).toBe(19);
    expect(first.ordering).toBe('newest_first');
    expect(observeGroup(state, { key: 'first', groupUrl, observedAt: '2026-10-18T07:00:00Z', requestedLimit: 20, records: rows }).observations).toBe(1);
    const plan = planGroups(state, [one], '2026-10-18T08:00:00Z', 50)[0];
    expect(plan.intervalHours).toBeLessThan(5);
    expect(plan.limit).toBe(50);
  });

  test('detects overlap, potential gaps, and reordered feeds separately', () => {
    const state = newMonitorState();
    observeGroup(state, { key: '1', groupUrl, observedAt: '2026-10-18T02:00:00Z', requestedLimit: 3,
      records: samples('a', '2026-10-18T01:00:00Z', 3) });
    const overlap = observeGroup(state, { key: '2', groupUrl, observedAt: '2026-10-18T03:00:00Z', requestedLimit: 3,
      records: [ ...samples('b', '2026-10-18T02:00:00Z', 2), ...samples('a', '2026-10-18T01:00:00Z', 1) ] });
    expect(overlap.coverage).toBe('overlap');
    const gap = observeGroup(state, { key: '3', groupUrl, observedAt: '2026-10-18T11:00:00Z', requestedLimit: 3,
      records: samples('c', '2026-10-18T10:00:00Z', 3) });
    expect(gap.coverage).toBe('possible_gap');
    expect(gap.coverageGaps).toBe(1);
    expect(planGroups(state, [one], '2026-10-18T11:01:00Z', 100)[0].intervalHours).toBeLessThanOrEqual(2);
    const reversed = samples('d', '2026-10-18T12:00:00Z', 4).reverse();
    const outOfOrder = observeGroup(state, { key: '4', groupUrl, observedAt: '2026-10-18T13:00:00Z', requestedLimit: 4, records: reversed });
    expect(outOfOrder.ordering).toBe('non_chronological');
    expect(outOfOrder.coverage).toBe('unknown');
    expect(outOfOrder.nonChronologicalSamples).toBe(1);
  });

  test('keeps demand, private groups and no-price rows without excluding low-yield traffic', () => {
    const state = newMonitorState();
    const records = [{ post_id: 'want', content: 'Need rental flat', date_posted: '2026-10-17T10:00:00Z' },
      { post_id: 'supply', content: 'Room available, price on request', date_posted: '2026-10-17T09:00:00Z' }];
    const stats = observeGroup(state, { key: 'x', groupUrl, observedAt: '2026-10-18T10:00:00Z', requestedLimit: 50,
      records, classes: { want: 'HOUSING_DEMAND', supply: 'HOUSING_SUPPLY' } });
    expect(stats.demand).toBe(1);
    expect(stats.supply).toBe(1);
    const plan = planGroups(state, GROUPS.map((g) => ({ ...g, route: groupRoute(g) })), '2026-10-20T12:00:00Z', 80);
    expect(plan.filter((g) => g.route === 'BRIGHTDATA')).toHaveLength(16);
    expect(plan.filter((g) => g.route === 'CAMOUFOX_DEFERRED' && !g.due)).toHaveLength(6);
    expect(plan.filter((g) => g.route === 'REVIEW' && !g.due)).toHaveLength(1);
  });

  test('same author with new ID and same content is a repost signal, not confirmed availability', () => {
    const state = newMonitorState();
    const original = { post_id: 'p1', user_url: 'https://facebook.com/agent', content: 'A lovely apartment in Siem Reap for monthly rent', date_posted: '2026-10-17T10:00:00Z' };
    observeGroup(state, { key: '1', groupUrl, observedAt: '2026-10-17T11:00:00Z', requestedLimit: 10, records: [original] });
    const newer = { ...original, post_id: 'p2', date_posted: '2026-10-18T10:00:00Z' };
    const result = observeGroup(state, { key: '2', groupUrl, observedAt: '2026-10-18T11:00:00Z', requestedLimit: 10, records: [newer] });
    expect(result.sameAuthorReposts).toBe(1);
    expect(result.seenCount).toBe(2);
  });

  test('first empty or undated observation has no fabricated publication time or rate', () => {
    const state = newMonitorState();
    const empty = observeGroup(state, { key: 'empty', groupUrl, observedAt: '2026-10-18T03:00:00Z', requestedLimit: 10,
      records: [{ error: 'Group inaccessible' }] });
    expect(empty.newestPostedAt).toBeNull();
    expect(empty.seenCount).toBe(0);
    const undated = observeGroup(state, { key: 'undated', groupUrl, observedAt: '2026-10-18T04:00:00Z', requestedLimit: 10,
      records: [{ post_id: 'post1', content: 'No date available' }] });
    expect(undated.newestPostedAt).toBeNull();
    expect(undated.estimatedPostsPerHour).toBeNull();
    expect(undated.coverage).toBe('unknown');
  });

  test('classification arriving after initial raw import updates historical yield without duplicating posts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeasy-group-monitor-'));
    const run = '2026-10-18T07-00-00';
    const raw = `${run}_example_raw.json`;
    const state = newMonitorState();
    try {
      await fs.writeFile(path.join(directory, raw), JSON.stringify({ request: { input: [{ url: groupUrl }], limit_per_input: 10 },
        response: [{ post_id: 'rent1', date_posted: '2026-10-18T06:00:00Z', content: 'Apartment with price on request' }] }));
      expect(await importSavedObservations(state, directory)).toMatchObject({ imported: 1, classified: 0 });
      expect(state.groups[groupUrl].supply).toBe(0);
      await fs.writeFile(path.join(directory, `${run}_classified.json`), JSON.stringify({
        posts: [{ id: 'rent1', groupUrl, classification: 'HOUSING_SUPPLY' }],
      }));
      expect(await importSavedObservations(state, directory)).toMatchObject({ imported: 0, classified: 1 });
      expect(state.groups[groupUrl].supply).toBe(1);
      expect(state.groups[groupUrl].seenCount).toBe(1);
      expect(await importSavedObservations(state, directory)).toMatchObject({ imported: 0, classified: 0 });
      expect(applyGroupClassifications(state, groupUrl, { nonexistent: 'HOUSING_DEMAND' })).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('a failed AI batch stays unknown and a separate retry can recover the labels', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeasy-classify-retry-'));
    const run = '2026-10-18T09-03-28';
    const state = newMonitorState();
    try {
      await fs.writeFile(path.join(directory, `${run}_group_raw.json`), JSON.stringify({
        request: { input: [{ url: groupUrl }], limit_per_input: 10 },
        records: [{ post_id: 'offer', date_posted: '2026-10-18T08:00:00Z', content: 'Apartment, price on request' },
          { post_id: 'request', date_posted: '2026-10-18T07:00:00Z', content: 'Seeking apartment' }],
      }));
      await fs.writeFile(path.join(directory, `${run}_classified.json`), JSON.stringify({
        posts: [
          { id: 'offer', groupUrl, classification: 'UNCLASSIFIED' },
          { id: 'request', groupUrl, classification: 'UNCLASSIFIED' },
        ],
      }));
      expect(await importSavedObservations(state, directory)).toEqual({ imported: 1, skipped: 0, classified: 0 });
      expect(state.groups[groupUrl].unclassified).toBe(2);
      expect(state.groups[groupUrl].supply).toBe(0);
      expect(applyGroupClassifications(state, groupUrl, { offer: 'UNCLASSIFIED' })).toBe(0);

      await fs.writeFile(path.join(directory, `${run}-retry1_classified.json`), JSON.stringify({
        posts: [
          { id: 'offer', groupUrl, classification: 'HOUSING_SUPPLY' },
          { id: 'request', groupUrl, classification: 'HOUSING_DEMAND' },
        ],
      }));
      expect(await importSavedObservations(state, directory)).toEqual({ imported: 0, skipped: 1, classified: 2 });
      expect(state.groups[groupUrl]).toMatchObject({ observations: 1, seenCount: 2, supply: 1, demand: 1, unclassified: 0 });
      expect(applyGroupClassifications(state, groupUrl, { offer: 'UNCLASSIFIED' })).toBe(0);
      expect(state.groups[groupUrl].supply).toBe(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
