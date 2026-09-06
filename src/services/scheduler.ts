import { runKhmer24Scraper } from '../modules/parser/khmer24.scraper';
import { runFacebookScraper } from '../modules/parser/facebook.scraper';
import { createDatabaseBackup } from '../database/backup';
import { runEnrichment } from '../database/enrich-properties';
import type { AppContainer } from '../container';
import { env } from '../config/env';
import { parseProxyConfig } from '../modules/parser/proxy';

export interface ScraperCategoryStats {
  scraped: number;
  inserted: number;
  duplicates: number;
  errors: number;
}

export interface ScraperHeartbeatStats {
  cyclesCompleted: number;
  khmer24: ScraperCategoryStats;
  facebook: ScraperCategoryStats;
}

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

  private lastHeartbeatAt = Date.now();
  private readonly HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  private hourlyStats: ScraperHeartbeatStats = {
    cyclesCompleted: 0,
    khmer24: { scraped: 0, inserted: 0, duplicates: 0, errors: 0 },
    facebook: { scraped: 0, inserted: 0, duplicates: 0, errors: 0 },
  };

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
          const k24Stats = await runKhmer24Scraper(this.container);
          if (k24Stats) {
            this.hourlyStats.khmer24.scraped += k24Stats.totalScraped;
            this.hourlyStats.khmer24.inserted += k24Stats.inserted;
            this.hourlyStats.khmer24.duplicates += k24Stats.duplicates;
            this.hourlyStats.khmer24.errors += k24Stats.errors;
          }
        } catch (err: unknown) {
          this.hourlyStats.khmer24.errors++;
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

          const fbStats = await runFacebookScraper(this.container);
          if (fbStats) {
            this.hourlyStats.facebook.scraped += fbStats.totalScraped;
            this.hourlyStats.facebook.inserted += fbStats.inserted;
            this.hourlyStats.facebook.duplicates += fbStats.duplicates;
            this.hourlyStats.facebook.errors += fbStats.errors;
          }
        } catch (err: unknown) {
          this.hourlyStats.facebook.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`💥 [Worker] Error during Facebook scrape: ${msg}`);
        } finally {
          this.triggerGc('Facebook');
          console.log('🏁 [Worker] Facebook scrape finished.');
        }

        this.hourlyStats.cyclesCompleted++;

        // ── 4. Hourly Heartbeat Notification ────────────────────────────────
        await this.checkAndSendHeartbeat();
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

  public async sendHeartbeat(): Promise<void> {
    try {
      let totalActive = 0;
      try {
        const row = this.container.db
          .prepare('SELECT count(*) as count FROM properties WHERE is_active = 1')
          .get() as { count: number } | undefined;
        totalActive = row?.count ?? 0;
      } catch {
        // ignore
      }

      const mem = process.memoryUsage();
      const rssMb = Math.round(mem.rss / 1024 / 1024);
      const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);

      const proxy = parseProxyConfig(env.FB_PROXY);
      const proxyStatus = proxy ? `✅ Connected (${proxy.masked})` : '⚠️ Not configured';

      const message =
        `💓 <b>HomEasy Scraper Heartbeat</b> (Hourly Report)\n\n` +
        `⏱ <b>Cycles in last hour:</b> ${this.hourlyStats.cyclesCompleted}\n` +
        `🏠 <b>Total active listings in DB:</b> ${totalActive}\n\n` +
        `🇰🇭 <b>Khmer24:</b>\n` +
        `  • Scraped: <b>${this.hourlyStats.khmer24.scraped}</b>\n` +
        `  • New inserted: <b>+${this.hourlyStats.khmer24.inserted}</b>\n` +
        `  • Duplicates: <b>${this.hourlyStats.khmer24.duplicates}</b>\n` +
        `  • Errors: <b>${this.hourlyStats.khmer24.errors}</b>\n\n` +
        `👥 <b>Facebook Groups:</b>\n` +
        `  • Scraped: <b>${this.hourlyStats.facebook.scraped}</b>\n` +
        `  • New inserted: <b>+${this.hourlyStats.facebook.inserted}</b>\n` +
        `  • Duplicates: <b>${this.hourlyStats.facebook.duplicates}</b>\n` +
        `  • Errors: <b>${this.hourlyStats.facebook.errors}</b>\n` +
        `  • Proxy: <code>${proxyStatus}</code>\n\n` +
        `📊 <b>RAM:</b> RSS ${rssMb}MB | Heap ${heapUsedMb}MB\n` +
        `🕒 <i>Next report in ~1 hour</i>`;

      console.log(`\n💓 [Worker] Sending hourly scraper heartbeat to admins...`);
      await this.container.notifierService.notifyAdmins(message);

      // Reset hourly accumulator
      this.hourlyStats = {
        cyclesCompleted: 0,
        khmer24: { scraped: 0, inserted: 0, duplicates: 0, errors: 0 },
        facebook: { scraped: 0, inserted: 0, duplicates: 0, errors: 0 },
      };
      this.lastHeartbeatAt = Date.now();
    } catch (err: unknown) {
      console.error('[Worker] Failed to send hourly heartbeat:', err);
    }
  }

  private async checkAndSendHeartbeat(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatAt >= this.HEARTBEAT_INTERVAL_MS) {
      await this.sendHeartbeat();
    }
  }

  public getHourlyStats(): ScraperHeartbeatStats {
    return {
      cyclesCompleted: this.hourlyStats.cyclesCompleted,
      khmer24: { ...this.hourlyStats.khmer24 },
      facebook: { ...this.hourlyStats.facebook },
    };
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
