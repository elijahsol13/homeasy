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

function askQuestion(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function waitForEnterOrTimeout(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const timer = setTimeout(() => {
      rl.close();
      resolve();
    }, timeoutMs);

    rl.question('\n👉 When you have finished logging in, press [ENTER] here to save session (or wait 120s)...\n', () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

export async function runFbLogin(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔑 Facebook Login & Session Saver — HomEasy');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📁 Session file destination: ${FB_SESSION_PATH}\n`);

  const dataDir = path.dirname(FB_SESSION_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const useTunnel = process.argv.includes('--tunnel') || process.env.USE_TUNNEL === 'true';
  const customProxy = process.env.PROXY;
  const proxyServer = customProxy || (useTunnel ? 'socks5://127.0.0.1:1080' : undefined);

  const isHeadless =
    process.argv.includes('--headless') ||
    process.env.HEADLESS === 'true' ||
    (!process.env.DISPLAY && process.platform === 'linux');

  if (proxyServer) {
    console.log(`🌐 Routing browser traffic through German VPS proxy: ${proxyServer}`);
  }

  if (isHeadless) {
    console.log('🖥️  Running in HEADLESS terminal mode (directly on server)...');
  } else {
    console.log('🖥️  Running in VISUAL browser mode...');
  }

  const browser = await chromium.launch({
    headless: isHeadless,
    proxy: proxyServer ? { server: proxyServer } : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
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
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    // Click "Allow all cookies" or dismiss if cookie banner is shown
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


    if (isHeadless) {
      console.log('\n📝 Please enter your Facebook credentials to log in via terminal:');
      const email = await askQuestion('👤 Facebook Email or Phone: ');
      const pass = await askQuestion('🔑 Facebook Password: ');

      if (!email || !pass) {
        console.error('❌ Email and password cannot be empty.');
        return;
      }

      console.log('⏳ Submitting login form...');
      await page.fill('input[name="email"], #email', email);
      await page.fill('input[name="pass"], #pass', pass);
      await page.click('button[name="login"], button[type="submit"], #loginbutton');

      await page.waitForTimeout(6000);

      const currentUrl = page.url();
      const pageHtml = (await page.content()).toLowerCase();

      const is2FA =
        currentUrl.includes('checkpoint') ||
        pageHtml.includes('two-factor') ||
        pageHtml.includes('security code') ||
        pageHtml.includes('authenticator') ||
        (await page.locator('input[name="approvals_code"], input[type="text"][name*="code"]').count()) > 0;

      if (is2FA) {
        console.log('\n🔐 Two-Factor Authentication (2FA) is required on your account!');
        const code = await askQuestion('📲 Enter 6-digit 2FA / SMS confirmation code: ');

        const codeInput = page.locator('input[name="approvals_code"], input[type="text"][name*="code"]').first();
        if ((await codeInput.count()) > 0) {
          await codeInput.fill(code);
          const submitBtn = page.locator('button[id*="checkpoint"], button[type="submit"]').first();
          if ((await submitBtn.count()) > 0) {
            await submitBtn.click();
            await page.waitForTimeout(5000);
          }
        }
      }

      try {
        const saveBrowserBtn = page
          .locator('button:has-text("Continue"), button:has-text("Продолжить"), #checkpointSubmitButton')
          .first();
        if ((await saveBrowserBtn.count()) > 0) {
          await saveBrowserBtn.click().catch(() => {});
          await page.waitForTimeout(3000);
        }
      } catch {}
    } else {
      console.log('\n⏳ Browser window opened! Please log into Facebook in the browser.');
      console.log('   (Enter email, password, and 2FA code if requested)');

      // Wait for user to log in manually (up to 180s or on Enter press)
      await waitForEnterOrTimeout(180000);
    }

    // Verify if login was successful by checking for the 'c_user' cookie
    const cookies = await context.cookies();
    const cUser = cookies.find((c) => c.name === 'c_user');

    if (cUser) {
      console.log(`\n🎉 Logged-in Facebook user detected! (c_user: ${cUser.value})`);
    } else {
      console.warn('\n⚠️  WARNING: "c_user" cookie not found in session!');
      console.warn('   It seems login was not completed. Facebook will reject unauthenticated sessions.');
    }

    // Save storage state (cookies + localStorage)
    console.log('💾 Saving session state...');
    await context.storageState({ path: FB_SESSION_PATH });

    if (fs.existsSync(FB_SESSION_PATH)) {
      const stats = fs.statSync(FB_SESSION_PATH);
      console.log(`✅ Session saved successfully to ${FB_SESSION_PATH} (${stats.size} bytes)`);
      if (cUser) {
        console.log('🎉 You can now run the Facebook scraper with: npm run scrape:fb\n');
      } else {
        console.log('👉 Please re-run "npm run fb:login", finish logging in, and press ENTER.\n');
      }
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

