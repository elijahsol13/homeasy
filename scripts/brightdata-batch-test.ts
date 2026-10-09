/**
 * HomEasy — Bright Data Facebook Groups eligibility test
 *
 * Tests which public Facebook groups are scrapable via Bright Data's
 * "Facebook - Posts by group URL" dataset (dataset_id gd_lz11l67o2cb3r0lkj3).
 *
 * Design choices based on pre-flight review:
 *   - BATCH_SIZE = 1: each request maps to exactly one group, so we do not need
 *     to guess how Bright Data links records back to input URLs.
 *   - Legacy multi-group behavior remains available for explicit use.
 *   - --shadow-single-group is fail-closed and prints a one-day, one-group
 *     payload without sending it; add --submit only after the separate go-ahead.
 *   - Handles HTTP 202 + snapshot_id: sync /scrape can switch to async if it
 *     takes longer than 1 minute. We poll progress and download the snapshot.
 *   - Raw responses and summary JSON are saved to tmp/brightdata-test/.
 *
 * Requires BRIGHTDATA_API_KEY in .env.
 *
 * Usage:
 *   npm run brightdata:test:groups
 *   BRIGHTDATA_START_DATE=YYYY-MM-DD BRIGHTDATA_END_DATE=YYYY-MM-DD \
 *     npm run brightdata:test:groups -- --shadow-single-group
 *   # Submission is a separate explicit action: append --submit.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATASET_ID = 'gd_lz11l67o2cb3r0lkj3';
const API_BASE = 'https://api.brightdata.com/datasets/v3';
const OUTPUT_DIR = path.resolve(process.cwd(), 'tmp', 'brightdata-test');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BATCH_SIZE = 1;
const DELAY_MS = 1000;
const SNAPSHOT_POLL_INTERVAL_MS = 3000;
const SNAPSHOT_MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
const SHADOW_SINGLE_GROUP_URL = 'https://www.facebook.com/groups/495676670504992';
const SHADOW_GROUP_NAME = 'Real Estate in Siem Reap';

interface ShadowSingleGroupPlan {
  datasetId: string;
  group: GroupConfig;
  startDate: string;
  endDate: string;
  requestBody: { input: Array<{ url: string; start_date: string; end_date: string; user_to_not_include: string }> };
  shadowIngestion: true;
  legacyWriteGuard: true;
  paidFreshness: false;
  requestCount: 1;
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Pure fail-closed gate; called before API-key lookup and before any fetch. */
export function buildShadowSingleGroupPlan(args: {
  argv: string[];
  env: NodeJS.ProcessEnv;
}): ShadowSingleGroupPlan {
  if (!args.argv.includes('--shadow-single-group')) throw new Error('Missing --shadow-single-group');
  if (args.argv.includes('--pilot') || args.env.BRIGHTDATA_PILOT === 'true') {
    throw new Error('BRIGHTDATA_PILOT/--pilot is forbidden in --shadow-single-group mode');
  }
  if (args.env.BRIGHTDATA_DATASET_ID && args.env.BRIGHTDATA_DATASET_ID !== DATASET_ID) {
    throw new Error(`Dataset override rejected; required ${DATASET_ID}`);
  }
  const startDate = args.env.BRIGHTDATA_START_DATE ?? '';
  const endDate = args.env.BRIGHTDATA_END_DATE ?? '';
  if (!isIsoCalendarDate(startDate) || !isIsoCalendarDate(endDate) || startDate !== endDate) {
    throw new Error('Set BRIGHTDATA_START_DATE and BRIGHTDATA_END_DATE to the same valid YYYY-MM-DD calendar date');
  }
  const group = GROUPS.find((item) => item.url === SHADOW_SINGLE_GROUP_URL);
  if (!group || GROUPS.filter((item) => item.url === SHADOW_SINGLE_GROUP_URL).length !== 1) {
    throw new Error('Pinned single-group configuration is missing or ambiguous');
  }
  return {
    datasetId: DATASET_ID,
    group: { ...group, name: SHADOW_GROUP_NAME },
    startDate,
    endDate,
    requestBody: { input: [{ url: SHADOW_SINGLE_GROUP_URL, start_date: startDate, end_date: endDate, user_to_not_include: '' }] },
    shadowIngestion: true,
    legacyWriteGuard: true,
    paidFreshness: false,
    requestCount: 1,
  };
}

interface GroupConfig {
  name: string;
  url: string;
  role: 'demand' | 'supply' | 'mixed' | 'community';
  priority: 'A' | 'B' | 'C';
  notes?: string;
}

interface GroupResult {
  name: string;
  url: string;
  role: string;
  priority: string;
  status: 'success' | 'no_records' | 'api_error' | 'account_inactive' | 'unsupported_or_private' | 'snapshot_timeout' | 'unknown';
  recordsReturned: number;
  httpStatus: number;
  error?: string;
  sample?: unknown;
}

// Demand-first order, based on SIEM_REAP_SOURCES.md.
// Likely-private groups are at the end so the pilot can pick two public + one private.
const GROUPS: GroupConfig[] = [
  {
    name: 'Siem Reap Expats & Locals',
    url: 'https://www.facebook.com/groups/SiemReapExpatsLocals',
    role: 'mixed',
    priority: 'A',
    notes: 'Best demand source, ~50.8K members, confirmed public',
  },
  {
    name: 'Real Estate in Siem Reap',
    url: 'https://www.facebook.com/groups/495676670504992',
    role: 'mixed',
    priority: 'A',
  },
  {
    name: 'Expats and locals living in Siem Reap, Cambodia',
    url: 'https://www.facebook.com/groups/900185676717876',
    role: 'mixed',
    priority: 'A',
  },
  {
    name: 'Rental & Sale Siem Reap',
    url: 'https://www.facebook.com/groups/385053483002145',
    role: 'mixed',
    priority: 'A',
  },
  {
    name: 'Siem Reap Real Estate',
    url: 'https://www.facebook.com/groups/siemreaprealestate',
    role: 'mixed',
    priority: 'A',
  },
  {
    name: 'SIEM REAP Rent House, Villa, Apartment...',
    url: 'https://www.facebook.com/groups/201561753758474',
    role: 'mixed',
    priority: 'A',
  },
  {
    name: 'Locals and Expats Living in Siem Reap',
    url: 'https://www.facebook.com/groups/366920920387861',
    role: 'mixed',
    priority: 'A',
  },
  {
    name: 'Siem Reap Expats',
    url: 'https://www.facebook.com/groups/392548891350210',
    role: 'community',
    priority: 'B',
  },
  {
    name: 'SIEM REAP EXPAT CONNECTIONS',
    url: 'https://www.facebook.com/groups/binleangheng',
    role: 'community',
    priority: 'B',
    notes: 'Suspicious slug — likely renamed group',
  },
  {
    name: 'siem reap buy and sell',
    url: 'https://www.facebook.com/groups/youthfitness2014',
    role: 'supply',
    priority: 'B',
    notes: 'Suspicious slug — likely renamed group',
  },
  {
    name: 'Siem Reap Buy and Sell',
    url: 'https://www.facebook.com/groups/1979336498978784',
    role: 'supply',
    priority: 'B',
  },
  {
    name: 'Events & Activities in Siem Reap',
    url: 'https://www.facebook.com/groups/493840595946947',
    role: 'community',
    priority: 'B',
  },
  {
    name: 'Siem Reap Ex-Pat Truly Open Group',
    url: 'https://www.facebook.com/groups/598569030200616',
    role: 'community',
    priority: 'B',
  },
  {
    name: 'Ex-Pats and Locals In Siem Reap',
    url: 'https://www.facebook.com/groups/270186473437566',
    role: 'community',
    priority: 'C',
  },
  {
    name: 'Siem Reap Community',
    url: 'https://www.facebook.com/groups/siemreapcommunity',
    role: 'community',
    priority: 'C',
  },
  {
    name: 'Siem Reap Open Forum',
    url: 'https://www.facebook.com/groups/SiemReapOpenForum',
    role: 'community',
    priority: 'C',
  },
  {
    name: 'Siem Reap Expat Connection',
    url: 'https://www.facebook.com/groups/SiemReapExpatConnection',
    role: 'community',
    priority: 'C',
  },
  {
    name: 'Anything for Sale or Rent in Siem Reap',
    url: 'https://www.facebook.com/groups/408946849297703',
    role: 'mixed',
    priority: 'B',
    notes: 'High noise',
  },
  {
    name: 'Cheap Rent Siem Reap',
    url: 'https://www.facebook.com/groups/cheaprentsiemreap',
    role: 'mixed',
    priority: 'B',
  },
  {
    name: 'Expats & Locals Living in SiemReap',
    url: 'https://www.facebook.com/groups/handstandcalisthenics',
    role: 'mixed',
    priority: 'B',
    notes: 'Pending join + outdated slug',
  },
  {
    name: 'Камбоджа — все там будем!',
    url: 'https://www.facebook.com/groups/cambodiana',
    role: 'mixed',
    priority: 'C',
  },
  // Likely private — included to confirm failure / private status
  {
    name: 'Expats and locals living in Siem Reap (likely private)',
    url: 'https://www.facebook.com/groups/siemreap',
    role: 'mixed',
    priority: 'C',
    notes: 'Likely private; expect BD to fail',
  },
  {
    name: 'Siem Reap Residents (likely private)',
    url: 'https://www.facebook.com/groups/233923189986441',
    role: 'community',
    priority: 'C',
    notes: 'Likely private / contradictory; expect BD to fail',
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDateWindow(): { startDate: string; endDate: string } {
  const envStart = process.env.BRIGHTDATA_START_DATE;
  const envEnd = process.env.BRIGHTDATA_END_DATE;

  if (envStart && envEnd) {
    return { startDate: envStart, endDate: envEnd };
  }

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const fmt = (d: Date) => d.toISOString().split('T')[0];
  return { startDate: fmt(yesterday), endDate: fmt(now) };
}

function getGroupsToTest(): GroupConfig[] {
  const pilot = process.env.BRIGHTDATA_PILOT === 'true';
  if (!pilot) return GROUPS;

  // Two known-public A groups + one likely-private group.
  const likelyPrivate = GROUPS.find((g) => g.url === 'https://www.facebook.com/groups/siemreap') ?? GROUPS[GROUPS.length - 1];
  return [GROUPS[0], GROUPS[1], likelyPrivate];
}

function statusIcon(status: GroupResult['status']): string {
  switch (status) {
    case 'success':
      return '✅';
    case 'no_records':
      return '🟡';
    case 'unsupported_or_private':
      return '🔒';
    case 'api_error':
      return '❌';
    case 'account_inactive':
      return '💤';
    case 'snapshot_timeout':
      return '⏳';
    case 'unknown':
      return '❓';
    default:
      return '❓';
  }
}

function getRecordError(rec: unknown): string | undefined {
  if (!rec || typeof rec !== 'object') return undefined;
  const r = rec as Record<string, unknown>;
  for (const key of ['error', 'error_message', 'message']) {
    if (typeof r[key] === 'string' && r[key]) {
      return String(r[key]);
    }
  }
  return undefined;
}

function partitionRecords(records: unknown[]): { actualRecords: unknown[]; errorRecords: string[] } {
  const actualRecords: unknown[] = [];
  const errorRecords: string[] = [];
  for (const rec of records) {
    const err = getRecordError(rec);
    if (err) {
      errorRecords.push(err);
    } else {
      actualRecords.push(rec);
    }
  }
  return { actualRecords, errorRecords };
}

async function pollSnapshot(snapshotId: string): Promise<{ status: 'ready' | 'failed' | 'timeout'; errorMessage?: string }> {
  const deadline = Date.now() + SNAPSHOT_MAX_POLL_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/progress/${snapshotId}`, {
      headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` },
    });
    if (!res.ok) {
      return { status: 'failed', errorMessage: `Progress HTTP ${res.status}` };
    }
    const body = (await res.json()) as { status?: string; error_message?: string };
    if (body.status === 'ready') return { status: 'ready' };
    if (body.status === 'failed') return { status: 'failed', errorMessage: body.error_message || 'Snapshot failed' };
    await sleep(SNAPSHOT_POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

async function downloadSnapshot(snapshotId: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/snapshot/${snapshotId}?format=json`, {
    headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Snapshot download HTTP ${res.status}`);
  }
  return res.json();
}

async function callBrightData(group: GroupConfig): Promise<{ records: unknown[]; httpStatus: number; snapshotId?: string; error?: string }> {
  const { startDate, endDate } = getDateWindow();
  const url = `${API_BASE}/scrape?dataset_id=${DATASET_ID}&include_errors=true&format=json`;
  const body = {
    input: [
      {
        url: group.url,
        start_date: startDate,
        end_date: endDate,
        user_to_not_include: '',
      },
    ],
  };

  const safeName = group.name.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  const rawFile = path.join(OUTPUT_DIR, `${RUN_ID}_${safeName}_raw.json`);
  await fs.writeFile(rawFile, JSON.stringify({ request: body, status: null, response: null, state: 'request_prepared' }, null, 2));

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const cause = err instanceof Error && 'cause' in err ? (err as Error & { cause?: unknown }).cause : undefined;
    await fs.writeFile(rawFile, JSON.stringify({
      request: body,
      status: null,
      response: null,
      state: 'transport_error',
      error: err instanceof Error ? err.message : String(err),
      cause: cause instanceof Error ? { name: cause.name, message: cause.message, code: 'code' in cause ? String((cause as Error & { code?: unknown }).code ?? '') : undefined } : undefined,
    }, null, 2));
    throw err;
  }

  const rawText = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { parseError: true, rawText: rawText.slice(0, 500) };
  }

  // Save the provider response before any classification. Async responses are
  // replaced below with the actual downloaded snapshot, while retaining the
  // original 202 metadata.
  await fs.writeFile(rawFile, JSON.stringify({ request: body, status: res.status, response: parsed }, null, 2));

  if (res.status === 401 || res.status === 403) {
    return { records: [], httpStatus: res.status, error: 'Authentication failed — check BRIGHTDATA_API_KEY' };
  }

  if (res.status === 202) {
    const snapshotBody = parsed as { snapshot_id?: string };
    if (!snapshotBody.snapshot_id) {
      return { records: [], httpStatus: res.status, error: '202 without snapshot_id' };
    }
    const poll = await pollSnapshot(snapshotBody.snapshot_id);
    if (poll.status !== 'ready') {
      return {
        records: [],
        httpStatus: res.status,
        snapshotId: snapshotBody.snapshot_id,
        error: poll.status === 'timeout' ? 'Snapshot polling timed out' : poll.errorMessage,
      };
    }
    const data = await downloadSnapshot(snapshotBody.snapshot_id);
    await fs.writeFile(rawFile, JSON.stringify({ request: body, status: res.status, snapshotId: snapshotBody.snapshot_id, response: parsed, records: data }, null, 2));
    return { records: Array.isArray(data) ? data : [], httpStatus: res.status, snapshotId: snapshotBody.snapshot_id };
  }

  if (!res.ok) {
    const errorMessage = typeof parsed === 'object' && parsed !== null && 'message' in parsed
      ? String(parsed.message)
      : rawText.slice(0, 200);
    return { records: [], httpStatus: res.status, error: errorMessage };
  }

  if (Array.isArray(parsed)) {
    return { records: parsed, httpStatus: res.status };
  }

  return { records: [], httpStatus: res.status, error: 'Unexpected response shape (expected array)', snapshotId: (parsed as { snapshot_id?: string }).snapshot_id };
}

export function makeReplayPost(record: unknown, group: GroupConfig): Record<string, unknown> | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as Record<string, unknown>;
  const originalPost = row.original_post && typeof row.original_post === 'object'
    ? row.original_post as Record<string, unknown>
    : {};
  const id = String(row.post_id ?? '').trim();
  const content = String(row.content ?? originalPost.content ?? '').trim();
  if (!id || !content) return null;
  const attachments = Array.isArray(row.attachments) && row.attachments.length
    ? row.attachments
    : Array.isArray(originalPost.attachments) ? originalPost.attachments : [];
  const photos = [...new Set(attachments.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const attachment = item as Record<string, unknown>;
    const kind = String(attachment.type ?? attachment.mime_type ?? '').toLowerCase();
    if (kind.includes('video') || (kind !== 'photo' && !kind.includes('image'))) return [];
    const photoUrl = String(attachment.downloadable_url ?? attachment.url ?? '');
    return /^https?:\/\//i.test(photoUrl) ? [photoUrl] : [];
  }))].sort();
  return {
    id,
    content,
    groupId: String(row.group_id ?? '495676670504992'),
    groupName: String(row.group_name ?? group.name),
    groupUrl: String(row.group_url ?? group.url),
    postUrl: String(row.url ?? ''),
    datePosted: String(row.date_posted ?? ''),
    source: group.url,
    userUrl: row.user_url ? String(row.user_url) : undefined,
    userName: row.user_username_raw ? String(row.user_username_raw) : undefined,
    photos,
  };
}

function determineStatus(records: unknown[], httpStatus: number, error?: string): GroupResult['status'] {
  if (httpStatus === 401 || httpStatus === 403) return 'api_error';
  const lowerError = error?.toLowerCase() ?? '';
  if (lowerError.includes('customer is not active') || lowerError.includes('account is not active') || lowerError.includes('not active')) {
    return 'account_inactive';
  }
  if (lowerError.includes('private')) return 'unsupported_or_private';
  if (lowerError.includes('unsupported')) return 'unsupported_or_private';
  if (error?.includes('timed out')) return 'snapshot_timeout';
  if (!Array.isArray(records)) return 'unknown';
  if (records.length === 0) return 'no_records';
  return 'success';
}

async function testGroup(group: GroupConfig): Promise<GroupResult> {
  try {
    const { records, httpStatus, error } = await callBrightData(group);
    const { actualRecords, errorRecords } = partitionRecords(records);

    const combinedError = [error, ...errorRecords]
      .filter(Boolean)
      .join('; ')
      .slice(0, 500);

    const status = determineStatus(actualRecords, httpStatus, combinedError || undefined);
    return {
      name: group.name,
      url: group.url,
      role: group.role,
      priority: group.priority,
      status,
      recordsReturned: actualRecords.length,
      httpStatus,
      error: combinedError || undefined,
      sample: actualRecords[0],
    };
  } catch (err) {
    return {
      name: group.name,
      url: group.url,
      role: group.role,
      priority: group.priority,
      status: 'unknown',
      recordsReturned: 0,
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const singleGroupMode = process.argv.includes('--shadow-single-group');
  let singleGroupPlan: ShadowSingleGroupPlan | undefined;
  if (singleGroupMode) {
    // This gate runs before reading credentials and, critically, before fetch.
    singleGroupPlan = buildShadowSingleGroupPlan({ argv: process.argv, env: process.env });
    const payload = {
      dataset_id: singleGroupPlan.datasetId,
      endpoint: `${API_BASE}/scrape?dataset_id=${singleGroupPlan.datasetId}&include_errors=true&format=json`,
      ...singleGroupPlan.requestBody,
    };
    console.log('🔒 Single-group shadow preflight passed (no request sent).');
    console.log(JSON.stringify({
      dataset_id: singleGroupPlan.datasetId,
      group: singleGroupPlan.group.name,
      group_id: '495676670504992',
      group_url: SHADOW_SINGLE_GROUP_URL,
      start_date: singleGroupPlan.startDate,
      end_date: singleGroupPlan.endDate,
      request_count: 1,
      provider_record_cap: null,
      shadow_ingestion: singleGroupPlan.shadowIngestion,
      legacy_write_guard: singleGroupPlan.legacyWriteGuard,
      paid_freshness: singleGroupPlan.paidFreshness,
      submit_required: true,
      generated_payload: payload,
    }, null, 2));
    if (!process.argv.includes('--submit')) return;
  }
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) {
    console.error('❌ BRIGHTDATA_API_KEY is not set in .env');
    process.exit(1);
  }

  const groups = singleGroupPlan ? [singleGroupPlan.group] : getGroupsToTest();
  const pilot = process.env.BRIGHTDATA_PILOT === 'true';
  const { startDate, endDate } = singleGroupPlan ?? getDateWindow();

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`📁 Raw responses will be saved to ${OUTPUT_DIR}`);
  console.log(`📅 Date window: ${startDate} → ${endDate}`);
  console.log(`🧪 Mode: ${singleGroupPlan ? 'SHADOW SINGLE GROUP (one request)' : pilot ? 'PILOT (3 groups)' : 'FULL (' + groups.length + ' groups)'}`);
  console.log(`🔑 Bright Data API key: configured`);
  console.log(`🏷️  Run ID: ${RUN_ID}\n`);

  const allResults: GroupResult[] = [];
  let singleGroupRawRecords: unknown[] | undefined;

  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const batch = groups.slice(i, i + BATCH_SIZE);
    const group = batch[0];
    const progress = `[${i + 1}/${groups.length}]`;
    console.log(`${progress} ➡️  ${group.name}`);

    const result = await testGroup(group);
    allResults.push(result);
    if (singleGroupPlan) {
      const rawPath = path.join(OUTPUT_DIR, `${RUN_ID}_Real_Estate_in_Siem_Reap_raw.json`);
      try {
        const rawSaved = JSON.parse(await fs.readFile(rawPath, 'utf8')) as { records?: unknown[]; response?: unknown };
        singleGroupRawRecords = rawSaved.records ?? (Array.isArray(rawSaved.response) ? rawSaved.response : []);
      } catch { singleGroupRawRecords = []; }
    }

    const icon = statusIcon(result.status);
    console.log(`   ${icon} ${result.status} — ${result.recordsReturned} records (HTTP ${result.httpStatus})`);
    if (result.error) console.log(`      ⚠️  ${result.error}`);

    if (i + BATCH_SIZE < groups.length) {
      console.log(`   Sleeping ${DELAY_MS}ms...\n`);
      await sleep(DELAY_MS);
    }
  }

  const summary = {
    testedAt: new Date().toISOString(),
    datasetId: DATASET_ID,
    dateWindow: { startDate, endDate },
    mode: singleGroupPlan ? 'shadow-single-group' : pilot ? 'pilot' : 'full',
    totalGroups: groups.length,
    success: allResults.filter((r) => r.status === 'success').length,
    noRecords: allResults.filter((r) => r.status === 'no_records').length,
    unsupportedOrPrivate: allResults.filter((r) => r.status === 'unsupported_or_private').length,
    apiError: allResults.filter((r) => r.status === 'api_error').length,
    accountInactive: allResults.filter((r) => r.status === 'account_inactive').length,
    snapshotTimeout: allResults.filter((r) => r.status === 'snapshot_timeout').length,
    unknown: allResults.filter((r) => r.status === 'unknown').length,
    results: allResults,
  };

  const summaryFile = path.join(OUTPUT_DIR, `${RUN_ID}_summary.json`);
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));

  if (singleGroupPlan) {
    if (!singleGroupRawRecords) throw new Error('Raw snapshot was not persisted; refusing shadow classification');
    const replayFile = path.join(OUTPUT_DIR, `${RUN_ID}_shadow_replay.json`);
    const posts = singleGroupRawRecords.map((record) => makeReplayPost(record, singleGroupPlan!.group)).filter(Boolean);
    await fs.writeFile(replayFile, JSON.stringify({ posts }, null, 2));
    if (process.argv.includes('--submit') && posts.length > 0) {
      const classify = spawnSync(process.execPath, [path.resolve('node_modules/ts-node/dist/bin.js'), path.resolve('scripts/brightdata-classify.ts'), '--shadow-ingestion'], {
        cwd: process.cwd(),
        env: { ...process.env, BRIGHTDATA_REPLAY_FILE: replayFile, SHADOW_INGESTION: 'true', PAID_FRESHNESS_EXECUTION: 'false' },
        stdio: 'inherit',
      });
      if (classify.error) throw classify.error;
      if (classify.status !== 0) throw new Error(`Shadow classification/ingestion exited with status ${classify.status}`);
    }
    if (process.argv.includes('--submit') && posts.length === 0) {
      console.log('ℹ️  No usable records in the snapshot; shadow classification/ingestion skipped.');
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total groups: ${summary.totalGroups}`);
  console.log(`  ✅ Success (records returned):    ${summary.success}`);
  console.log(`  🟡 No records / unresolved:       ${summary.noRecords}`);
  console.log(`  🔒 Unsupported or private:          ${summary.unsupportedOrPrivate}`);
  console.log(`  ❌ API error:                     ${summary.apiError}`);
  console.log(`  💤 Account inactive:               ${summary.accountInactive}`);
  console.log(`  ⏳ Snapshot timeout:               ${summary.snapshotTimeout}`);
  console.log(`  ❓ Unknown:                        ${summary.unknown}`);
  console.log(`\nSummary written to: ${summaryFile}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('💥 Unexpected error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
