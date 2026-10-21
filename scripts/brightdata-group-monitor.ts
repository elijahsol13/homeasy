/**
 * Persistent public-group velocity / coverage / demand monitor.
 * No Bright Data requests or AI. --seed --apply imports saved provider snapshots.
 * Default prints a dry-run plan based on persistent state.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { GROUPS, groupRoute } from './brightdata-batch-test';
import {
  newMonitorState, observeGroup, applyGroupClassifications, planGroups,
  type GroupMonitorState, type HousingClass, type MonitorGroup,
} from '../src/modules/parser/facebook-group-monitor';

export const MONITOR_DIR = path.resolve(process.cwd(), 'tmp', 'brightdata-monitor');
export const MONITOR_STATE_PATH = path.join(MONITOR_DIR, 'state.json');
const RAW_DIR = path.resolve(process.cwd(), 'tmp', 'brightdata-test');

export function monitorRegistry(): MonitorGroup[] {
  return GROUPS.map((group) => ({ ...group, route: groupRoute(group) }));
}

export async function loadMonitorState(filename = MONITOR_STATE_PATH): Promise<GroupMonitorState> {
  try {
    const state: unknown = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!state || typeof state !== 'object' || (state as GroupMonitorState).version !== 1 ||
        !((state as GroupMonitorState).groups && typeof (state as GroupMonitorState).groups === 'object')) {
      throw new Error(`Invalid monitor state: ${filename}`);
    }
    return state as GroupMonitorState;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return newMonitorState();
    throw err;
  }
}

export async function saveMonitorState(state: GroupMonitorState, filename = MONITOR_STATE_PATH): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2));
  await fs.rename(temporary, filename);
}

function observationInstant(runId: string): string | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/.test(runId)) return null;
  const iso = runId.replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3Z');
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** Import raw rows even when classification hasn't been performed yet. */
export async function importSavedObservations(state: GroupMonitorState, rawDir = RAW_DIR): Promise<{ imported: number; skipped: number; classified: number }> {
  const filenames = await fs.readdir(rawDir);
  const files = filenames.filter((name) => name.endsWith('_raw.json')).sort();
  const registry = new Set(monitorRegistry().filter((group) => group.route === 'BRIGHTDATA').map((group) => group.url));
  const classificationByRun = new Map<string, Map<string, Record<string, HousingClass>>>();
  let imported = 0;
  let skipped = 0;
  let classified = 0;
  for (const name of files) {
    const runId = name.slice(0, 19);
    const at = observationInstant(runId);
    if (!at) { skipped++; continue; }
    const saved = JSON.parse(await fs.readFile(path.join(rawDir, name), 'utf8')) as {
      request?: { input?: Array<{ url?: string }>; limit_per_input?: number };
      records?: unknown[];
      response?: unknown;
      state?: string;
    };
    const url = saved.request?.input?.[0]?.url;
    const records = saved.records ?? saved.response;
    if (!url || !registry.has(url) || !Array.isArray(records) || saved.state === 'request_prepared') { skipped++; continue; }
    if (!classificationByRun.has(runId)) {
      const classes = new Map<string, Record<string, HousingClass>>();
      // A retry uses a different output ID to preserve the original failed
      // report, but keeps the source run prefix. Newer successful labels win.
      const classificationFiles = filenames.filter((file) =>
        (file === `${runId}_classified.json` ||
          new RegExp(`^${runId}-[a-zA-Z0-9_-]+_classified\\.json$`).test(file)));
      const ordered = await Promise.all(classificationFiles.map(async (file) => ({
        file, modified: (await fs.stat(path.join(rawDir, file))).mtimeMs,
      })));
      ordered.sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file));
      for (const { file } of ordered) {
        const parsed = JSON.parse(await fs.readFile(path.join(rawDir, file), 'utf8')) as {
          posts?: Array<{ id: string; groupUrl: string; classification: HousingClass }>;
        };
        for (const post of parsed.posts ?? []) {
          // UNCLASSIFIED may mean total provider failure. It must never
          // supersede a real label or make a group appear low-yield.
          if (!['HOUSING_SUPPLY', 'HOUSING_DEMAND', 'HOUSING_ADJACENT', 'IRRELEVANT'].includes(post.classification)) continue;
          if (!classes.has(post.groupUrl)) classes.set(post.groupUrl, {});
          classes.get(post.groupUrl)![post.id] = post.classification;
        }
      }
      classificationByRun.set(runId, classes);
    }
    const key = `${name}:${url}`;
    if (state.groups[url]?.processedKeys.includes(key)) {
      skipped++;
    } else if (state.groups[url] && Date.parse(at) < Date.parse(state.groups[url].lastObservedAt)) {
      // An older raw snapshot discovered after a newer live run must not roll
      // observation time backwards. Its classifications can still be merged.
      skipped++;
    } else if (records.length && !records.some((record) => record && typeof record === 'object' &&
      ('post_id' in record || 'id' in record))) {
      // Bright Data may deliver provider error rows in an HTTP-200 array.
      skipped++;
    } else {
      observeGroup(state, {
        key, groupUrl: url, observedAt: at,
        requestedLimit: saved.request?.limit_per_input || Math.max(1, records.length),
        records,
      });
      imported++;
    }
    classified += applyGroupClassifications(state, url, classificationByRun.get(runId)?.get(url) ?? {});
  }
  return { imported, skipped, classified };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seed = argv.includes('--seed');
  const apply = argv.includes('--apply');
  if (apply && !seed) throw new Error('--apply requires --seed');
  if (seed && !apply) throw new Error('--seed requires --apply to persist observations');
  const state = await loadMonitorState();
  if (seed) {
    const result = await importSavedObservations(state);
    await saveMonitorState(state);
    console.log(`Saved snapshots: imported=${result.imported}, skipped=${result.skipped}, newlyClassified=${result.classified}`);
  }
  const plan = planGroups(state, monitorRegistry(), new Date().toISOString(), 80);
  console.log(JSON.stringify({
    mode: seed ? 'seed-and-plan' : 'plan-only',
    statePath: MONITOR_STATE_PATH,
    publicGroups: plan.filter((g) => g.route === 'BRIGHTDATA').length,
    privateDeferred: plan.filter((g) => g.route === 'CAMOUFOX_DEFERRED').length,
    unresolved: plan.filter((g) => g.route === 'REVIEW').length,
    dueNow: plan.filter((g) => g.due).length,
    groups: plan.map((group) => ({ ...group, state: state.groups[group.url] ? {
      seen: state.groups[group.url].seenCount, lastReturned: state.groups[group.url].totalReturned,
      supply: state.groups[group.url].supply, demand: state.groups[group.url].demand,
      gaps: state.groups[group.url].coverageGaps, nonChronological: state.groups[group.url].nonChronologicalSamples,
      sameAuthorReposts: state.groups[group.url].sameAuthorReposts,
    } : null })),
  }, null, 2));
}

if (require.main === module) main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
