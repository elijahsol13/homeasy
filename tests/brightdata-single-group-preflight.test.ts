import {
  GROUPS, buildGroupRequest, buildShadowSingleGroupPlan, getBudgetConfig,
  getGroupsToTest, groupAccess, groupRoute, makeReplayPost,
  isPotentialHousingDemand, selectBoundedUnknownGroups, selectBoundedPublicGroups,
  validateBoundedDiscoveryInvocation,
} from '../scripts/brightdata-batch-test';

const base = {
  argv: ['node', 'brightdata-batch-test.ts', '--shadow-single-group'],
  env: { BRIGHTDATA_START_DATE: '2026-10-07', BRIGHTDATA_END_DATE: '2026-10-07' },
};

describe('Bright Data single-group shadow preflight', () => {
  test('keeps all 23 sources with evidence-backed public, private and unresolved routes', () => {
    expect(GROUPS).toHaveLength(23);
    expect(new Set(GROUPS.map((group) => group.url)).size).toBe(23);
    expect(GROUPS.filter((group) => groupAccess(group) === 'public')).toHaveLength(16);
    expect(GROUPS.filter((group) => groupAccess(group) === 'private')).toHaveLength(6);
    expect(GROUPS.filter((group) => groupAccess(group) === 'unknown')).toHaveLength(1);
    expect(GROUPS.filter((group) => groupRoute(group) === 'CAMOUFOX_DEFERRED')).toHaveLength(6);
    expect(getGroupsToTest()).toHaveLength(16);
    expect(getGroupsToTest(true)).toHaveLength(2);
    expect(getGroupsToTest().every((group) => groupAccess(group) === 'public')).toBe(true);
  });

  test('caps provider requests and rejects private/unknown groups before billing', () => {
    const budget = getBudgetConfig({});
    expect(budget).toEqual({ maxRecords: 1000, perGroupLimit: 50 });
    const body = buildGroupRequest(getGroupsToTest()[0], '2026-10-17', '2026-10-18', 50);
    expect(body.limit_per_input).toBe(50);
    expect(body.input).toHaveLength(1);
    expect(() => getBudgetConfig({ BRIGHTDATA_RECORD_BUDGET: '1001' })).toThrow();
    expect(() => getBudgetConfig({ BRIGHTDATA_PER_GROUP_LIMIT: '0' })).toThrow();
    expect(() => getBudgetConfig({ BRIGHTDATA_RECORD_BUDGET: '20', BRIGHTDATA_PER_GROUP_LIMIT: '50' })).toThrow();
    for (const blocked of GROUPS.filter((group) => groupAccess(group) !== 'public')) {
      expect(() => buildGroupRequest(blocked, '2026-10-17', '2026-10-18', 50)).toThrow();
    }
  });

  test('normalizes provider reposts whose text is nested in original_post', () => {
    const post = makeReplayPost({
      post_id: 'fb-post-1',
      url: 'https://www.facebook.com/groups/495676670504992/posts/fb-post-1/',
      original_post: {
        content: 'A rental listing shared into the group',
        attachments: [{ type: 'Photo', url: 'https://images.example/photo.jpg' }],
      },
    }, { name: 'Real Estate in Siem Reap', url: 'https://www.facebook.com/groups/495676670504992', role: 'mixed', priority: 'A' });
    expect(post).toMatchObject({ id: 'fb-post-1', content: 'A rental listing shared into the group', photos: ['https://images.example/photo.jpg'] });
  });

  test('unknown groups can be sampled explicitly, but confirmed private groups stay excluded', () => {
    const unknown = GROUPS.find((group) => groupAccess(group) === 'unknown')!;
    const privateGroup = GROUPS.find((group) => groupAccess(group) === 'private')!;
    expect(buildGroupRequest(unknown, '2026-09-18', '2026-10-18', 5, true).limit_per_input).toBe(5);
    expect(() => buildGroupRequest(privateGroup, '2026-09-18', '2026-10-18', 5, true)).toThrow();
  });

  test('only the inaccessible group stays unresolved after seven access probes', () => {
    const remaining = selectBoundedUnknownGroups(0);
    expect(remaining.map((group) => group.url)).toEqual([
      'https://www.facebook.com/groups/SiemReapOpenForum',
    ]);
    expect(remaining.every((group) => groupAccess(group) === 'unknown')).toBe(true);
    expect(() => selectBoundedUnknownGroups(1)).toThrow();
    expect(() => selectBoundedUnknownGroups(-1)).toThrow();
    expect(() => selectBoundedUnknownGroups(0.5)).toThrow();
  });

  test('resumes nine unattempted public groups after the first two already attempted', () => {
    const previous = getGroupsToTest().slice(0, 2);
    const pending = selectBoundedPublicGroups(2);
    expect(pending).toHaveLength(9);
    expect(pending.every((group) => groupAccess(group) === 'public')).toBe(true);
    expect(pending.some((group) => previous.some((old) => old.url === group.url))).toBe(false);
    expect(() => selectBoundedPublicGroups(11)).toThrow();
    expect(() => selectBoundedPublicGroups(-1)).toThrow();
    expect(() => selectBoundedPublicGroups(1.5)).toThrow();
  });

  test('requires an explicit cohort and paid resume index for historical bounded runs', () => {
    const baseArgs = ['node', 'brightdata-batch-test.ts', '--bounded-discovery'];
    expect(() => validateBoundedDiscoveryInvocation(baseArgs)).toThrow('exactly one');
    expect(() => validateBoundedDiscoveryInvocation([...baseArgs, '--public-only', '--unknown-only'])).toThrow('exactly one');
    expect(() => validateBoundedDiscoveryInvocation([...baseArgs, '--public-only', '--submit'])).toThrow('explicit --public-start-index=');
    expect(() => validateBoundedDiscoveryInvocation([...baseArgs, '--unknown-only', '--submit'])).toThrow('explicit --unknown-start-index=');
    expect(() => validateBoundedDiscoveryInvocation([...baseArgs, '--public-only', '--public-start-index=2', '--submit'])).not.toThrow();
    expect(() => validateBoundedDiscoveryInvocation([...baseArgs, '--unknown-only', '--unknown-start-index=0', '--submit'])).not.toThrow();
    expect(() => validateBoundedDiscoveryInvocation([...baseArgs, '--public-only'])).not.toThrow();
  });

  test('flags possible housing demand for review without requiring a price', () => {
    expect(isPotentialHousingDemand('Looking for a studio to rent near Siem Reap. Please DM me.')).toBe(true);
    expect(isPotentialHousingDemand('Need a house to rent, no price mentioned')).toBe(true);
    expect(isPotentialHousingDemand('Apartment available for rent 350 USD')).toBe(false);
    expect(isPotentialHousingDemand('Looking for a good mechanic')).toBe(false);
  });

  test('pins dataset, group, one calendar day, and safety modes', () => {
    const plan = buildShadowSingleGroupPlan(base);
    expect(plan.datasetId).toBe('gd_lz11l67o2cb3r0lkj3');
    expect(plan.group.url).toBe('https://www.facebook.com/groups/495676670504992');
    expect(plan.requestBody.input).toHaveLength(1);
    expect(plan.requestBody.input[0]).toMatchObject({ start_date: '2026-10-07', end_date: '2026-10-07' });
    expect(plan.requestBody.limit_per_input).toBe(50);
    expect(plan).toMatchObject({ requestCount: 1, shadowIngestion: true, legacyWriteGuard: true, paidFreshness: false });
  });

  test.each([
    ['pilot flag', { ...base, env: { ...base.env, BRIGHTDATA_PILOT: 'true' } }],
    ['wrong dataset', { ...base, env: { ...base.env, BRIGHTDATA_DATASET_ID: 'another-dataset' } }],
    ['two-day window', { ...base, env: { ...base.env, BRIGHTDATA_END_DATE: '2026-10-08' } }],
    ['invalid date', { ...base, env: { ...base.env, BRIGHTDATA_START_DATE: '2026-02-30', BRIGHTDATA_END_DATE: '2026-02-30' } }],
    ['missing one date', { ...base, env: { BRIGHTDATA_START_DATE: '2026-10-07' } }],
  ])('rejects %s before a request can be built', (_name, input) => {
    expect(() => buildShadowSingleGroupPlan(input)).toThrow();
  });
});
