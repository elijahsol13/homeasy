/**
 * Facebook Manual Login & Session Saver (Camoufox)
 *
 * CRITICAL ARCHITECTURAL LAW:
 * Automated headless password entry or console credential passing to Facebook is
 * prohibited (triggers instant checkpoints/blocks). Authentication is performed
 * visually by a human in a headed Camoufox window; this script only waits for
 * the `c_user` cookie and persists `storage_state` to ./data/fb_session.json.
 *
 * The browser runs the pinned device fingerprint (data/fb_device.json) so the
 * login session and every later scraper run look like the same device.
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { env } from '../../config/env';
import { parseProxyConfig, isProxyError } from './proxy';
import type { BrowserContext } from 'playwright';
import { launchCamoufox, type CamoufoxBrowser } from './camoufox-server';
import { attachTrafficGuard } from './traffic-guard';
import {
  FB_SESSION_PATH,
  acquireFacebookRuntimeLock,
  detectFacebookChallenge,
  getAuthenticatedFacebookAccountId,
  markFacebookReady,
} from './fb-runtime';

export { FB_SESSION_PATH } from './fb-runtime';

function waitForEnterOrTimeout(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const timer = setTimeout(() => {
      rl.close();
      resolve();
    }, timeoutMs);

    rl.question('\n👉 When you have finished logging in, press [ENTER] here to save session (or wait 180s)...\n', () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

export async function runFbLogin(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔑 Facebook Login & Session Saver — HomEasy (Camoufox)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📁 Session file destination: ${FB_SESSION_PATH}\n`);

  const dataDir = path.dirname(FB_SESSION_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const useProxy = process.argv.includes('--proxy') || env.FB_PROXY_ENABLED;
  const rawProxy = useProxy ? env.FB_PROXY : undefined;
  const proxyResult = parseProxyConfig(rawProxy);
  if (useProxy && !proxyResult) throw new Error('Facebook proxy was explicitly enabled but FB_PROXY is missing or invalid.');
  console.log(proxyResult ? `🌐 Proxy enabled: ${proxyResult.masked}` : '🏠 Direct connection enabled.');

  const releaseLock = acquireFacebookRuntimeLock('login');
  let camoufox: CamoufoxBrowser | null = null;
  let context: BrowserContext | null = null;

  try {
    console.log('🖥️  Opening a headed Camoufox window (pinned device fingerprint)...');
    camoufox = await launchCamoufox({ headless: false, proxyUrl: rawProxy });
    context = await camoufox.browser.newContext(
      fs.existsSync(FB_SESSION_PATH) ? { storageState: FB_SESSION_PATH } : undefined,
    );
    const page = await context.newPage();
    await attachTrafficGuard(page, { allowStylesheets: true });
    console.log('🔗 Navigating to https://www.facebook.com/login ...');
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    // Dismiss cookie banner if shown
    try {
      const cookieBtn = page.locator(
        'button[data-cookiebanner="accept_button"], button[title="Allow all cookies"], button[title="Only allow essential cookies"], [aria-label="Decline optional cookies"], [aria-label="Allow all cookies"]',
      );
      if ((await cookieBtn.count()) > 0) {
        await cookieBtn.first().click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch {
      // ignore
    }

    console.log('\n⏳ Browser window opened! Please log into Facebook in the browser window.');
    console.log('   (Enter email, password, and 2FA code if requested — nothing is automated.)');

    await waitForEnterOrTimeout(180000);

    const accountId = await getAuthenticatedFacebookAccountId(context);
    const challengeReason = await detectFacebookChallenge(page);
    if (!accountId || challengeReason) {
      throw new Error(
        challengeReason ?? 'Facebook login is incomplete: required authenticated cookies were not found.',
      );
    }

    console.log('\n🎉 Authenticated Facebook session detected.');
    console.log('💾 Saving session state...');
    await context.storageState({ path: FB_SESSION_PATH });
    markFacebookReady(accountId);

    const stats = fs.statSync(FB_SESSION_PATH);
    console.log(`✅ Session saved successfully to ${FB_SESSION_PATH} (${stats.size} bytes)`);
    console.log('🎉 Run a one-group smoke test before enabling the scheduled scraper.\n');
  } catch (err: unknown) {
    if (isProxyError(err)) {
      console.error('\n🚨 PROXY CONNECTION FAILED: Unable to establish tunnel or authenticate through the proxy.');
      console.error(`Details: ${err instanceof Error ? err.message : String(err)}`);
      console.error('👉 Please check your FB_PROXY URL, credentials, and network connectivity.\n');
    } else {
      console.error('❌ Error during Facebook login:', err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
    if (camoufox) await camoufox.close().catch(() => {});
    releaseLock();
  }
}

if (require.main === module) {
  runFbLogin()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('💥 Fatal error:', err);
      process.exit(1);
    });
}
