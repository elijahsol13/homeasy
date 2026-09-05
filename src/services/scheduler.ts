import { runKhmer24Scraper } from '../modules/parser/khmer24.scraper';
import { runFacebookScraper } from '../modules/parser/facebook.scraper';
import { createDatabaseBackup } from '../database/backup';
import { runEnrichment } from '../database/enrich-properties';
import type { AppContainer } from '../container';

/**
 * Sequential Scraper Worker & Queue
 *
 * Replaces cron jobs with a deterministic sequential loop:
 *  1. Khmer24 scrape -> cooldown (20s) + forced GC
 *  2. Facebook scrape -> cooldown (20s) + forced GC
 *  3. Daily maintenance check (backup + enrichment + optimize)
 *  4. Inter-cycle pause (10–15 min) -> repeats
 *
 * Guarantees that two Chromium instances NEVER run concurrently,
 * preventing OOM crashes on RAM-constrained VPS environments (AWS t3.micro).
 */
export class ScraperWorker {
  private isRunning = false;
  private isWorking = false;
  private sleepTimeout: NodeJS.Timeout | null = null;
  private resolveSleep: (() => void) | null = null;
  private lastMaintenanceAt = 0;
  private readonly MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly container: AppContainer,
    private readonly cyclePauseMs = 12 * 60 * 1000, // 12 minutes default
  ) {}

  private triggerGc(taskName: string): void {
    if (typeof global.gc === 'function') {
      try {
        global.gc();
        const mem = process.memoryUsage();
        const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
        const rssMb = Math.round(mem.rss / 1024 / 1024);
        console.log(`🧹 [Worker] Forced GC after ${taskName} (Heap: ${heapUsedMb}MB, RSS: ${rssMb}MB).`);
      } catch {
        // ignore
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveSleep = resolve;
      this.sleepTimeout = setTimeout(() => {
        this.resolveSleep = null;
        this.sleepTimeout = null;
        resolve();
      }, ms);
      this.sleepTimeout.unref();
    });
  }

  private interruptSleep(): void {
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = null;
    }
    if (this.resolveSleep) {
      this.resolveSleep();
      this.resolveSleep = null;
    }
  }

  private async checkAndRunMaintenance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMaintenanceAt < this.MAINTENANCE_INTERVAL_MS) {
      return;
    }

    console.log(`\n🛡️ [Worker] Starting scheduled database maintenance at ${new Date().toISOString()}...`);
    try {
      // Step 1: Pre-maintenance backup
      console.log('📦 [Worker] Creating pre-maintenance database backup...');
      const backupResult = createDatabaseBackup();
      if (!backupResult.success) {
        console.error(`🚨 [Worker] Database backup failed: ${backupResult.error}. Skipping maintenance.`);
        return;
      }
      console.log(`✅ [Worker] Backup verified: ${backupResult.filename} (${Math.round((backupResult.sizeBytes ?? 0) / 1024)} KB)`);

      // Step 2: Enrichment & spam filtering
      console.log('🔍 [Worker] Running database enrichment and spam filtering...');
      const enrichStats = runEnrichment();
      console.log(`✅ [Worker] Enrichment complete. Enriched: ${enrichStats.totalUpdated}, Spam culled: ${enrichStats.deactivatedSpam}`);

      // Step 3: SQLite Query Planner Optimization
      try {
        this.container.db.exec('PRAGMA optimize;');
      } catch (e) {
        console.warn('⚠️ [Worker] PRAGMA optimize warning:', e);
      }

      this.lastMaintenanceAt = Date.now();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`💥 [Worker] Maintenance error: ${msg}`);
    } finally {
      this.triggerGc('Maintenance');
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ [Worker] Scraper worker is already running.');
      return;
    }

    this.isRunning = true;
    console.log(`🚀 [Worker] Scraper worker started (cycle pause: ${Math.round(this.cyclePauseMs / 60000)}m).`);

    while (this.isRunning) {
      this.isWorking = true;

      try {
        // ── 1. Daily Maintenance Check ──────────────────────────────────────
        await this.checkAndRunMaintenance();
        if (!this.isRunning) break;

        // ── 2. Khmer24 Scraper ──────────────────────────────────────────────
        console.log(`\n⏰ [Worker] Starting Khmer24 scrape at ${new Date().toISOString()}...`);
        try {
          await runKhmer24Scraper(this.container);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`💥 [Worker] Error during Khmer24 scrape: ${msg}`);
        } finally {
          this.triggerGc('Khmer24');
          console.log('🏁 [Worker] Khmer24 scrape finished.');
        }

        if (!this.isRunning) break;

        // Cooldown between scrapers (20 seconds)
        console.log('⏳ [Worker] Cooldown 20s before Facebook scrape...');
        await this.sleep(20000);

        if (!this.isRunning) break;

        // ── 3. Facebook Scraper ─────────────────────────────────────────────
        console.log(`\n⏰ [Worker] Starting Facebook scrape at ${new Date().toISOString()}...`);
        try {
          // Humanized jitter (5s - 15s)
          const jitterMs = Math.floor(Math.random() * 10000) + 5000;
          console.log(`🎲 [Worker] Anti-bot jitter: waiting ${Math.round(jitterMs / 1000)}s...`);
          await this.sleep(jitterMs);

          if (!this.isRunning) break;

          await runFacebookScraper(this.container);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`💥 [Worker] Error during Facebook scrape: ${msg}`);
        } finally {
          this.triggerGc('Facebook');
          console.log('🏁 [Worker] Facebook scrape finished.');
        }
      } catch (fatalCycleError: unknown) {
        const msg = fatalCycleError instanceof Error ? fatalCycleError.message : String(fatalCycleError);
        console.error(`💥 [Worker] Unexpected worker cycle failure: ${msg}`);
      } finally {
        this.isWorking = false;
      }

      if (!this.isRunning) break;

      const pauseMinutes = Math.round(this.cyclePauseMs / 60000);
      console.log(`\n💤 [Worker] All tasks complete. Sleeping for ${pauseMinutes} minutes until next cycle...`);
      await this.sleep(this.cyclePauseMs);
    }

    console.log('🛑 [Worker] Sequential worker loop terminated cleanly.');
  }

  public stop(): void {
    if (!this.isRunning) return;
    console.log('🛑 [Worker] Stopping scraper worker...');
    this.isRunning = false;
    this.interruptSleep();
  }

  public getStatus(): { isRunning: boolean; isWorking: boolean } {
    return {
      isRunning: this.isRunning,
      isWorking: this.isWorking,
    };
  }
}

// ── Global Worker Instance for Convenience & Backward Compatibility ──────────

let activeWorkerInstance: ScraperWorker | null = null;

/**
 * Starts the sequential scraper worker.
 * @param pauseMinutes Time in minutes to pause between scraping cycles (default: 12m).
 */
export function startWorker(container: AppContainer, pauseMinutes = 12): ScraperWorker {
  if (activeWorkerInstance) {
    console.log('⚠️ [Worker] Worker already running.');
    return activeWorkerInstance;
  }

  const worker = new ScraperWorker(container, pauseMinutes * 60 * 1000);
  activeWorkerInstance = worker;
  // Start in background without awaiting to allow caller to proceed
  worker.start().catch((err) => {
    console.error('💥 [Worker] Unhandled error in worker:', err);
  });

  return worker;
}

/**
 * Stops the active scraper worker.
 */
export function stopWorker(): void {
  if (activeWorkerInstance) {
    activeWorkerInstance.stop();
    activeWorkerInstance = null;
  }
}

/** Legacy alias for startWorker */
export function startScheduler(container: AppContainer, _cronExpr?: string): void {
  startWorker(container);
}

/** Legacy alias for stopWorker */
export function stopScheduler(): void {
  stopWorker();
}
