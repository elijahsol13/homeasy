/**
 * Independent Facebook group discovery monitor. No network, SQLite, or AI calls.
 * Post counts include irrelevant posts: traffic and housing yield are different signals.
 * A timestamp reach is never treated as proof of a complete chronological feed.
 */
import crypto from 'node:crypto';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_KNOWN_IDS = 3000;

export type HousingClass = 'HOUSING_SUPPLY' | 'HOUSING_DEMAND' | 'HOUSING_ADJACENT' | 'IRRELEVANT' | 'UNCLASSIFIED';
export type Coverage = 'initial' | 'overlap' | 'timestamp_reach_unverified' | 'possible_gap' | 'unknown';
export type Ordering = 'newest_first' | 'non_chronological' | 'unknown';

export interface GroupObservation {
  key: string; // one per provider snapshot + group, for replay idempotency
  groupUrl: string;
  observedAt: string;
  requestedLimit: number;
  records: unknown[];
  classes?: Record<string, HousingClass>;
}

export interface GroupActivity {
  groupUrl: string;
  observations: number;
  firstObservedAt: string;
  lastObservedAt: string;
  newestPostedAt: string | null;
  previousIds: string[];
  knownIds: string[];
  processedKeys: string[];
  classifiedIds: Record<string, HousingClass>;
  seenCount: number;
  totalReturned: number;
  newInLastSample: number;
  duplicatesInLastSample: number;
  estimatedPostsPerHour: number | null;
  measuredSpanHours: number | null;
  capReached: boolean;
  coverage: Coverage;
  ordering: Ordering;
  coverageGaps: number;
  nonChronologicalSamples: number;
  supply: number;
  demand: number;
  irrelevant: number;
  unclassified: number;
  sameAuthorReposts: number;
  recentSignatures: Record<string, string>;
}

export interface GroupMonitorState {
  version: 1;
  groups: Record<string, GroupActivity>;
}

export interface MonitorGroup {
  name: string;
  url: string;
  priority: 'A' | 'B' | 'C';
  role: string;
  route: 'BRIGHTDATA' | 'CAMOUFOX_DEFERRED' | 'REVIEW';
}

export interface GroupScrapePlan {
  name: string;
  url: string;
  route: MonitorGroup['route'];
  priority: MonitorGroup['priority'];
  due: boolean;
  nextDueAt: string;
  intervalHours: number;
  limit: number;
  estimatedPostsPerHour: number | null;
  coverage: Coverage | 'unobserved';
  ordering: Ordering;
  observations: number;
  newInLastSample: number;
  score: number;
}

export function newMonitorState(): GroupMonitorState {
  return { version: 1, groups: {} };
}

function time(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function rowData(record: unknown): { id: string; date: number | null; author: string; content: string } | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as Record<string, unknown>;
  if (row.error || row.error_message || (!row.post_id && !row.id && row.message)) return null;
  const id = String(row.post_id ?? row.id ?? '').trim();
  if (!id) return null;
  const original = row.original_post && typeof row.original_post === 'object' ? row.original_post as Record<string, unknown> : {};
  return {
    id,
    date: time(row.date_posted ?? row.datePosted),
    author: String(row.user_url ?? row.userUrl ?? '').trim(),
    content: String(row.content ?? original.content ?? '').trim(),
  };
}

export function observeGroup(state: GroupMonitorState, input: GroupObservation): GroupActivity {
  if (state.version !== 1) throw new Error('Unsupported group monitor state version');
  const observedAt = time(input.observedAt);
  if (observedAt === null || !Number.isSafeInteger(input.requestedLimit) || input.requestedLimit < 1) {
    throw new Error('Invalid group observation');
  }
  const existing = state.groups[input.groupUrl];
  if (existing?.processedKeys.includes(input.key)) return existing;
  if (existing && observedAt < Date.parse(existing.lastObservedAt)) {
    throw new Error('Observations must be replayed in timestamp order');
  }
  const rows = input.records.map(rowData).filter((r): r is NonNullable<typeof r> => r !== null);
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const ids = unique.map((row) => row.id);
  const known = new Set(existing?.knownIds ?? []);
  const prior = new Set(existing?.previousIds ?? []);
  const newRows = unique.filter((row) => !known.has(row.id));
  const dated = unique.filter((row) => row.date !== null);
  const times = dated.map((row) => row.date!);
  const newest = times.length ? Math.max(...times) : null;
  const oldest = times.length ? Math.min(...times) : null;
  let inversions = 0;
  for (let i = 1; i < dated.length; i++) if (dated[i].date! > dated[i - 1].date!) inversions++;
  const ordering: Ordering = dated.length < 2 ? 'unknown' : inversions ? 'non_chronological' : 'newest_first';
  const capReached = input.records.length >= input.requestedLimit;

  let coverage: Coverage = 'initial';
  if (existing) {
    if (!unique.length || !times.length || !existing.newestPostedAt || ordering === 'non_chronological') {
      coverage = 'unknown';
    } else if (ids.some((id) => prior.has(id))) {
      coverage = 'overlap';
    } else if (oldest! <= Date.parse(existing.newestPostedAt)) {
      coverage = 'timestamp_reach_unverified';
    } else {
      coverage = 'possible_gap';
    }
  }

  const spanHours = newest !== null && oldest !== null && newest > oldest ? (newest - oldest) / HOUR : null;
  // A capped recent slice is a local velocity estimate, NOT a complete volume census.
  // Hold the highest recent observed speed until more windows provide calibration.
  const measuredRate = spanHours !== null && dated.length >= 3 ? (dated.length - 1) / spanHours : null;
  const priorRate = existing?.estimatedPostsPerHour ?? null;
  const estimatedRate = measuredRate === null ? priorRate
    : priorRate === null ? measuredRate : Math.max(measuredRate, priorRate * 0.8);

  const signatures = { ...(existing?.recentSignatures ?? {}) };
  let sameAuthorReposts = existing?.sameAuthorReposts ?? 0;
  for (const row of newRows) {
    if (!row.author || row.content.length < 30) continue;
    const normalized = row.content.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 500);
    const signature = crypto.createHash('sha256').update(`${row.author}|${normalized}`).digest('hex');
    if (signatures[signature] && signatures[signature] !== row.id) sameAuthorReposts++;
    signatures[signature] = row.id;
  }
  const signatureEntries = Object.entries(signatures).slice(-500);
  const classes = { ...(existing?.classifiedIds ?? {}) };
  for (const [id, kind] of Object.entries(input.classes ?? {})) {
    // A missing/failed AI decision is not a classification and cannot replace
    // an earlier successful result from the same post.
    if (ids.includes(id) && ['HOUSING_SUPPLY', 'HOUSING_DEMAND', 'HOUSING_ADJACENT', 'IRRELEVANT'].includes(kind)) classes[id] = kind;
  }
  const classEntries = Object.entries(classes).slice(-MAX_KNOWN_IDS);
  const classValues = Object.values(Object.fromEntries(classEntries));
  const priorNewest = existing?.newestPostedAt ? Date.parse(existing.newestPostedAt) : null;
  const next: GroupActivity = {
    groupUrl: input.groupUrl,
    observations: (existing?.observations ?? 0) + 1,
    firstObservedAt: existing?.firstObservedAt ?? input.observedAt,
    lastObservedAt: input.observedAt,
    newestPostedAt: newest !== null && (priorNewest === null || newest > priorNewest)
      ? new Date(newest).toISOString() : existing?.newestPostedAt ?? null,
    previousIds: ids.slice(0, MAX_KNOWN_IDS),
    knownIds: [...new Set([...(existing?.knownIds ?? []), ...ids])].slice(-MAX_KNOWN_IDS),
    // Importing old snapshots out of order must not count twice after 200+ cycles.
    processedKeys: [...(existing?.processedKeys ?? []), input.key],
    classifiedIds: Object.fromEntries(classEntries),
    seenCount: (existing?.seenCount ?? 0) + newRows.length,
    totalReturned: (existing?.totalReturned ?? 0) + input.records.length,
    newInLastSample: newRows.length,
    duplicatesInLastSample: ids.length - newRows.length,
    estimatedPostsPerHour: estimatedRate,
    measuredSpanHours: spanHours,
    capReached,
    coverage,
    ordering,
    coverageGaps: (existing?.coverageGaps ?? 0) + (coverage === 'possible_gap' ? 1 : 0),
    nonChronologicalSamples: (existing?.nonChronologicalSamples ?? 0) + (ordering === 'non_chronological' ? 1 : 0),
    supply: classValues.filter((value) => value === 'HOUSING_SUPPLY').length,
    demand: classValues.filter((value) => value === 'HOUSING_DEMAND').length,
    irrelevant: classValues.filter((value) => value === 'IRRELEVANT').length,
    unclassified: [...new Set([...(existing?.knownIds ?? []), ...ids])].filter((id) => !classes[id] || classes[id] === 'UNCLASSIFIED').length,
    sameAuthorReposts,
    recentSignatures: Object.fromEntries(signatureEntries),
  };
  state.groups[input.groupUrl] = next;
  return next;
}

/** Late classification may be imported independently of an already observed raw snapshot. */
export function applyGroupClassifications(state: GroupMonitorState, groupUrl: string, updates: Record<string, HousingClass>): number {
  const group = state.groups[groupUrl];
  if (!group) return 0;
  const known = new Set(group.knownIds);
  let changed = 0;
  for (const [id, kind] of Object.entries(updates)) {
    if (!known.has(id) || !['HOUSING_SUPPLY', 'HOUSING_DEMAND', 'HOUSING_ADJACENT', 'IRRELEVANT'].includes(kind)) continue;
    if (group.classifiedIds[id] === kind) continue;
    group.classifiedIds[id] = kind;
    changed++;
  }
  const latest = Object.entries(group.classifiedIds).slice(-MAX_KNOWN_IDS);
  group.classifiedIds = Object.fromEntries(latest);
  const classValues = Object.values(group.classifiedIds);
  group.supply = classValues.filter((kind) => kind === 'HOUSING_SUPPLY').length;
  group.demand = classValues.filter((kind) => kind === 'HOUSING_DEMAND').length;
  group.irrelevant = classValues.filter((kind) => kind === 'IRRELEVANT').length;
  group.unclassified = group.knownIds.filter((id) => !group.classifiedIds[id] || group.classifiedIds[id] === 'UNCLASSIFIED').length;
  return changed;
}

export function planGroups(state: GroupMonitorState, groups: MonitorGroup[], nowIso: string, maxPerGroup: number): GroupScrapePlan[] {
  const now = time(nowIso);
  if (now === null || !Number.isSafeInteger(maxPerGroup) || maxPerGroup < 1) throw new Error('Invalid monitor plan arguments');
  return groups.map((group) => {
    const history = state.groups[group.url];
    // During the first 72 hours, prioritize calibration even in apparently quiet groups.
    const calibrating = !history || (history.observations < 3 || now - Date.parse(history.firstObservedAt) < 3 * DAY);
    const rate = history?.estimatedPostsPerHour ?? null;
    const groupLimit = Math.min(maxPerGroup, Math.max(10, history?.coverage === 'possible_gap' || history?.ordering === 'non_chronological' ? 80 : 50));
    const trafficInterval = rate && rate > 0 ? groupLimit * 0.55 / rate : 24;
    let intervalHours = Math.min(calibrating ? 12 : 24, Math.max(1, trafficInterval));
    if (history?.coverage === 'possible_gap' || history?.ordering === 'non_chronological') intervalHours = Math.min(intervalHours, 2);
    const nextDue = history ? Date.parse(history.lastObservedAt) + intervalHours * HOUR : now;
    const due = group.route === 'BRIGHTDATA' && now >= nextDue;
    // Priority is for budget allocation, never grounds for excluding a noisy group.
    const score = (group.priority === 'A' ? 30 : group.priority === 'B' ? 20 : 10)
      + Math.min(25, (rate ?? 0) * 2)
      + (history?.coverage === 'possible_gap' ? 50 : 0)
      + (history?.ordering === 'non_chronological' ? 30 : 0)
      + (history?.demand ?? 0) * 3 + Math.min(15, (history?.supply ?? 0))
      + (history ? Math.min(100, Math.max(0, (now - nextDue) / HOUR)) : 40);
    return {
      name: group.name, url: group.url, route: group.route, priority: group.priority,
      due, nextDueAt: new Date(nextDue).toISOString(), intervalHours: Math.round(intervalHours * 100) / 100,
      limit: groupLimit, estimatedPostsPerHour: rate, coverage: history?.coverage ?? 'unobserved',
      ordering: history?.ordering ?? 'unknown', observations: history?.observations ?? 0,
      newInLastSample: history?.newInLastSample ?? 0, score: Math.round(score),
    };
  }).sort((a, b) => Number(b.due) - Number(a.due) || b.score - a.score || a.url.localeCompare(b.url));
}
