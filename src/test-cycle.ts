import 'dotenv/config';
import { createContainer } from './container';
import { runMigrations } from './database/migrate';
import { runFacebookScraper, FB_GROUP_TARGETS } from './modules/parser/facebook.scraper';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 HomEasy: Test Scrape Cycle 1 (Groups 0–4) Traffic Measurement');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const container = createContainer();
  runMigrations(container.db);

  // Strictly select Groups 0 to 4 (Cycle 1)
  const cycle1Targets = FB_GROUP_TARGETS.slice(0, 5);
  console.log(`📋 Running exactly ${cycle1Targets.length} groups for Cycle 1:`);
  cycle1Targets.forEach((t, i) => console.log(`  ${i + 1}. [${t.name}] (${t.url})`));
  console.log('');

  const startTime = Date.now();
  const stats = await runFacebookScraper(container, {
    targets: cycle1Targets,
    maxScrollsPerGroup: 1,
  });
  const durationSec = Math.round((Date.now() - startTime) / 1000);

  const totalKb = Math.round(stats.wireBytesTransferred / 1024);
  const totalMb = (stats.wireBytesTransferred / 1024 / 1024).toFixed(2);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 TEST CYCLE 1 MEASUREMENT FINAL RESULTS:');
  console.log(`⏱  Duration                  : ${durationSec}s`);
  console.log(`📄 Total Scraped             : ${stats.totalScraped}`);
  console.log(`✅ Inserted                  : ${stats.inserted}`);
  console.log(`🔁 Duplicates / Skipped      : ${stats.duplicates}`);
  console.log(`❌ Errors                    : ${stats.errors}`);
  console.log(`🌐 Exact Proxy Wire Transfer : ${totalMb} MB (${totalKb} KB)`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('💥 Fatal test cycle error:', err);
  process.exit(1);
});
