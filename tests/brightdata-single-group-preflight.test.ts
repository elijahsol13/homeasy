import { buildShadowSingleGroupPlan, makeReplayPost } from '../scripts/brightdata-batch-test';

const base = {
  argv: ['node', 'brightdata-batch-test.ts', '--shadow-single-group'],
  env: { BRIGHTDATA_START_DATE: '2026-10-07', BRIGHTDATA_END_DATE: '2026-10-07' },
};

describe('Bright Data single-group shadow preflight', () => {
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

  test('pins dataset, group, one calendar day, and safety modes', () => {
    const plan = buildShadowSingleGroupPlan(base);
    expect(plan.datasetId).toBe('gd_lz11l67o2cb3r0lkj3');
    expect(plan.group.url).toBe('https://www.facebook.com/groups/495676670504992');
    expect(plan.requestBody.input).toHaveLength(1);
    expect(plan.requestBody.input[0]).toMatchObject({ start_date: '2026-10-07', end_date: '2026-10-07' });
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
