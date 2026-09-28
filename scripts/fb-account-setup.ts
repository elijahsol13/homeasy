#!/usr/bin/env ts-node
/**
 * Facebook Account Setup & Cookie Import (Camoufox)
 *
 * Imports vendor-format cookies into Playwright storageState and opens
 * a headed Camoufox window for session verification / manual login.
 *
 * Vendor format: uid:password:2fa_secret:base64(JSON cookies)
 *
 * Usage:
 *   npx ts-node scripts/fb-account-setup.ts --account acc1 --cookies "uid:pass:2fa:base64..."
 *   npx ts-node scripts/fb-account-setup.ts --account acc1 --verify   # just open browser with saved cookies
 *
 * CRITICAL: Credentials (password, 2FA secret) are saved in meta.json for
 * reference ONLY. They are NEVER used programmatically for login — all
 * credential entry is done by a human in the headed browser window.
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { launchCamoufox } from '../src/modules/parser/camoufox-server';

interface VendorCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
  sameSite?: string;
  [key: string]: unknown;
}

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

function parseVendorString(raw: string): {
  uid: string;
  password: string;
  twoFaSecret: string;
  cookies: VendorCookie[];
} {
  // Format: uid:password:2fa_secret:base64(JSON)
  // The base64 part may contain colons, so we split into max 4 parts
  const firstColon = raw.indexOf(':');
  const secondColon = raw.indexOf(':', firstColon + 1);
  const thirdColon = raw.indexOf(':', secondColon + 1);

  if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
    throw new Error('Invalid vendor format. Expected: uid:password:2fa_secret:base64_cookies');
  }

  const uid = raw.substring(0, firstColon);
  const password = raw.substring(firstColon + 1, secondColon);
  const twoFaSecret = raw.substring(secondColon + 1, thirdColon);
  const base64Part = raw.substring(thirdColon + 1);

  // Try to decode base64 cookies
  let decoded: string;
  try {
    decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
  } catch {
    throw new Error('Failed to decode base64 cookies. Check the input string.');
  }

  let parsed: { cookies: VendorCookie[] };
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(`Failed to parse decoded cookies as JSON. Decoded start: ${decoded.substring(0, 200)}`);
  }

  if (!Array.isArray(parsed.cookies)) {
    throw new Error('Decoded JSON does not contain a "cookies" array.');
  }

  return { uid, password, twoFaSecret, cookies: parsed.cookies };
}

function vendorToPlaywrightState(vendorCookies: VendorCookie[]): {
  cookies: PlaywrightCookie[];
  origins: never[];
} {
  const cookies: PlaywrightCookie[] = vendorCookies
    .filter((c) => c.name && c.value && c.domain)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires || -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: normalizeSameSite(c.sameSite),
    }));

  return { cookies, origins: [] };
}

function normalizeSameSite(ss: string | undefined): 'Strict' | 'Lax' | 'None' {
  if (!ss) return 'None';
  const lower = ss.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'lax') return 'Lax';
  return 'None';
}

function waitForEnter(prompt: string, timeoutMs = 300_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => {
      rl.close();
      resolve();
    }, timeoutMs);

    rl.question(prompt, () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  const accountIdx = args.indexOf('--account');
  const accountName = accountIdx !== -1 ? args[accountIdx + 1] : undefined;
  if (!accountName) {
    console.error('Usage: npx ts-node scripts/fb-account-setup.ts --account <name> [--cookies "..."] [--verify] [--register]');
    process.exit(1);
  }

  const accountDir = path.join(process.cwd(), 'data', 'fb_accounts', accountName);
  const sessionPath = path.join(accountDir, 'fb_session.json');
  const devicePath = path.join(accountDir, 'fb_device.json');
  const metaPath = path.join(accountDir, 'meta.json');

  fs.mkdirSync(accountDir, { recursive: true });

  const cookiesIdx = args.indexOf('--cookies');
  const isVerify = args.includes('--verify');
  const isRegister = args.includes('--register');

  
  if (isRegister) {
    console.log('📝 Initializing empty session for new account registration...');
    fs.writeFileSync(sessionPath, JSON.stringify({ cookies: [], origins: [] }, null, 2));
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ status: 'registering', createdAt: new Date().toISOString() }, null, 2));
    }
  }

  // ── Step 1: Import cookies if provided ──────────────────────────────────────
  if (cookiesIdx !== -1) {
    const rawCookies = args[cookiesIdx + 1];
    if (!rawCookies) {
      console.error('--cookies flag requires a value');
      process.exit(1);
    }

    console.log('🔄 Parsing vendor cookie string...');
    const { uid, password, twoFaSecret, cookies } = parseVendorString(rawCookies);

    console.log(`  UID: ${uid}`);
    console.log(`  Cookies: ${cookies.length} total`);

    // Check for key cookies
    const cUser = cookies.find((c) => c.name === 'c_user');
    const datr = cookies.find((c) => c.name === 'datr');
    const xs = cookies.find((c) => c.name === 'xs');

    console.log(`  c_user: ${cUser ? cUser.value : '❌ MISSING'}`);
    console.log(`  datr:   ${datr ? '✅' : '❌ MISSING'}`);
    console.log(`  xs:     ${xs ? '✅' : '❌ MISSING'}`);

    if (!cUser || !xs) {
      console.warn('⚠️  Missing critical session cookies (c_user or xs). Session may be dead.');
    }

    // Convert to Playwright storageState
    const storageState = vendorToPlaywrightState(cookies);
    fs.writeFileSync(sessionPath, JSON.stringify(storageState, null, 2));
    console.log(`💾 Saved Playwright storageState → ${sessionPath} (${cookies.length} cookies)`);

    // Save meta (password and 2FA for human reference only — NEVER automated)
    const meta = {
      uid,
      password: '*** STORED FOR HUMAN REFERENCE ONLY — see AGENTS.md ***',
      twoFaSecret: '*** STORED FOR HUMAN REFERENCE ONLY ***',
      _raw_password: password,
      _raw_2fa: twoFaSecret,
      importedAt: new Date().toISOString(),
      status: 'imported',
      notes: 'Registered via Singapore. First clean login pending.',
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`📋 Saved account meta → ${metaPath}`);
  }

  // ── Step 2: Open Camoufox and verify ────────────────────────────────────────
  if (!fs.existsSync(sessionPath)) {
    console.error(`❌ No session file at ${sessionPath}. Import cookies first with --cookies.`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`🦊 Opening Camoufox for account: ${accountName}`);
  console.log(`   Device file: ${devicePath}`);
  console.log(`   Session file: ${sessionPath}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Launch Camoufox with per-account device file
  const camoufox = await launchCamoufox({
    headless: false,
    devicePath,
  });

  // Load the imported cookies into a fresh context
  const storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  const context = await camoufox.browser.newContext({ storageState });
  const page = await context.newPage();

  try {
    console.log('🔗 Navigating to https://www.facebook.com/ ...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Check current state
    const cookies = await context.cookies();
    const cUser = cookies.find((c) => c.name === 'c_user');
    const currentUrl = page.url();

    if (cUser && !currentUrl.includes('/login') && !currentUrl.includes('/checkpoint')) {
      console.log(`\n🎉 SESSION ALIVE! Logged in as c_user: ${cUser.value}`);
      console.log('   Facebook News Feed loaded successfully.');
      console.log('\n📋 WARM-UP CHECKLIST:');
      console.log('   1. ✅ Scroll the feed a bit (30-60 seconds)');
      console.log('   2. ✅ Maybe like 1-2 posts');
      console.log('   3. ✅ Check profile settings');
      console.log('   4. ❌ Do NOT join any groups yet — let account rest 24-48h');
    } else if (currentUrl.includes('/checkpoint')) {
      console.log('\n⚠️  CHECKPOINT DETECTED!');
      console.log('   Facebook wants additional verification.');
      console.log('   Please complete the checkpoint in the browser window.');
      console.log('   (Enter 2FA code, verify identity, etc.)');
    } else if (currentUrl.includes('/login')) {
      console.log('\n🔐 SESSION EXPIRED — Login page shown.');
      console.log('   Please log in manually in the browser window.');
      console.log('   (Email → Password → 2FA if prompted)');
    } else {
      console.log(`\n❓ Unexpected state. Current URL: ${currentUrl}`);
      console.log('   Check the browser window and proceed manually.');
    }

    console.log('\n──────────────────────────────────────────────────────────────');
    await waitForEnter('👉 Press [ENTER] when done to save session and close browser...\n');

    // Save refreshed session
    const refreshedCookies = await context.cookies();
    const refreshedCUser = refreshedCookies.find((c) => c.name === 'c_user');

    await context.storageState({ path: sessionPath });
    console.log(`💾 Session saved → ${sessionPath}`);

    // Update meta status
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.status = refreshedCUser ? 'verified' : 'needs_login';
      meta.lastVerifiedAt = new Date().toISOString();
      meta.uid = refreshedCUser?.value || meta.uid;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    if (refreshedCUser) {
      console.log(`✅ Account ${accountName} is READY (c_user: ${refreshedCUser.value})`);
    } else {
      console.log(`⚠️  Account ${accountName} still needs login. Re-run with --verify.`);
    }
  } catch (err: unknown) {
    console.error('❌ Error:', err instanceof Error ? err.message : String(err));
  } finally {
    await context.close().catch(() => {});
    await camoufox.close();
  }
}

main().catch((err) => {
  console.error('💥 Fatal:', err);
  process.exit(1);
});

