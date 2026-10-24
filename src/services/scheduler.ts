import fs from 'node:fs';
import { runKhmer24Scraper } from '../modules/parser/khmer24.scraper';
import type { RunKhmer24Options } from '../modules/parser/khmer24.scraper';
import { createDatabaseBackup } from '../database/backup';
import type { AppContainer } from '../container';
import { env } from '../config/env';
import { getScraperSettings } from './settings';

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

/** Optional bounds for an attended worker verification. Defaults retain normal scheduling. */
export interface ScraperWorkerOptions {
  khmer24?: RunKhmer24Options;
  maxCycles?: number;
  skipFacebook?: boolean;
}

/**
 * Sequential Scraper Worker & Queue
 *
 * Replaces cron jobs with a deterministic sequential loop:
 *  1. Khmer24 scrape -> cooldown (20s) + forced GC
 *  2. Facebook scrape -> cooldown (20s) + forced GC
 *  3. Daily maintenance check (backup + optimize)
 *  4. Configured inter-cycle pause (110 min by default) -> repeats
 *
 * Runs browser scraping sequentially to avoid concurrent browser memory spikes.
 */
export class ScraperWorker {
  private isRunning = false;
  private isWorking = false;
  private completedCycles = 0;
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
    private readonly cyclePauseMs = (env.SCRAPER_CYCLE_PAUSE_MINUTES ?? 110) * 60 * 1000, // configurable scraper cycle cadence
    private readonly options: ScraperWorkerOptions = {},
  ) {
    if (options.maxCycles !== undefined && (!Number.isSafeInteger(options.maxCycles) || options.maxCycles < 1)) {
      throw new Error('maxCycles must be a positive safe integer');
    }
  }

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

  private async checkDiskSpace(): Promise<void> {
    try {
      const checkPath = fs.existsSync(env.DATABASE_PATH) ? env.DATABASE_PATH : process.cwd();
      const stat = fs.statfsSync(checkPath);
      if (stat.blocks > 0) {
        const freePercent = (stat.bfree / stat.blocks) * 100;
        if (freePercent < 15) {
          await this.container.alertService.critical('<b>Low Disk Space Alert!</b> Less than 15% disk space remaining.');
        }
      }
    } catch (err) {
      console.warn('⚠️ [Worker] Failed to check disk space:', err);
    }
  }

  private async checkAndRunMaintenance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMaintenanceAt < this.MAINTENANCE_INTERVAL_MS) {
      return;
    }

    console.log(`\n🛡️ [Worker] Starting scheduled database maintenance at ${new Date().toISOString()}...`);
    try {
      // Step 0: Disk space check
      await this.checkDiskSpace();

      // Step 1: Pre-maintenance backup
      console.log('📦 [Worker] Creating pre-maintenance database backup...');
      const backupResult = createDatabaseBackup();
      if (!backupResult.success) {
        console.error(`🚨 [Worker] Database backup failed: ${backupResult.error}. Skipping maintenance.`);
        return;
      }
      console.log(`✅ [Worker] Backup verified: ${backupResult.filename} (${Math.round((backupResult.sizeBytes ?? 0) / 1024)} KB)`);

      // Step 2: SQLite Query Planner Optimization.
      // Legacy enrichment and link verification target main.properties and must
      // not run after the canonical ingestion/read cutover.
      try {
        this.container.db.exec('PRAGMA optimize;');
      } catch (e) {
        console.warn('⚠️ [Worker] PRAGMA optimize warning:', e);
      }

      // Step 3: Daily parse-issues report to admins
      await this.sendParseIssuesReport();

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
        const k24Start = Date.now();
        try {
          const k24Stats = await runKhmer24Scraper(this.container, this.options.khmer24);
          const durationMs = Date.now() - k24Start;
          if (k24Stats) {
            this.hourlyStats.khmer24.scraped += k24Stats.totalScraped;
            this.hourlyStats.khmer24.inserted += k24Stats.inserted;
            this.hourlyStats.khmer24.duplicates += k24Stats.duplicates;
            this.hourlyStats.khmer24.errors += k24Stats.errors;

            // Persist to historical metrics table
            try {
              this.container.metricsRepo.recordScraperRun({
                service: 'khmer24',
                total_scraped: k24Stats.totalScraped,
                inserted: k24Stats.inserted,
                duplicates: k24Stats.duplicates,
                errors: k24Stats.errors,
                duration_ms: durationMs,
              });
            } catch (err) {
              console.warn('[Worker] Failed to persist Khmer24 metrics:', err);
            }
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

        // ── 3. Facebook runs only in the explicitly local, combined worker. ──
        // Avoid loading any Facebook automation modules on the VPS worker.
        if (!this.options.skipFacebook && getScraperSettings().facebookEnabled) {
          const { loadFacebookSafetyState } = await import('../modules/parser/fb-runtime');
          const safetyState = loadFacebookSafetyState();
          if (safetyState.status === 'blocked') {
            console.log(`\n⛔ [Worker] Facebook safety-locked: ${safetyState.reason ?? 'manual login required'}`);
          } else {
            console.log('⏳ [Worker] Cooldown 20s before Facebook scrape...');
            await this.sleep(20000);
            if (!this.isRunning) break;
            console.log(`\n⏰ [Worker] Starting Facebook scrape at ${new Date().toISOString()}...`);
            const fbStart = Date.now();
            try {
              // Humanized jitter (5s - 15s)
              const jitterMs = Math.floor(Math.random() * 10000) + 5000;
              console.log(`🎲 [Worker] Anti-bot jitter: waiting ${Math.round(jitterMs / 1000)}s...`);
              await this.sleep(jitterMs);

              if (!this.isRunning) break;

              const { runFacebookScraper } = await import('../modules/parser/facebook.scraper');
              const fbStats = await runFacebookScraper(this.container);
              const durationMs = Date.now() - fbStart;

              if (fbStats) {
                this.hourlyStats.facebook.scraped += fbStats.totalScraped;
                this.hourlyStats.facebook.inserted += fbStats.inserted;
                this.hourlyStats.facebook.duplicates += fbStats.duplicates;
                this.hourlyStats.facebook.errors += fbStats.errors;

                // Zero Yield Anomaly: warn admins if Facebook returned 0 listings
                if (fbStats.inserted === 0 && fbStats.totalScraped === 0) {
                  await this.container.alertService.warn(
                    '<b>Zero Yield:</b> Facebook scraper finished with 0 posts found. Verify GraphQL response or cookies.',
                  );
                }

                // Persist to historical metrics table
                try {
                  this.container.metricsRepo.recordScraperRun({
                    service: 'facebook',
                    total_scraped: fbStats.totalScraped,
                    inserted: fbStats.inserted,
                    duplicates: fbStats.duplicates,
                    errors: fbStats.errors,
                    duration_ms: durationMs,
                  });
                } catch (err) {
                  console.warn('[Worker] Failed to persist Facebook metrics:', err);
                }
              }
            } catch (err: unknown) {
              this.hourlyStats.facebook.errors++;
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`💥 [Worker] Error during Facebook scrape: ${msg}`);
            } finally {
              this.triggerGc('Facebook');
              console.log('🏁 [Worker] Facebook scrape finished.');
            }
          }
        }

        this.hourlyStats.cyclesCompleted++;
        this.completedCycles++;

        // ── 4. Hourly Heartbeat Notification ────────────────────────────────
        await this.checkAndSendHeartbeat();
      } catch (fatalCycleError: unknown) {
        const msg = fatalCycleError instanceof Error ? fatalCycleError.message : String(fatalCycleError);
        console.error(`💥 [Worker] Unexpected worker cycle failure: ${msg}`);
      } finally {
        this.isWorking = false;
      }

      if (this.options.maxCycles !== undefined && this.completedCycles >= this.options.maxCycles) {
        this.stop();
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


      // Usage analytics query
      let analyticsText = '';
      try {
        const analytics1h = this.container.analyticsRepo.getSummary(1);
        const active24h = this.container.analyticsRepo.get24hActiveUsersCount();
        const breakdownParts: string[] = [];
        if (analytics1h.eventBreakdown['bot_command']) {
          breakdownParts.push(`Cmds: ${analytics1h.eventBreakdown['bot_command']}`);
        }
        if (analytics1h.eventBreakdown['tma_request']) {
          breakdownParts.push(`TMA: ${analytics1h.eventBreakdown['tma_request']}`);
        }
        if (analytics1h.eventBreakdown['bot_callback']) {
          breakdownParts.push(`Clicks: ${analytics1h.eventBreakdown['bot_callback']}`);
        }
        const breakdownStr = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';

        analyticsText =
          `👥 <b>Usage Analytics:</b>\n` +
          `  • Active users (1h / 24h): <b>${analytics1h.activeUsers}</b> / <b>${active24h}</b>\n` +
          `  • Interactions (1h): <b>${analytics1h.totalEvents}</b>${breakdownStr}\n\n`;
      } catch {
        // ignore analytics query error in heartbeat
      }

      // Historical all-time metrics
      let allTimeText = '';
      try {
        const allTime = this.container.metricsRepo.getAllTimeSummary();
        if (allTime.runsCount > 0) {
          allTimeText = `📚 <b>All-Time Scraped:</b> ${allTime.totalScraped.toLocaleString()} (Inserted: +${allTime.inserted.toLocaleString()})\n\n`;
        }
      } catch {
        // ignore
      }

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
        `\n` +
        analyticsText +
        allTimeText +
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

  /**
   * Aggregates `parse_warnings` collected by the ingestor over the last 24h
   * (plus an all-time histogram) and reports the top extraction issues to
   * admins — this is the feedback loop for tuning scrapers/prompts.
   */
  private async sendParseIssuesReport(): Promise<void> {
    try {
      const rows = this.container.db
        .prepare(
          `SELECT parse_warnings, created_at FROM properties
           WHERE parse_warnings IS NOT NULL AND parse_warnings != '[]'`,
        )
        .all() as unknown as Array<{ parse_warnings: string; created_at: string }>;

      if (rows.length === 0) return;

      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const allTime = new Map<string, number>();
      const last24h = new Map<string, number>();
      const unresolvedLocations = new Map<string, number>();

      for (const row of rows) {
        let codes: string[] = [];
        try {
          codes = JSON.parse(row.parse_warnings) as string[];
        } catch {
          continue;
        }
        const isRecent = (row.created_at ?? '') >= dayAgo;
        for (const code of codes) {
          const key = code.split(':')[0] ?? code;
          allTime.set(key, (allTime.get(key) ?? 0) + 1);
          if (isRecent) last24h.set(key, (last24h.get(key) ?? 0) + 1);
          if (key === 'location_unrecognized' || key === 'commerce_location_unresolved') {
            const val = code.split(':').slice(1).join(':');
            if (val) unresolvedLocations.set(val, (unresolvedLocations.get(val) ?? 0) + 1);
          }
        }
      }

      const fmt = (m: Map<string, number>) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k, v]) => `  • <code>${k}</code> — ${v}`)
          .join('\n');

      const topUnresolved = [...unresolvedLocations.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([v, c]) => `  • ${v} (×${c})`)
        .join('\n');

      const message =
        `🧪 <b>Parse Issues Report</b> (daily)\n\n` +
        `<b>Last 24h:</b>\n${fmt(last24h) || '  • none'}\n\n` +
        `<b>All-time:</b>\n${fmt(allTime)}\n` +
        (topUnresolved ? `\n<b>Top unresolved locations:</b>\n${topUnresolved}` : '');

      await this.container.notifierService.notifyAdmins(message);
      console.log('🧪 [Worker] Parse issues report sent to admins.');
    } catch (err) {
      console.warn('⚠️ [Worker] Parse issues report failed:', err);
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
let activeWorkerTask: Promise<void> | null = null;

/**
 * Starts the sequential scraper worker.
 * @param pauseMinutes Time in minutes to pause between scraping cycles (default: 12m).
 */
export function startWorker(
  container: AppContainer,
  pauseMinutes = env.SCRAPER_CYCLE_PAUSE_MINUTES ?? 45,
  options: ScraperWorkerOptions = {},
): ScraperWorker {
  if (activeWorkerInstance) {
    console.log('⚠️ [Worker] Worker already running.');
    return activeWorkerInstance;
  }

  const worker = new ScraperWorker(container, pauseMinutes * 60 * 1000, options);
  activeWorkerInstance = worker;
  // The caller can continue startup, but graceful shutdown must retain the
  // worker promise until all in-flight scraper/maintenance DB writes finish.
  activeWorkerTask = worker.start()
    .catch((err) => {
      console.error('💥 [Worker] Unhandled error in worker:', err);
    })
    .finally(() => {
      if (activeWorkerInstance === worker) {
        activeWorkerInstance = null;
        activeWorkerTask = null;
      }
    });

  return worker;
}

/**
 * Stops the active scraper worker.
 */
export function stopWorker(): void {
  if (activeWorkerInstance) {
    activeWorkerInstance.stop();
  }
}

/** Stop scheduling new work, and wait for the current operation to settle before closing SQLite. */
export async function stopWorkerAndWait(): Promise<void> {
  stopWorker();
  if (activeWorkerTask) await activeWorkerTask;
}

/** Legacy alias for startWorker */
export function startScheduler(container: AppContainer, _cronExpr?: string): void {
  startWorker(container);
}

/** Legacy alias for stopWorker */
export function stopScheduler(): void {
  stopWorker();
}
