import cron, { type ScheduledTask } from 'node-cron';
import { runKhmer24Scraper } from '../modules/parser/khmer24.scraper';
import { runFacebookScraper } from '../modules/parser/facebook.scraper';
import type { AppContainer } from '../container';

let khmer24Job: ScheduledTask | null = null;
let facebookJob: ScheduledTask | null = null;
let activeScraper: 'khmer24' | 'facebook' | null = null;

function triggerGc(scraperName: string): void {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
      const mem = process.memoryUsage();
      const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
      const rssMb = Math.round(mem.rss / 1024 / 1024);
      console.log(`🧹 [Scheduler] Forced GC after ${scraperName} (Heap: ${heapUsedMb}MB, RSS: ${rssMb}MB).`);
    } catch {
      // ignore
    }
  }
}

/**
 * Starts automated background recurring scrapers on SEPARATE, STAGGERED schedules.
 *
 * Khmer24 and Facebook scrapers run completely independently and NEVER execute
 * in parallel thanks to an overarching concurrency mutex lock.
 *
 * Defaults:
 * - Khmer24: Runs at :00, :15, :30, :45 (every 15 min, lightweight HTTP API)
 * - Facebook: Runs at :07, :27, :47 (every 20 min, staggered by 7 min to prevent collision)
 */
export function startScheduler(
  container: AppContainer,
  k24Cron = '*/15 * * * *',
  fbCron = '7,27,47 * * * *',
): void {
  if (khmer24Job || facebookJob) {
    console.log('⚠️ [Scheduler] Scraper cron jobs are already registered');
    return;
  }

  console.log(`⏰ [Scheduler] Registering independent scrapers:`);
  console.log(`   🇰🇭 Khmer24 cron : ${k24Cron}`);
  console.log(`   📘 Facebook cron : ${fbCron}`);

  // ── 1. Khmer24 Scraper Schedule ───────────────────────────────────────────
  khmer24Job = cron.schedule(k24Cron, async () => {
    if (activeScraper !== null) {
      console.warn(`⚠️ [Scheduler] Skipping Khmer24: '${activeScraper}' is currently running.`);
      return;
    }

    activeScraper = 'khmer24';
    console.log(`\n⏰ [Scheduler] Triggering Khmer24 scrape at ${new Date().toISOString()}...`);

    try {
      await runKhmer24Scraper(container);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`💥 [Scheduler] Error during Khmer24 scrape: ${msg}`);
    } finally {
      activeScraper = null;
      triggerGc('Khmer24');
      console.log('🏁 [Scheduler] Khmer24 scrape completed.');
    }
  });

  // ── 2. Facebook Groups Scraper Schedule ───────────────────────────────────
  facebookJob = cron.schedule(fbCron, async () => {
    if (activeScraper !== null) {
      console.warn(`⚠️ [Scheduler] Skipping Facebook: '${activeScraper}' is currently running.`);
      return;
    }

    activeScraper = 'facebook';
    console.log(`\n⏰ [Scheduler] Triggering Facebook scrape at ${new Date().toISOString()}...`);

    try {
      // Add random humanized jitter (5s - 20s) before starting so request timing is non-robotic
      const jitterMs = Math.floor(Math.random() * 15000) + 5000;
      console.log(`🎲 [Scheduler] Applying ${Math.round(jitterMs / 1000)}s anti-bot jitter before launch...`);
      await new Promise<void>((r) => setTimeout(r, jitterMs));

      await runFacebookScraper(container);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`💥 [Scheduler] Error during Facebook scrape: ${msg}`);
    } finally {
      activeScraper = null;
      triggerGc('Facebook');
      console.log('🏁 [Scheduler] Facebook scrape completed.');
    }
  });

  console.log('✅ [Scheduler] Independent scrapers scheduled successfully (zero overlap guaranteed).');
}

/**
 * Cleanly stops all scraper cron schedules.
 */
export function stopScheduler(): void {
  if (khmer24Job) {
    khmer24Job.stop();
    khmer24Job = null;
  }
  if (facebookJob) {
    facebookJob.stop();
    facebookJob = null;
  }
  activeScraper = null;
  console.log('🛑 [Scheduler] All scraper schedules stopped.');
}
