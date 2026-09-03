/**
 * Facebook Manual Login & Session Saver
 *
 * Launches a non-headless Chromium browser with stealth plugins enabled,
 * allowing the user to log in manually (handling 2FA, Captcha, etc.).
 * Once logged in, saves the session cookies and localStorage to `./data/fb_session.json`
 * for the automated headless scraper to reuse.
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

export const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');

async function waitForEnterOrTimeout(timeoutMs: number): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      resolve();
    }, timeoutMs);

    rl.question('\n👉 When you have finished logging in, press [ENTER] here to save session (or wait 60s)...\n', () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

export async function runFbLogin(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔑 Facebook Manual Login & Session Saver — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📁 Session file destination: ${FB_SESSION_PATH}\n`);

  // Ensure data directory exists
  const dataDir = path.dirname(FB_SESSION_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  console.log('🌐 Launching browser window...');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 850 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    console.log('🔗 Navigating to https://www.facebook.com/login ...');
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('⏳ Please log into your Facebook account in the browser window.');

    // Wait for user to log in manually (up to 120s or on Enter press)
    await waitForEnterOrTimeout(120000);

    // Save storage state (cookies + localStorage)
    console.log('\n💾 Saving session state...');
    await context.storageState({ path: FB_SESSION_PATH });

    if (fs.existsSync(FB_SESSION_PATH)) {
      const stats = fs.statSync(FB_SESSION_PATH);
      console.log(`✅ Session saved successfully to ${FB_SESSION_PATH} (${stats.size} bytes)`);
      console.log('🎉 You can now run the Facebook scraper with: npm run scrape:fb\n');
    } else {
      console.error('❌ Failed to create session file.');
    }
  } catch (err: unknown) {
    console.error('❌ Error during Facebook login:', err instanceof Error ? err.message : String(err));
  } finally {
    await browser.close().catch(() => {});
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

