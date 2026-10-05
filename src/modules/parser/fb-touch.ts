/**
 * Facebook Session Touch — minimal liveness check.
 *
 * Loads the saved session in headless Camoufox, opens the Facebook home page
 * exactly once (no groups, no scrolling, no interaction) and reports whether
 * the session is still valid or Facebook is showing a challenge.
 *
 * Safe by design: a detected challenge is reported, never retried.
 */

import fs from 'fs';
import { launchCamoufox } from './camoufox-server';
import { attachTrafficGuard } from './traffic-guard';
import {
  FB_SESSION_PATH,
  acquireFacebookRuntimeLock,
  detectFacebookChallenge,
  getAuthenticatedFacebookAccountId,
} from './fb-runtime';

async function runFbTouch(): Promise<void> {
  if (!fs.existsSync(FB_SESSION_PATH)) {
    console.error('❌ No saved session. Run `npm run fb:login` first.');
    process.exit(1);
  }

  const releaseLock = acquireFacebookRuntimeLock('scrape');
  let camoufox: Awaited<ReturnType<typeof launchCamoufox>> | null = null;
  let context = null;

  try {
    camoufox = await launchCamoufox({ headless: true });
    context = await camoufox.browser.newContext({ storageState: FB_SESSION_PATH });
    const page = await context.newPage();
    await attachTrafficGuard(page);

    console.log('🔗 Loading facebook.com once (no scrolling, no groups)...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4000);

    const challenge = await detectFacebookChallenge(page);
    const accountId = await getAuthenticatedFacebookAccountId(context);
    const url = page.url();

    if (challenge) {
      console.error(`🚨 Challenge detected: ${challenge} (url: ${url})`);
      console.error('   Session NOT usable — do not scrape. Re-run `npm run fb:login` when ready.');
      process.exitCode = 2;
    } else if (!accountId) {
      console.error(`❌ Session cookies missing (url: ${url}) — login again via \`npm run fb:login\`.`);
      process.exitCode = 2;
    } else {
      console.log(`✅ Session valid for account ${accountId} (url: ${url})`);
      // Persist refreshed cookies (fb rotates xs/datr on each visit).
      await context.storageState({ path: FB_SESSION_PATH });
      console.log('💾 Refreshed session state saved.');
    }
  } finally {
    if (context) await context.close().catch(() => {});
    if (camoufox) await camoufox.close().catch(() => {});
    releaseLock();
  }
}

if (require.main === module) {
  runFbTouch().catch((err) => {
    console.error('💥 Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
