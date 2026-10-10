import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import type { DatabaseSync } from 'node:sqlite';
import { assertLegacyPropertiesUnchanged, installLegacyPropertiesWriteGuard, snapshotLegacyProperties } from '../../database/legacy-write-guard';
import type { IngestionService } from './ingestor';
import { Khmer24LiveAdapter, type LiveListingEnvelope } from './live-source-adapters';
import { launchCamoufox, type CamoufoxBrowser } from './camoufox-server';
import type { RawListing } from './schemas';

const MAX_DISCOVERY_ITEMS = 10;

export interface CanonicalKhmer24DiscoveryTarget {
  name: string;
  category: 'house' | 'apartment' | 'room' | 'hotel';
  city: 'siem_reap';
  type: 'rent';
  categorySlug: string;
  locationSlug: 'siem-reap';
}

export const CANONICAL_KHMER24_DISCOVERY_TARGETS: readonly CanonicalKhmer24DiscoveryTarget[] = [
  { name: 'Siem Reap — Houses for Rent', category: 'house', city: 'siem_reap', type: 'rent', categorySlug: 'house-for-rent', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Apartments & Condos for Rent', category: 'apartment', city: 'siem_reap', type: 'rent', categorySlug: 'apartment-for-rent', locationSlug: 'siem-reap' },
  { name: 'Siem Reap — Rooms for Rent', category: 'room', city: 'siem_reap', type: 'rent', categorySlug: 'room-for-rent', locationSlug: 'siem-reap' },
];

export interface CanonicalKhmer24DiscoveryOptions {
  /** Fail closed. A caller must set a small, explicit item cap. */
  maxItems?: number;
  /** Existing Siem Reap rental feed targets; callers cannot supply arbitrary URLs. */
  targets?: readonly CanonicalKhmer24DiscoveryTarget[];
  /** Test seam. Production uses guarded Camoufox acquisition below. */
  acquire?: (browser: Browser, target: CanonicalKhmer24DiscoveryTarget, maxItems: number) => Promise<RawListing[]>;
  observedAt?: string;
}

export interface CanonicalKhmer24DiscoveryReport {
  disabled: boolean;
  requestedItemCap: number;
  feedTargets: number;
  fetched: number;
  ingestion?: Awaited<ReturnType<IngestionService['ingestBatch']>>;
  mutationReport?: Awaited<ReturnType<IngestionService['ingestBatch']>>['mutationReport'];
}

/**
 * Bounded canonical discovery only. It deliberately does not call the legacy
 * Khmer24 runner, Node HTTP transport, enrichment, or legacy persistence.
 * The historical browser acquisition function is used only as a RawListing
 * producer; all storage crosses Khmer24LiveAdapter -> IngestionService.
 */
export class CanonicalKhmer24DiscoveryRunner {
  constructor(private readonly db: DatabaseSync, private readonly ingestion: Pick<IngestionService, 'ingestBatch'>) {}

  async run(options: CanonicalKhmer24DiscoveryOptions = {}): Promise<CanonicalKhmer24DiscoveryReport> {
    const maxItems = options.maxItems ?? 0;
    if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > MAX_DISCOVERY_ITEMS) {
      throw new Error(`maxItems must be an integer from 0 through ${MAX_DISCOVERY_ITEMS}`);
    }
    if (maxItems === 0) return { disabled: true, requestedItemCap: 0, feedTargets: 0, fetched: 0 };
    const targets = [...(options.targets ?? CANONICAL_KHMER24_DISCOVERY_TARGETS)];
    if (!targets.length) throw new Error('At least one reviewed Khmer24 target is required');
    if (targets.some((target) => target.city !== 'siem_reap' || target.type !== 'rent')) {
      throw new Error('Canonical Khmer24 discovery is limited to reviewed Siem Reap rental targets');
    }

    const basePath = process.cwd();
    const devicePath = path.join(basePath, 'data', 'k24_device.json');
    if (!fs.existsSync(devicePath)) throw new Error(`Khmer24 pinned device is missing: ${devicePath}`);
    const legacyBefore = snapshotLegacyProperties(this.db);
    installLegacyPropertiesWriteGuard(this.db);
    const acquire = options.acquire ?? (async (browser: Browser, target: CanonicalKhmer24DiscoveryTarget, cap: number) => {
      // Keep the old module outside this runner's import graph. Its exported
      // browser function is a RawListing-only acquisition primitive; this
      // runner never invokes its legacy persistence orchestration.
      const { scrapeTargetWithBrowser } = await import('./khmer24.scraper');
      return scrapeTargetWithBrowser(browser, target, cap);
    });
    let camoufox: CamoufoxBrowser | undefined;
    try {
      camoufox = await launchCamoufox({ headless: true, devicePath });
      const listings: RawListing[] = [];
      let targetCount = 0;
      for (const target of targets) {
        if (listings.length >= maxItems) break;
        targetCount++;
        const remaining = maxItems - listings.length;
        // scrapeTargetWithBrowser applies attachTrafficGuard before every
        // feed/detail navigation. No direct HTTP preflight is used here.
        const batch = await acquire(camoufox.browser, target, remaining);
        listings.push(...batch.slice(0, remaining));
      }
      const envelopes: LiveListingEnvelope[] = listings.map((listing) => ({
        listing,
        sourceName: 'Khmer24 Siem Reap',
        sourceId: 'siem-reap',
        sourceUrl: 'https://www.khmer24.com/en',
        classification: 'HOUSING_SUPPLY',
      }));
      const adapter = new Khmer24LiveAdapter(async function* () { yield* envelopes; });
      const ingestion = await this.ingestion.ingestBatch(adapter, {
        runType: 'DISCOVERY',
        ingestionMethod: 'KHMER24_SCRAPER',
        parserVersion: 'canonical-khmer24-camoufox-v1',
        observedAt: options.observedAt,
        atomicDbStage: true,
      });
      return {
        disabled: false, requestedItemCap: maxItems, feedTargets: targetCount, fetched: listings.length,
        ingestion, mutationReport: ingestion.mutationReport,
      };
    } finally {
      if (camoufox) await camoufox.close().catch(() => {});
      assertLegacyPropertiesUnchanged(this.db, legacyBefore);
    }
  }
}
