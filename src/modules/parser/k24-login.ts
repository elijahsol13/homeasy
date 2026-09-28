/**
 * Khmer24 Manual Login & Session Saver
 *
 * Launches a non-headless Chromium browser with stealth plugins enabled,
 * allowing the user to log in manually to Khmer24 (via phone/SMS, email, or Google/Facebook).
 * Once logged in, saves the session cookies and localStorage to `./data/k24_session.json`
 * for the automated headless scraper to reuse.
 *
 * When authenticated on Khmer24, poster phone numbers are displayed in full
 * without the "Show Phone Number" mask (012248XXX -> 012248999).
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { launchCamoufox } from './camoufox-server';
import { attachTrafficGuard } from './traffic-guard';

export const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');
export const K24_DEVICE_PATH = path.join(process.cwd(), 'data', 'k24_device.json');

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

    rl.question(
      '\n👉 When you have finished logging in, press [ENTER] here to save session (or wait 120s)...\n',
      () => {
        clearTimeout(timer);
        rl.close();
        resolve();
      },
    );
  });
}

export async function runK24Login(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔑 Khmer24 Manual Login & Session Saver — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📁 Session file destination: ${K24_SESSION_PATH}\n`);

  // Ensure data directory exists
  const dataDir = path.dirname(K24_SESSION_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  console.log('🌐 Launching browser window...');
  const camoufox = await launchCamoufox({ headless: false, devicePath: K24_DEVICE_PATH });
  const context = await camoufox.browser.newContext(
    fs.existsSync(K24_SESSION_PATH) ? { storageState: K24_SESSION_PATH } : undefined,
  );
  const page = await context.newPage();

  try {
    await attachTrafficGuard(page, { allowStylesheets: true });
    console.log('🔗 Navigating to https://www.khmer24.com/en/login ...');
    await page.goto('https://www.khmer24.com/en/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log('⏳ Please log into your Khmer24 account in the browser window.');

    // Wait for user to log in manually (up to 120s or on Enter press)
    await waitForEnterOrTimeout(120000);

    // Save storage state (cookies + localStorage)
    console.log('\n💾 Saving session state...');
    await context.storageState({ path: K24_SESSION_PATH });

    if (fs.existsSync(K24_SESSION_PATH)) {
      const stats = fs.statSync(K24_SESSION_PATH);
      console.log(`✅ Session saved successfully to ${K24_SESSION_PATH} (${stats.size} bytes)`);
      console.log('🎉 Full phone numbers will now be unmasked automatically during scraping!\n');
    } else {
      console.error('❌ Failed to create session file.');
    }
  } catch (err: unknown) {
    console.error('❌ Error during Khmer24 login:', err instanceof Error ? err.message : String(err));
  } finally {
    await context.close().catch(() => {});
    await camoufox.close().catch(() => {});
  }
}

if (require.main === module) {
  runK24Login()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('💥 Fatal:', err);
      process.exit(1);
    });
}

