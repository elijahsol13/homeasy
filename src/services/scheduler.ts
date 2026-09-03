import cron, { type ScheduledTask } from 'node-cron';
import { runKhmer24Scraper } from '../modules/parser/khmer24.scraper';
import { runFacebookScraper } from '../modules/parser/facebook.scraper';
import type { AppContainer } from '../container';

let scraperJob: ScheduledTask | null = null;
let isScrapingRunning = false;

/**
 * Starts the automated recurring background scraper cron job.
 * Runs every 20 minutes (cron: *\/20 * * * *) by default.
 * Sequentially executes Khmer24 scraper followed by Facebook Groups scraper.
 * Includes concurrency protection so overlapping runs are safely skipped.
 */
export function startScheduler(container: AppContainer, cronExpression = '*/20 * * * *'): void {
  if (scraperJob) {
    console.log('⚠️ [Scheduler] Cron job is already running');
    return;
  }

  console.log(`⏰ [Scheduler] Registering real estate scrapers cron (${cronExpression})...`);

  scraperJob = cron.schedule(cronExpression, async () => {
    if (isScrapingRunning) {
      console.warn('⚠️ [Scheduler] Previous scraping cycle is still running, skipping this tick.');
      return;
    }

    console.log(`\n⏰ [Scheduler] Triggering scheduled scrape cycle at ${new Date().toISOString()}...`);
    isScrapingRunning = true;

    try {
      // 1. Run Khmer24 API Scraper
      console.log('▶️  [Scheduler] Step 1/2: Executing Khmer24 Scraper...');
      await runKhmer24Scraper(container);

      // Small pause between platforms
      await new Promise<void>((r) => setTimeout(r, 5000));

      // 2. Run Facebook Groups Scraper
      console.log('▶️  [Scheduler] Step 2/2: Executing Facebook Groups Scraper...');
      await runFacebookScraper(container);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`💥 [Scheduler] Error during scheduled scraping cycle: ${msg}`);
    } finally {
      isScrapingRunning = false;
      console.log('🏁 [Scheduler] Scraping cycle completed.');
    }
  });

  console.log('✅ [Scheduler] Automated background scrapers scheduled successfully.');
}

/**
 * Cleanly stops the cron scheduler. Call on graceful shutdown.
 */
export function stopScheduler(): void {
  if (scraperJob) {
    scraperJob.stop();
    scraperJob = null;
    console.log('🛑 [Scheduler] Scraper scheduler stopped.');
  }
}
