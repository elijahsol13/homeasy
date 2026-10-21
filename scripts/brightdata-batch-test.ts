/**
 * HomEasy — Bright Data Facebook Groups eligibility test
 *
 * Tests which public Facebook groups are scrapable via Bright Data's
 * "Facebook - Posts by group URL" dataset (dataset_id gd_lz11l67o2cb3r0lkj3).
 *
 * Design choices based on pre-flight review:
 *   - BATCH_SIZE = 1: each request maps to exactly one group, so we do not need
 *     to guess how Bright Data links records back to input URLs.
 *   - 23 groups retained: 16 with verified public posts, 6 with explicit private
 *     errors (reserved for Camoufox), 1 with unresolved access.
 *   - Provider record caps and a <=1000 total budget; paid runs are opt-in.
 *   - --shadow-single-group is fail-closed and prints a one-day, one-group
 *     payload without sending it; add --submit only after the separate go-ahead.
 *   - Handles HTTP 202 + snapshot_id: sync /scrape can switch to async if it
 *     takes longer than 1 minute. We poll progress and download the snapshot.
 *   - Raw responses and summary JSON are saved to tmp/brightdata-test/.
 *
 * Requires BRIGHTDATA_API_KEY in .env.
 *
 * Usage:
 *   npm run brightdata:test:groups             # dry-run with group routing
 *   npm run brightdata:test:groups -- --pilot  # dry-run for two public groups
 *   npm run brightdata:test:groups -- --pilot --submit # explicitly paid probe
 *   BRIGHTDATA_START_DATE=YYYY-MM-DD BRIGHTDATA_END_DATE=YYYY-MM-DD \
 *     npm run brightdata:test:groups -- --shadow-single-group
 *   # Full run also requires --full --submit. No AI or DB ingestion is automatic.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { observeGroup, planGroups } from '../src/modules/parser/facebook-group-monitor';
import { loadMonitorState, saveMonitorState, importSavedObservations, monitorRegistry, MONITOR_DIR } from './brightdata-group-monitor';

const DATASET_ID = 'gd_lz11l67o2cb3r0lkj3';
const API_BASE = 'https://api.brightdata.com/datasets/v3';
const OUTPUT_DIR = path.resolve(process.cwd(), 'tmp', 'brightdata-test');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BATCH_SIZE = 1;
const DELAY_MS = 1000;
const SNAPSHOT_POLL_INTERVAL_MS = 3000;
const SNAPSHOT_MAX_POLL_MS = 12 * 60 * 1000; // observed Facebook dataset snapshots can take >6 minutes
const SHADOW_SINGLE_GROUP_URL = 'https://www.facebook.com/groups/495676670504992';
const SHADOW_GROUP_NAME = 'Real Estate in Siem Reap';
const MAX_RUN_RECORDS = 1000;
const DEFAULT_PER_GROUP_LIMIT = 50;
const BOUNDED_PUBLIC_CAP = 20;
const BOUNDED_UNKNOWN_CAP = 5;
const BOUNDED_TOTAL_CAP = 255; // Preserve the previously authorized overall ceiling.
const PENDING_SNAPSHOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface SavedSnapshot {
  request?: GroupRequestBody;
  status?: number | null;
  response?: unknown;
  snapshotId?: string;
  records?: unknown[];
  state?: string;
  error?: string;
}

export interface PendingSnapshot {
  file: string;
  snapshotId: string;
  groupUrl: string;
  requestedLimit: number;
}

/** Find accepted but undownloaded jobs. Old historical runs are preserved. */
export async function findPendingSnapshots(dir = OUTPUT_DIR, nowMs = Date.now()): Promise<PendingSnapshot[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(dir);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
  const pending: PendingSnapshot[] = [];
  for (const name of filenames.filter((item) => item.endsWith('_raw.json')).sort()) {
    const stamp = name.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3Z');
    const submittedAt = Date.parse(stamp);
    if (!Number.isFinite(submittedAt) || submittedAt > nowMs || nowMs - submittedAt > PENDING_SNAPSHOT_WINDOW_MS) continue;
    const file = path.join(dir, name);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as SavedSnapshot;
    if (saved.status !== 202 || Array.isArray(saved.records) || saved.state === 'snapshot_failed') continue;
    const providerResponse = saved.response as { snapshot_id?: string } | null;
    const snapshotId = saved.snapshotId ?? providerResponse?.snapshot_id;
    const groupUrl = saved.request?.input?.[0]?.url;
    const requestedLimit = saved.request?.limit_per_input;
    if (!snapshotId || !groupUrl || !requestedLimit) {
      throw new Error(`Unrecoverable accepted Bright Data request in ${file}; manual inspection needed`);
    }
    pending.push({ file, snapshotId, groupUrl, requestedLimit });
  }
  return pending;
}

function groupFileKey(group: GroupConfig): string {
  // Keep the legacy shadow path stable, but prevent similarly named groups
  // from overwriting each other's raw snapshots on case-insensitive volumes.
  if (group.url === SHADOW_SINGLE_GROUP_URL) return 'Real_Estate_in_Siem_Reap';
  return `${group.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50)}_${crypto.createHash('sha256').update(group.url).digest('hex').slice(0, 10)}`;
}

/** A high-recall review shortlist, not an authoritative housing classification. */
export function isPotentialHousingDemand(content: string): boolean {
  const text = content.toLowerCase().replace(/\s+/g, ' ');
  const intent = /\b(looking for|looking to (?:rent|buy)|searching for|in search of|seeking|need(?:ing)? (?:a|an|some)?|wanted|does anyone (?:have|know)|anyone (?:have|know)|recommend (?:a|an)?|want to (?:rent|buy)|iso)\b|(?:កំពុង)?ស្វែងរក|ត្រូវការ|រកជួល/i;
  const housing = /\b(room|rental|rent|apartment|house|villa|condo|flat|studio|housing|accommodation|place to (?:stay|live)|property|home|bedroom|long.term)\b|ផ្ទះ|បន្ទប់|អាផាតមិន|ជួល/i;
  return intent.test(text) && housing.test(text);
}

interface ShadowSingleGroupPlan {
  datasetId: string;
  group: GroupConfig;
  startDate: string;
  endDate: string;
  requestBody: GroupRequestBody;
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
  if (groupRoute(group) !== 'BRIGHTDATA') throw new Error('Pinned group is not publicly accessible');
  const { perGroupLimit } = getBudgetConfig(args.env);
  return {
    datasetId: DATASET_ID,
    group: { ...group, name: SHADOW_GROUP_NAME },
    startDate,
    endDate,
    requestBody: buildGroupRequest(group, startDate, endDate, perGroupLimit),
    shadowIngestion: true,
    legacyWriteGuard: true,
    paidFreshness: false,
    requestCount: 1,
  };
}

export interface GroupConfig {
  name: string;
  url: string;
  role: 'demand' | 'supply' | 'mixed' | 'community';
  priority: 'A' | 'B' | 'C';
  notes?: string;
}

export type GroupAccess = 'public' | 'private' | 'unknown';
export type GroupRoute = 'BRIGHTDATA' | 'CAMOUFOX_DEFERRED' | 'REVIEW';

// Evidence: tmp/brightdata-test/2026-10-06T03-29-44_summary.json,
// supplemented by the 03-21-55 pilot. A returned record proves public access
// at the time of the run; explicit "Private group" errors prove private access.
// Empty results, timeouts, network failures and unavailable pages remain unknown.
const PRE_DISCOVERY_PUBLIC_GROUP_URLS = new Set([
  'https://www.facebook.com/groups/SiemReapExpatsLocals',
  'https://www.facebook.com/groups/495676670504992',
  'https://www.facebook.com/groups/385053483002145',
  'https://www.facebook.com/groups/siemreaprealestate',
  'https://www.facebook.com/groups/201561753758474',
  'https://www.facebook.com/groups/392548891350210',
  'https://www.facebook.com/groups/youthfitness2014',
  'https://www.facebook.com/groups/598569030200616',
  'https://www.facebook.com/groups/SiemReapExpatConnection',
  'https://www.facebook.com/groups/cheaprentsiemreap',
  'https://www.facebook.com/groups/cambodiana',
]);
// Verified by real post payloads and group_category=Public group, 2026-10-18.
const PUBLIC_GROUP_URLS = new Set([
  ...PRE_DISCOVERY_PUBLIC_GROUP_URLS,
  'https://www.facebook.com/groups/900185676717876',
  'https://www.facebook.com/groups/366920920387861',
  'https://www.facebook.com/groups/binleangheng',
  'https://www.facebook.com/groups/1979336498978784',
  'https://www.facebook.com/groups/493840595946947',
]);
const PRIVATE_GROUP_URLS = new Set([
  'https://www.facebook.com/groups/siemreapcommunity',
  'https://www.facebook.com/groups/408946849297703',
  'https://www.facebook.com/groups/handstandcalisthenics',
  'https://www.facebook.com/groups/siemreap',
  'https://www.facebook.com/groups/233923189986441',
  'https://www.facebook.com/groups/270186473437566', // Explicit private error 2026-10-18
]);

export function groupAccess(group: GroupConfig): GroupAccess {
  if (PRIVATE_GROUP_URLS.has(group.url)) return 'private';
  if (PUBLIC_GROUP_URLS.has(group.url)) return 'public';
  return 'unknown';
}

export function groupRoute(group: GroupConfig): GroupRoute {
  const access = groupAccess(group);
  if (access === 'private') return 'CAMOUFOX_DEFERRED';
  return access === 'public' ? 'BRIGHTDATA' : 'REVIEW';
}

interface GroupResult {
  name: string;
  url: string;
  role: string;
  priority: string;
  status: 'success' | 'no_records' | 'api_error' | 'account_inactive' | 'unsupported_or_private' | 'snapshot_timeout' | 'unknown';
  recordsReturned: number;
  recordsReceived: number;
  httpStatus: number;
  error?: string;
  sample?: unknown;
}

// Demand-first order, based on SIEM_REAP_SOURCES.md.
// Keep all 23 sources in the registry even when Bright Data cannot read them.
export const GROUPS: GroupConfig[] = [
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
  // Provider-confirmed private on 2026-10-06; reserved for later Camoufox.
  {
    name: 'Expats and locals living in Siem Reap',
    url: 'https://www.facebook.com/groups/siemreap',
    role: 'mixed',
    priority: 'C',
    notes: 'Bright Data confirmed private 2026-10-06; Camoufox deferred',
  },
  {
    name: 'Siem Reap Residents',
    url: 'https://www.facebook.com/groups/233923189986441',
    role: 'community',
    priority: 'C',
    notes: 'Bright Data confirmed private 2026-10-06; Camoufox deferred',
  },
];

export function selectBoundedUnknownGroups(startIndex: number): GroupConfig[] {
  const unknownGroups = GROUPS.filter((group) => groupAccess(group) === 'unknown');
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= unknownGroups.length) {
    throw new Error(`--unknown-start-index must be an integer from 0 to ${unknownGroups.length - 1}`);
  }
  return unknownGroups.slice(startIndex);
}

/** Resume a bounded public run without resubmitting groups attempted earlier. */
export function selectBoundedPublicGroups(startIndex: number): GroupConfig[] {
  // Freeze the 11-group historical cohort; newly confirmed groups must not
  // change the indexes of an existing bounded resume.
  const publicGroups = GROUPS.filter((group) => PRE_DISCOVERY_PUBLIC_GROUP_URLS.has(group.url));
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= publicGroups.length) {
    throw new Error(`--public-start-index must be an integer from 0 to ${publicGroups.length - 1}`);
  }
  return publicGroups.slice(startIndex);
}

/** Require an explicit cohort for the historical bounded run, especially before paid replays. */
export function validateBoundedDiscoveryInvocation(argv: string[]): void {
  if (!argv.includes('--bounded-discovery')) return;
  const unknownOnly = argv.includes('--unknown-only');
  const publicOnly = argv.includes('--public-only');
  if (unknownOnly === publicOnly) {
    throw new Error('Bounded discovery requires exactly one of --unknown-only or --public-only; the original mixed cohort has already been sampled');
  }
  if (!argv.includes('--submit')) return;
  const indexPrefix = unknownOnly ? '--unknown-start-index=' : '--public-start-index=';
  if (!argv.some((arg) => arg.startsWith(indexPrefix))) {
    throw new Error(`Paid bounded discovery requires explicit ${indexPrefix}<index> to avoid replaying previously sampled groups`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDateWindow(): { startDate: string; endDate: string } {
  const envStart = process.env.BRIGHTDATA_START_DATE;
  const envEnd = process.env.BRIGHTDATA_END_DATE;

  if (envStart || envEnd) {
    if (!envStart || !envEnd || !isIsoCalendarDate(envStart) || !isIsoCalendarDate(envEnd) || envStart > envEnd) {
      throw new Error('Both Bright Data dates must be valid YYYY-MM-DD, start <= end');
    }
    return { startDate: envStart, endDate: envEnd };
  }

  // Facebook groups are Siem Reap sources. UTC dates around local midnight
  // can be a day behind; use the actual Cambodian calendar day.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { startDate: yesterday.toISOString().slice(0, 10), endDate: today };
}

export function getGroupsToTest(pilot = false): GroupConfig[] {
  const eligible = GROUPS.filter((group) => groupRoute(group) === 'BRIGHTDATA');
  return pilot ? eligible.slice(0, 2) : eligible;
}

export function getBudgetConfig(env: NodeJS.ProcessEnv): { maxRecords: number; perGroupLimit: number } {
  const maxRecords = Number(env.BRIGHTDATA_RECORD_BUDGET ?? MAX_RUN_RECORDS);
  const perGroupLimit = Number(env.BRIGHTDATA_PER_GROUP_LIMIT ?? DEFAULT_PER_GROUP_LIMIT);
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RUN_RECORDS) {
    throw new Error(`BRIGHTDATA_RECORD_BUDGET must be a positive integer <= ${MAX_RUN_RECORDS}`);
  }
  if (!Number.isSafeInteger(perGroupLimit) || perGroupLimit < 1 || perGroupLimit > maxRecords) {
    throw new Error('BRIGHTDATA_PER_GROUP_LIMIT must be a positive integer <= BRIGHTDATA_RECORD_BUDGET');
  }
  return { maxRecords, perGroupLimit };
}

interface GroupRequestBody {
  input: Array<{ url: string; start_date: string; end_date: string; user_to_not_include: string }>;
  limit_per_input: number;
}

export function buildGroupRequest(group: GroupConfig, startDate: string, endDate: string, recordLimit: number, allowUnknownProbe = false): GroupRequestBody {
  if (groupRoute(group) !== 'BRIGHTDATA' && !(allowUnknownProbe && groupAccess(group) === 'unknown')) {
    throw new Error(`Bright Data route forbidden for ${group.url}`);
  }
  if (!isIsoCalendarDate(startDate) || !isIsoCalendarDate(endDate) || startDate > endDate) {
    throw new Error('Invalid Bright Data calendar window');
  }
  if (!Number.isSafeInteger(recordLimit) || recordLimit < 1 || recordLimit > MAX_RUN_RECORDS) {
    throw new Error('Invalid Bright Data provider record limit');
  }
  return {
    input: [{ url: group.url, start_date: startDate, end_date: endDate, user_to_not_include: '' }],
    limit_per_input: recordLimit,
  };
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
  for (const key of ['error', 'error_message']) {
    if (typeof r[key] === 'string' && r[key]) {
      return String(r[key]);
    }
  }
  if (!r.post_id && !r.content && typeof r.message === 'string' && r.message) return r.message;
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

/** Read-only recovery of an already accepted, potentially billable request. */
export async function recoverAcceptedSnapshot(pending: PendingSnapshot, monitorState?: import('../src/modules/parser/facebook-group-monitor').GroupMonitorState): Promise<{
  state: 'waiting' | 'failed' | 'recovered'; records: number; message?: string;
}> {
  const saved = JSON.parse(await fs.readFile(pending.file, 'utf8')) as SavedSnapshot;
  const providerResponse = saved.response as { snapshot_id?: string } | null;
  if (saved.status !== 202 || (saved.snapshotId ?? providerResponse?.snapshot_id) !== pending.snapshotId || Array.isArray(saved.records)) {
    throw new Error(`Snapshot record changed since discovery: ${path.basename(pending.file)}`);
  }
  let progress: Response;
  try {
    progress = await fetch(`${API_BASE}/progress/${pending.snapshotId}`, {
      headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` },
    });
  } catch (err) {
    return { state: 'waiting', records: 0, message: `Progress unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!progress.ok) {
    return { state: 'waiting', records: 0, message: `Progress HTTP ${progress.status}; accepted job kept pending` };
  }
  const body = (await progress.json()) as { status?: string; error_message?: string };
  if (body.status === 'failed') {
    saved.state = 'snapshot_failed';
    saved.error = body.error_message ?? 'Bright Data reported failed';
    await fs.writeFile(pending.file, JSON.stringify(saved, null, 2));
    return { state: 'failed', records: 0, message: saved.error };
  }
  if (body.status !== 'ready') {
    return { state: 'waiting', records: 0, message: `Provider status: ${body.status ?? 'unknown'}` };
  }

  let downloaded: unknown;
  try {
    downloaded = await downloadSnapshot(pending.snapshotId);
  } catch (err) {
    return { state: 'waiting', records: 0, message: `Download unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(downloaded)) {
    return { state: 'waiting', records: 0, message: 'Download returned unexpected shape; keeping pending' };
  }
  saved.snapshotId = pending.snapshotId;
  saved.records = downloaded;
  saved.state = 'snapshot_recovered';
  await fs.writeFile(pending.file, JSON.stringify(saved, null, 2));
  const { actualRecords, errorRecords } = partitionRecords(downloaded);
  if (downloaded.length > pending.requestedLimit) {
    throw new Error(`Provider exceeded ${pending.requestedLimit}-record cap with ${downloaded.length} records; raw data preserved, monitor unchanged`);
  }
  if (errorRecords.length && actualRecords.length === 0) {
    return { state: 'recovered', records: 0, message: `Provider errors only: ${errorRecords.join('; ').slice(0, 200)}` };
  }
  if (monitorState) {
    const group = monitorRegistry().find((item) => item.url === pending.groupUrl && item.route === 'BRIGHTDATA');
    if (group) {
      const key = `${path.basename(pending.file)}:${pending.groupUrl}`;
      // Recovered observations are timestamped on reconciliation. Re-importing
      // historical files remains idempotent by key and cannot roll back state.
      observeGroup(monitorState, {
        key, groupUrl: pending.groupUrl, observedAt: new Date().toISOString(),
        requestedLimit: pending.requestedLimit, records: downloaded,
      });
    }
  }
  return { state: 'recovered', records: downloaded.length };
}

async function resumePending(): Promise<void> {
  const pending = await findPendingSnapshots();
  if (!pending.length) {
    console.log('No recent accepted Bright Data snapshots awaiting recovery.');
    return;
  }
  if (!process.env.BRIGHTDATA_API_KEY) throw new Error('BRIGHTDATA_API_KEY is required to resume accepted snapshots');
  const state = await loadMonitorState();
  for (const job of pending) {
    const result = await recoverAcceptedSnapshot(job, state);
    if (result.state === 'recovered') await saveMonitorState(state);
    console.log(JSON.stringify({ snapshotId: job.snapshotId, group: job.groupUrl, ...result }));
  }
}

async function callBrightData(group: GroupConfig, startDate: string, endDate: string, recordLimit: number, allowUnknownProbe = false): Promise<{ records: unknown[]; httpStatus: number; snapshotId?: string; error?: string }> {
  const body = buildGroupRequest(group, startDate, endDate, recordLimit, allowUnknownProbe);
  // The documented query cap supplements the recommended body cap. Whether
  // this specific Facebook dataset honours it still needs a small live pilot.
  const url = `${API_BASE}/scrape?dataset_id=${DATASET_ID}&include_errors=true&format=json&limit_per_input=${recordLimit}`;

  const rawFile = path.join(OUTPUT_DIR, `${RUN_ID}_${groupFileKey(group)}_raw.json`);
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
    groupId: String(row.group_id ?? new URL(group.url).pathname.match(/\/groups\/([^/?#]+)/)?.[1] ?? ''),
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
  if (httpStatus >= 400 || (error && records.length === 0)) return 'api_error';
  if (!Array.isArray(records)) return 'unknown';
  if (records.length === 0) return 'no_records';
  return 'success';
}

async function testGroup(group: GroupConfig, startDate: string, endDate: string, recordLimit: number, allowUnknownProbe = false): Promise<GroupResult> {
  try {
    const { records, httpStatus, error } = await callBrightData(group, startDate, endDate, recordLimit, allowUnknownProbe);
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
      recordsReceived: records.length,
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
      recordsReceived: 0,
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  if (process.argv.includes('--resume-pending')) {
    if (process.argv.includes('--submit')) throw new Error('--resume-pending is read-only and cannot be combined with --submit');
    await resumePending();
    return;
  }
  const adaptive = process.argv.includes('--adaptive');
  const singleGroupMode = process.argv.includes('--shadow-single-group');
  const bounded = process.argv.includes('--bounded-discovery');
  validateBoundedDiscoveryInvocation(process.argv);
  const unknownOnly = process.argv.includes('--unknown-only');
  const publicOnly = process.argv.includes('--public-only');
  if (unknownOnly && publicOnly) throw new Error('Choose --unknown-only or --public-only');
  const unknownStartArg = process.argv.find((argument) => argument.startsWith('--unknown-start-index='));
  if (unknownStartArg && !unknownOnly) throw new Error('--unknown-start-index requires --bounded-discovery --unknown-only');
  const publicStartArg = process.argv.find((argument) => argument.startsWith('--public-start-index='));
  if (publicStartArg && !publicOnly) throw new Error('--public-start-index requires --bounded-discovery --public-only');
  const unknownStartIndex = unknownStartArg ? Number(unknownStartArg.slice('--unknown-start-index='.length)) : 0;
  const publicStartIndex = publicStartArg ? Number(publicStartArg.slice('--public-start-index='.length)) : 0;
  const remainingUnknownGroups = unknownOnly ? selectBoundedUnknownGroups(unknownStartIndex) : [];
  const remainingPublicGroups = publicOnly ? selectBoundedPublicGroups(publicStartIndex) : [];
  const pilot = process.argv.includes('--pilot') || process.env.BRIGHTDATA_PILOT === 'true';
  const full = process.argv.includes('--full');
  const submit = process.argv.includes('--submit');
  if (adaptive && (singleGroupMode || bounded || pilot || full || unknownOnly || publicOnly)) {
    throw new Error('--adaptive is standalone; use --adaptive [--submit]');
  }
  if (pilot && full) throw new Error('Choose --pilot or --full, not both');
  if (singleGroupMode && full) throw new Error('--shadow-single-group cannot use --full');
  if (bounded && (singleGroupMode || pilot || full)) throw new Error('--bounded-discovery is a standalone mode');
  if ((unknownOnly || publicOnly) && !bounded) throw new Error('--unknown-only/--public-only requires --bounded-discovery');
  const budget = bounded
    ? { maxRecords: unknownOnly ? remainingUnknownGroups.length * BOUNDED_UNKNOWN_CAP : remainingPublicGroups.length * BOUNDED_PUBLIC_CAP,
        perGroupLimit: unknownOnly ? BOUNDED_UNKNOWN_CAP : BOUNDED_PUBLIC_CAP }
    : getBudgetConfig(process.env);
  // The legacy 50-record cap remains the default for manual pilots. Adaptive
  // rescue samples may require 80 to recover a gap or non-chronological feed.
  const adaptivePerGroupMax = Number(process.env.BRIGHTDATA_ADAPTIVE_PER_GROUP_LIMIT ?? Math.min(80, budget.maxRecords));
  if (adaptive && (!Number.isSafeInteger(adaptivePerGroupMax) || adaptivePerGroupMax < 1 || adaptivePerGroupMax > budget.maxRecords)) {
    throw new Error('BRIGHTDATA_ADAPTIVE_PER_GROUP_LIMIT must be a positive integer <= the total record budget');
  }
  if (bounded && budget.maxRecords > BOUNDED_TOTAL_CAP) {
    throw new Error(`Bounded discovery exceeds the original ${BOUNDED_TOTAL_CAP}-record cap`);
  }
  if (bounded && (process.env.BRIGHTDATA_RECORD_BUDGET || process.env.BRIGHTDATA_PER_GROUP_LIMIT)) {
    throw new Error('Bounded mode uses fixed per-group caps and total cap; remove budget environment overrides');
  }
  let singleGroupPlan: ShadowSingleGroupPlan | undefined;
  if (singleGroupMode) {
    // This gate runs before reading credentials and, critically, before fetch.
    singleGroupPlan = buildShadowSingleGroupPlan({ argv: process.argv, env: process.env });
    const payload = {
      dataset_id: singleGroupPlan.datasetId,
      endpoint: `${API_BASE}/scrape?dataset_id=${singleGroupPlan.datasetId}&include_errors=true&format=json&limit_per_input=${budget.perGroupLimit}`,
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
      provider_record_cap: budget.perGroupLimit,
      shadow_ingestion: singleGroupPlan.shadowIngestion,
      legacy_write_guard: singleGroupPlan.legacyWriteGuard,
      paid_freshness: singleGroupPlan.paidFreshness,
      submit_required: true,
      generated_payload: payload,
    }, null, 2));
    if (!submit) return;
  }
  // Adaptive mode reads independent observations and orders only due public groups.
  // Invoking --adaptive alone is a free dry run; it does not activate any cron.
  const monitorState = adaptive ? await loadMonitorState() : undefined;
  if (adaptive && submit && monitorState) {
    // Crash recovery: a downloaded raw file may predate its monitor-state save.
    const imported = await importSavedObservations(monitorState);
    if (imported.imported || imported.classified) await saveMonitorState(monitorState);
  }
  const adaptiveSchedule = adaptive && monitorState
    ? planGroups(monitorState, monitorRegistry(), new Date().toISOString(), adaptivePerGroupMax) : [];
  const adaptiveByUrl = new Map(adaptiveSchedule.map((item) => [item.url, item]));
  const groups = adaptive ? adaptiveSchedule.filter((item) => item.due).map((item) => GROUPS.find((group) => group.url === item.url)!)
    : singleGroupPlan ? [singleGroupPlan.group] : bounded
    ? (unknownOnly ? remainingUnknownGroups : publicOnly ? remainingPublicGroups : GROUPS.filter((g) => groupAccess(g) !== 'private'))
    : getGroupsToTest(pilot);
  const { startDate, endDate } = singleGroupPlan ?? getDateWindow();
  // Unknown groups get a longer lookback to distinguish quiet public groups
  // from groups that Bright Data explicitly reports as private.
  const unknownStartDate = bounded
    ? new Date(new Date(`${endDate}T00:00:00Z`).getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
    : startDate;
  const excludedPrivate = GROUPS.filter((group) => groupRoute(group) === 'CAMOUFOX_DEFERRED');
  const accessUnknown = GROUPS.filter((group) => groupRoute(group) === 'REVIEW');
  const plan = {
    datasetId: DATASET_ID,
    mode: adaptive ? 'adaptive' : singleGroupPlan ? 'shadow-single-group' : unknownOnly ? 'bounded-unknown-probes' : publicOnly ? 'bounded-public-resume' : bounded ? 'bounded-discovery' : pilot ? 'pilot' : 'full',
    submitted: submit,
    dateWindow: { startDate, endDate },
    budget: { ...budget, ...(adaptive ? { adaptivePerGroupMax } : {}) },
    groups: groups.map((group) => ({ name: group.name, url: group.url, access: groupAccess(group), route: groupRoute(group), priority: group.priority,
      startDate: groupAccess(group) === 'unknown' ? unknownStartDate : startDate,
      endDate, cap: adaptive ? adaptiveByUrl.get(group.url)!.limit : bounded ? (groupAccess(group) === 'unknown' ? BOUNDED_UNKNOWN_CAP : BOUNDED_PUBLIC_CAP) : budget.perGroupLimit,
      ...(adaptive ? { monitor: adaptiveByUrl.get(group.url) } : {}) })),
    ...(adaptive ? { adaptiveAllGroups: adaptiveSchedule, uncoveredOrNonChronological: adaptiveSchedule.filter((item) => item.coverage === 'possible_gap' || item.ordering === 'non_chronological').length } : {}),
    excludedPrivate: excludedPrivate.map((group) => ({ name: group.name, url: group.url, route: groupRoute(group) })),
    accessUnknown: accessUnknown.map((group) => ({ name: group.name, url: group.url, route: groupRoute(group) })),
    maxProviderRequests: groups.length,
    // If the dataset honours limit_per_input as the API docs describe:
    maxExpectedRecords: bounded ? budget.maxRecords : Math.min(budget.maxRecords, groups.reduce((sum, group) => sum + (adaptive ? adaptiveByUrl.get(group.url)!.limit : budget.perGroupLimit), 0)),
  };
  if (!submit) {
    console.log('🔒 Bright Data dry run (no requests / no AI / no database writes).');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (!singleGroupMode && !pilot && !full && !bounded && !adaptive) {
    throw new Error('Paid multi-group run requires explicit --pilot --submit, --full --submit, --bounded-discovery --submit or --adaptive --submit');
  }

  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) {
    console.error('❌ BRIGHTDATA_API_KEY is not set in .env');
    process.exit(1);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, `${RUN_ID}_plan.json`), JSON.stringify(plan, null, 2));
  console.log(`📁 Raw responses will be saved to ${OUTPUT_DIR}`);
  console.log(`📅 Date window: ${startDate} → ${endDate}`);
  console.log(`🧪 Mode: ${adaptive ? `ADAPTIVE (${groups.length} due public groups)` : singleGroupPlan ? 'SHADOW SINGLE GROUP (one request)' : unknownOnly ? `BOUNDED UNKNOWN ACCESS PROBES (${groups.length} × 5, starting at index ${unknownStartIndex})` : publicOnly ? `BOUNDED PUBLIC RESUME (${groups.length} × 20, starting at index ${publicStartIndex})` : bounded ? 'BOUNDED DISCOVERY (eligible public and unresolved groups)' : pilot ? 'PILOT (2 groups)' : 'FULL (' + groups.length + ' public groups)'}`);
  console.log(`🔒 Excluded: ${excludedPrivate.length} confirmed private (Camoufox deferred); ${accessUnknown.length} unresolved (${bounded ? 'up to 5 probe posts in full/unknown mode' : 'manual review'})`);
  console.log(`💳 Record budget: ${budget.maxRecords} total, <= ${adaptive ? adaptivePerGroupMax : budget.perGroupLimit} per group (provider cap pending dataset-specific verification)`);
  console.log(`🔑 Bright Data API key: configured`);
  console.log(`🏷️  Run ID: ${RUN_ID}\n`);

  const allResults: GroupResult[] = [];
  let singleGroupRawRecords: unknown[] | undefined;
  const boundedReplay: Record<string, unknown>[] = [];
  const boundedDemandCandidates: Record<string, unknown>[] = [];
  let recordsReceived = 0;
  let stopReason: string | undefined;

  // Only one paid adaptive writer may run at a time. Fail closed on contention.
  await fs.mkdir(MONITOR_DIR, { recursive: true });
  const adaptiveLockFile = path.join(MONITOR_DIR, 'adaptive.lock');
  const adaptiveLock = adaptive ? await fs.open(adaptiveLockFile, 'wx') : undefined;
  try {

  if (adaptive) {
    // Accepted snapshots can be billable even when progress/download fails.
    // Never issue another POST while one is unresolved; --resume-pending uses GET only.
    const pending = await findPendingSnapshots();
    if (pending.length) {
      throw new Error(`${pending.length} recent accepted Bright Data snapshot(s) unresolved (${pending.map((item) => item.snapshotId).join(', ')}). Run npm run brightdata:test:groups -- --resume-pending before any new --adaptive --submit`);
    }
  }

  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const remaining = budget.maxRecords - recordsReceived;
    if (remaining <= 0) { stopReason = 'Record budget exhausted'; break; }
    const batch = groups.slice(i, i + BATCH_SIZE);
    const group = batch[0];
    const progress = `[${i + 1}/${groups.length}]`;
    console.log(`${progress} ➡️  ${group.name}`);

    const isUnknown = groupAccess(group) === 'unknown';
    const requestLimit = Math.min(adaptive ? adaptiveByUrl.get(group.url)!.limit : bounded ? (isUnknown ? BOUNDED_UNKNOWN_CAP : BOUNDED_PUBLIC_CAP) : budget.perGroupLimit, remaining);
    const result = await testGroup(group, isUnknown && bounded ? unknownStartDate : startDate, endDate, requestLimit, bounded && isUnknown);
    allResults.push(result);
    recordsReceived += result.recordsReceived;
    if (adaptive) {
      // A 202 snapshot remains billable even if polling/download fails. A
      // follow-up POST would hide that failure and could spend credits twice.
      const unresolved = await findPendingSnapshots();
      if (unresolved.length) {
        stopReason = `Accepted Bright Data snapshot still pending: ${unresolved.map((job) => job.snapshotId).join(', ')}. Resume with --resume-pending before any new POST`;
        console.log(`⏸️  ${stopReason}`);
        break;
      }
    }
    if (result.recordsReceived > requestLimit) {
      stopReason = `Provider returned ${result.recordsReceived} records for a ${requestLimit}-record cap; stopping to avoid further costs`;
      break;
    }
    if (adaptive && monitorState && (result.status === 'success' || result.status === 'no_records')) {
      // Persist after EACH successful group: a failed subsequent request cannot
      // erase the already billed and observed frontier.
      const rawSaved = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, `${RUN_ID}_${groupFileKey(group)}_raw.json`), 'utf8')) as { records?: unknown[]; response?: unknown };
      const rawRows = rawSaved.records ?? rawSaved.response;
      if (!Array.isArray(rawRows)) throw new Error(`Missing raw data for ${group.url}; refusing monitor state update`);
      if (rawRows.length && !partitionRecords(rawRows).actualRecords.length) {
        throw new Error(`Provider returned only errors for ${group.url}; refusing to record a successful observation`);
      }
      const activity = observeGroup(monitorState, {
        key: `${RUN_ID}_${groupFileKey(group)}_raw.json:${group.url}`,
        groupUrl: group.url, observedAt: new Date().toISOString(), requestedLimit: requestLimit,
        records: rawRows,
      });
      await saveMonitorState(monitorState);
      console.log(`   📈 ${activity.estimatedPostsPerHour?.toFixed(1) ?? '?'} posts/h, ${activity.coverage}, order=${activity.ordering}; new=${activity.newInLastSample}`);
    }
    if (bounded) {
      try {
        const saved = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, `${RUN_ID}_${groupFileKey(group)}_raw.json`), 'utf8')) as { records?: unknown[]; response?: unknown };
        const raw = saved.records ?? (Array.isArray(saved.response) ? saved.response : []);
        for (const record of partitionRecords(raw).actualRecords) {
          const post = makeReplayPost(record, group);
          if (!post) continue;
          boundedReplay.push(post);
          if (isPotentialHousingDemand(String(post.content))) {
            boundedDemandCandidates.push({ postId: post.id, groupUrl: group.url, postUrl: post.postUrl,
              datePosted: post.datePosted, content: post.content, checkedAt: new Date().toISOString(),
              status: 'POTENTIAL_DEMAND_UNCONFIRMED' });
          }
        }
      } catch (err) {
        throw new Error(`Unable to preserve provider raw data for ${group.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (singleGroupPlan) {
      const rawPath = path.join(OUTPUT_DIR, `${RUN_ID}_${groupFileKey(group)}_raw.json`);
      try {
        const rawSaved = JSON.parse(await fs.readFile(rawPath, 'utf8')) as { records?: unknown[]; response?: unknown };
        singleGroupRawRecords = rawSaved.records ?? (Array.isArray(rawSaved.response) ? rawSaved.response : []);
      } catch { singleGroupRawRecords = []; }
    }

    const icon = statusIcon(result.status);
    console.log(`   ${icon} ${result.status} — ${result.recordsReturned} records (HTTP ${result.httpStatus})`);
    if (result.error) console.log(`      ⚠️  ${result.error}`);
    if (result.status !== 'success' && result.status !== 'no_records' &&
        (!bounded || result.status === 'snapshot_timeout' || result.status === 'account_inactive' || result.httpStatus === 401 || result.httpStatus === 403 || result.httpStatus === 0)) {
      stopReason = `Group ${group.url} ended with ${result.status}; stopping before submitting another paid request`;
      break;
    }

    if (i + BATCH_SIZE < groups.length) {
      console.log(`   Sleeping ${DELAY_MS}ms...\n`);
      await sleep(DELAY_MS);
    }
  }
  } finally {
    if (adaptiveLock) {
      await adaptiveLock.close();
      await fs.unlink(adaptiveLockFile);
    }
  }

  const summary = {
    testedAt: new Date().toISOString(),
    datasetId: DATASET_ID,
    dateWindow: { startDate, endDate },
    mode: adaptive ? 'adaptive' : singleGroupPlan ? 'shadow-single-group' : unknownOnly ? 'bounded-unknown-probes' : publicOnly ? 'bounded-public-resume' : bounded ? 'bounded-discovery' : pilot ? 'pilot' : 'full',
    totalGroups: groups.length,
    groupsAttempted: allResults.length,
    recordsReceived,
    recordBudget: budget.maxRecords,
    stopReason: stopReason ?? null,
    excludedPrivate: excludedPrivate.map((group) => group.url),
    unknownAccess: accessUnknown.map((group) => group.url),
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

  if (bounded) {
    const replayFile = path.join(OUTPUT_DIR, `${RUN_ID}_bounded_replay.json`);
    const demandFile = path.join(OUTPUT_DIR, `${RUN_ID}_demand_candidates.json`);
    await fs.writeFile(replayFile, JSON.stringify({ posts: boundedReplay }, null, 2));
    await fs.writeFile(demandFile, JSON.stringify({ runId: RUN_ID, checkedAt: new Date().toISOString(),
      note: 'Heuristic shortlist only; LLM classification and matching not run',
      candidates: boundedDemandCandidates }, null, 2));
    console.log(`🔎 Replay posts: ${boundedReplay.length}; potential housing demand: ${boundedDemandCandidates.length}`);
    console.log(`📁 ${replayFile}\n📁 ${demandFile}`);
  }

  if (singleGroupPlan) {
    if (!singleGroupRawRecords) throw new Error('Raw snapshot was not persisted; refusing shadow classification');
    const replayFile = path.join(OUTPUT_DIR, `${RUN_ID}_shadow_replay.json`);
    const posts = singleGroupRawRecords.map((record) => makeReplayPost(record, singleGroupPlan!.group)).filter(Boolean);
    await fs.writeFile(replayFile, JSON.stringify({ posts }, null, 2));
    console.log(`ℹ️  Exported ${posts.length} replay posts. Classification/AI/DB ingestion requires a separate explicit command.`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total groups: ${summary.totalGroups}`);
  console.log(`  📥 Groups attempted:               ${summary.groupsAttempted}; records received: ${summary.recordsReceived}`);
  if (summary.stopReason) console.log(`  ⏹️  Stopped: ${summary.stopReason}`);
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
