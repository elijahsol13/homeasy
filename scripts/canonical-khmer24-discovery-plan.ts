import fs from 'node:fs';
import path from 'node:path';
import { CANONICAL_KHMER24_DISCOVERY_TARGETS } from '../src/modules/parser/canonical-khmer24-discovery';

const report = {
  mode: 'PHASE_6B_3_REVIEWED_LIVE_DISCOVERY_PLAN',
  command: 'DATABASE_PATH=/Users/lacr0s/!Projects/homeasy/data/homeasy.db npm run ingestion:khmer24:canonical -- --max-items=10',
  caps: { maxItems: 10, maxFeeds: CANONICAL_KHMER24_DISCOVERY_TARGETS.length, browserInstances: 1, navigation: 'serial' },
  feedTargets: CANONICAL_KHMER24_DISCOVERY_TARGETS.map((target) => ({
    ...target,
    url: `https://www.khmer24.com/en/c-${target.categorySlug}?province=${target.locationSlug}&sortby=newads&date=last-7-days`,
  })),
  transport: {
    camoufox: 'one shared, existing pinned K24 device and optional session',
    trafficGuard: 'attached before every feed/detail navigation',
    nodeHttpPreflight: false, proxy: false, brightData: false, facebook: false, ai: false, scheduler: false,
  },
  canonicalWriteSurfaces: [
    'processing_runs and processing_run_sources', 'source_registry, source_items, source_item_versions',
    'source_item_identifiers', 'canonical properties/listings/occurrences through IngestionService',
    'media URL metadata only; no binary media downloads', 'external_provider_usage (KHMER24 DISCOVERY)',
  ],
  prohibitedWriteSurfaces: ['legacy properties', 'availability_checks', 'freshness_jobs'],
  acceptance: ['fetched <= 10', 'one browser, serial navigation', 'legacy frozen digest unchanged', 'integrity_check=ok', 'foreign_key_check empty', 'canonical dedupe report clean'],
};
const outPath = path.resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? 'reports/phase6b-canonical-discovery-live-plan-20261009.json');
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outPath, ...report }, null, 2));
