/**
 * HomEasy In-Chat Telegram Authentication Service
 *
 * Allows administrators to authenticate Facebook (and other platforms) directly
 * inside Telegram chat messages via interactive screenshots and conversational prompts.
 *
 * 🛡️ INVIOLABLE RULES (AGENTS.md):
 * 1. Facebook connections MUST ALWAYS route through residential proxy (FB_PROXY).
 * 2. Aggressive traffic conservation: stylesheets allowed for layout, binary images/media blocked.
 */

import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { env } from '../config/env';
import { parseProxyConfig } from '../modules/parser/proxy';
import { attachTrafficGuard } from '../modules/parser/traffic-guard';
import type { AppContainer } from '../container';

// Ensure stealth plugin is registered
chromium.use(stealthPlugin());

export const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');

export interface ActiveAuthSession {
  adminId: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  waitingForInput?: 'login' | 'password' | '2fa' | null;
  lastActive: number;
  timeoutTimer: NodeJS.Timeout;
}

export interface AuthActionResult {
  screenshot: Buffer;
  isLoggedIn: boolean;
  is2FA: boolean;
  message?: string;
  c_user?: string;
}

export class TelegramAuthService {
  private activeSessions = new Map<number, ActiveAuthSession>();

  constructor(private readonly container?: AppContainer) {}

  /**
   * Checks if an admin already has an active visual session.
   */
  hasSession(adminId: number): boolean {
    return this.activeSessions.has(adminId);
  }

  /**
   * Retrieves the current waiting state (e.g. 'login', 'password', '2fa').
   */
  getWaitingForInput(adminId: number): 'login' | 'password' | '2fa' | null | undefined {
    return this.activeSessions.get(adminId)?.waitingForInput;
  }

  /**
   * Sets the waiting state for text replies from admin.
   */
  setWaitingForInput(adminId: number, waiting: 'login' | 'password' | '2fa' | null): void {
    const session = this.activeSessions.get(adminId);
    if (session) {
      session.waitingForInput = waiting;
      session.lastActive = Date.now();
    }
  }

  /**
   * Starts an interactive browser session for an admin through residential proxy.
   */
  async startSession(adminId: number): Promise<AuthActionResult> {
    // Terminate any existing session for this admin
    await this.closeSession(adminId);

    const proxyResult = parseProxyConfig(env.FB_PROXY);
    if (!proxyResult) {
      throw new Error('FB_PROXY is not configured in .env. Facebook authentication requires a residential proxy.');
    }

    console.log(`🌐 [TelegramAuth] Starting Facebook in-chat session for admin ${adminId} via ${proxyResult.masked}...`);

    const browser = await chromium.launch({
      headless: true,
      proxy: proxyResult.config,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--mute-audio',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 414, height: 750 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Attach traffic guard: allow CSS stylesheets for layout readability, block heavy media/images to conserve bandwidth
    await attachTrafficGuard(page, {
      allowStylesheets: true,
      allowImages: false,
    });

    // Auto-cleanup timer (15 minutes of inactivity)
    const timeoutTimer = setTimeout(() => {
      console.log(`⏱️ [TelegramAuth] Inactivity timeout reached for admin ${adminId}, terminating session...`);
      void this.closeSession(adminId);
    }, 15 * 60 * 1000).unref();

    this.activeSessions.set(adminId, {
      adminId,
      browser,
      context,
      page,
      waitingForInput: null,
      lastActive: Date.now(),
      timeoutTimer,
    });

    // Navigate to Facebook mobile login
    await page.goto('https://m.facebook.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Auto-dismiss cookie consent banner if present
    await this.dismissCookieBanners(page);

    const check = await this.evaluateStatus(page, context);
    const screenshot = await this.takeScreenshot(page);

    return {
      screenshot,
      isLoggedIn: check.isLoggedIn,
      is2FA: check.is2FA,
      message: check.isLoggedIn ? 'Already authenticated!' : 'Ready for login.',
      c_user: check.c_user,
    };
  }

  /**
   * Types username / email into the login input field.
   */
  async enterLogin(adminId: number, loginText: string): Promise<Buffer> {
    const session = this.requireSession(adminId);
    session.waitingForInput = null;
    session.lastActive = Date.now();

    const page = session.page;
    const emailSelector =
      'input[type="text"], input[type="email"], input[name="email"], #m_login_email, #email';

    const input = page.locator(emailSelector).first();
    if ((await input.count()) > 0) {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(loginText.trim());
    } else {
      // Fallback: evaluate document.activeElement or first input
      await page.keyboard.type(loginText.trim());
    }

    return this.takeScreenshot(page);
  }

  /**
   * Types password into the password input field.
   */
  async enterPassword(adminId: number, passText: string): Promise<Buffer> {
    const session = this.requireSession(adminId);
    session.waitingForInput = null;
    session.lastActive = Date.now();

    const page = session.page;
    const passSelector =
      'input[type="password"], input[name="pass"], #m_login_password, #pass';

    const input = page.locator(passSelector).first();
    if ((await input.count()) > 0) {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(passText.trim());
    } else {
      await page.keyboard.type(passText.trim());
    }

    return this.takeScreenshot(page);
  }

  /**
   * Submits the login form and waits for redirect or 2FA checkpoint.
   */
  async submitForm(adminId: number): Promise<AuthActionResult> {
    const session = this.requireSession(adminId);
    session.lastActive = Date.now();
    const { page, context } = session;

    console.log(`🚀 [TelegramAuth] Submitting login form for admin ${adminId}...`);

    const submitSelectors = [
      'button[name="login"]',
      'div[role="button"][data-sigil*="m_login_button"]',
      '[data-sigil="m_login_button"]',
      'button[type="submit"]',
      'input[type="submit"]',
      '#loginbutton',
      'button[value="Log In"]',
      'div[role="button"]:has-text("Log In")',
      'div[role="button"]:has-text("Войти")',
      'div[role="button"]:has-text("Вход")',
      '#checkpointSubmitButton',
      'button[id*="checkpoint"]',
    ];

    let clicked = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Fallback: press Enter on the active input or password field
      await page.locator('input[type="password"], input[name="pass"]').first().press('Enter').catch(() => {});
    }

    // Wait for navigation / response
    await page.waitForTimeout(5000);
    await this.dismissCookieBanners(page);

    const status = await this.evaluateStatus(page, context);

    if (status.isLoggedIn) {
      await this.saveSessionState(context, adminId);
    }

    const screenshot = await this.takeScreenshot(page);

    return {
      screenshot,
      isLoggedIn: status.isLoggedIn,
      is2FA: status.is2FA,
      message: status.isLoggedIn
        ? '🎉 Login successful! Session saved to server.'
        : status.is2FA
          ? '🔐 2FA Checkpoint detected! Please enter your 6-digit confirmation code.'
          : 'Form submitted. Review updated screen below.',
      c_user: status.c_user,
    };
  }

  /**
   * Submits 2FA / SMS / Authenticator code.
   */
  async enter2FACode(adminId: number, code: string): Promise<AuthActionResult> {
    const session = this.requireSession(adminId);
    session.waitingForInput = null;
    session.lastActive = Date.now();
    const { page, context } = session;

    console.log(`📲 [TelegramAuth] Submitting 2FA code for admin ${adminId}...`);

    const cleanCode = code.replace(/\D/g, '').trim();

    const codeSelectors = [
      'input[name="approvals_code"]',
      'input[id*="approvals_code"]',
      'input[autocomplete="one-time-code"]',
      'input[type="text"][name*="code"]',
      'input[type="number"][name*="code"]',
      'input[type="text"]',
    ];

    let filled = false;
    for (const sel of codeSelectors) {
      const input = page.locator(sel).first();
      if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
        await input.fill(cleanCode);
        filled = true;
        break;
      }
    }

    if (!filled) {
      await page.keyboard.type(cleanCode);
    }

    // Click submit button for 2FA
    const submitBtnSelectors = [
      '#checkpointSubmitButton',
      'button[id*="checkpoint"]',
      'button[name="submit[Submit Code]"]',
      'button[type="submit"]',
      'button:has-text("Submit Code")',
      'button:has-text("Continue")',
      'button:has-text("Продолжить")',
      'button:has-text("Отправить код")',
    ];

    for (const sel of submitBtnSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click().catch(() => {});
        break;
      }
    }

    // Wait for Facebook processing
    await page.waitForTimeout(5000);

    // Check for "Save Browser" / "Trust Device" prompt and auto-continue
    try {
      const continueBtn = page
        .locator('button:has-text("Continue"), button:has-text("Продолжить"), #checkpointSubmitButton, button:has-text("Trust")')
        .first();
      if ((await continueBtn.count()) > 0 && (await continueBtn.isVisible().catch(() => false))) {
        await continueBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
    } catch {
      // ignore
    }

    const status = await this.evaluateStatus(page, context);

    if (status.isLoggedIn) {
      await this.saveSessionState(context, adminId);
    }

    const screenshot = await this.takeScreenshot(page);

    return {
      screenshot,
      isLoggedIn: status.isLoggedIn,
      is2FA: status.is2FA,
      message: status.isLoggedIn
        ? '🎉 2FA verified successfully! Session saved.'
        : '2FA code submitted. Check status below.',
      c_user: status.c_user,
    };
  }

  /**
   * Captures a fresh screenshot of the current page.
   */
  async refreshScreenshot(adminId: number): Promise<Buffer> {
    const session = this.requireSession(adminId);
    session.lastActive = Date.now();
    return this.takeScreenshot(session.page);
  }

  /**
   * Saves storage state manually if user sees they are logged in.
   */
  async saveSessionManually(adminId: number): Promise<{ success: boolean; c_user?: string }> {
    const session = this.requireSession(adminId);
    session.lastActive = Date.now();
    return this.saveSessionState(session.context, adminId);
  }

  /**
   * Closes active browser session.
   */
  async closeSession(adminId: number): Promise<void> {
    const session = this.activeSessions.get(adminId);
    if (!session) return;

    clearTimeout(session.timeoutTimer);
    this.activeSessions.delete(adminId);

    try {
      await session.page.close().catch(() => {});
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
      console.log(`🔌 [TelegramAuth] Closed browser session for admin ${adminId}.`);
    } catch (err) {
      console.warn(`[TelegramAuth] Error closing session:`, err);
    }
  }

  /**
   * Imports session JSON from direct file upload or text payload.
   */
  importSessionJson(jsonStr: string): { success: boolean; message: string; c_user?: string } {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (!parsed || typeof parsed !== 'object') {
        return { success: false, message: 'Invalid JSON format.' };
      }

      // Handle standard Playwright storageState or direct cookie array
      let cookies: Array<{ name: string; value: string; domain?: string }> = [];
      if (Array.isArray(parsed.cookies)) {
        cookies = parsed.cookies;
      } else if (Array.isArray(parsed)) {
        cookies = parsed;
      } else {
        return { success: false, message: 'JSON does not contain cookies array.' };
      }

      const cUser = cookies.find((c) => c.name === 'c_user');
      const xs = cookies.find((c) => c.name === 'xs');

      if (!cUser || !xs) {
        return {
          success: false,
          message: 'Missing essential Facebook cookies (c_user or xs not found).',
        };
      }

      const storageState = Array.isArray(parsed.cookies)
        ? parsed
        : { cookies, origins: [] };

      const dataDir = path.dirname(FB_SESSION_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      fs.writeFileSync(FB_SESSION_PATH, JSON.stringify(storageState, null, 2), 'utf8');

      console.log(`✅ [TelegramAuth] Imported valid Facebook session (c_user: ${cUser.value}) to ${FB_SESSION_PATH}`);

      return {
        success: true,
        message: `✅ Facebook session imported successfully! (c_user: ${cUser.value})`,
        c_user: cUser.value,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to parse JSON: ${msg}` };
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private requireSession(adminId: number): ActiveAuthSession {
    const session = this.activeSessions.get(adminId);
    if (!session) {
      throw new Error('No active authorization session found. Start one with /auth_fb_chat.');
    }
    return session;
  }

  private async takeScreenshot(page: Page): Promise<Buffer> {
    return page.screenshot({ type: 'jpeg', quality: 75 });
  }

  private async dismissCookieBanners(page: Page): Promise<void> {
    const cookieSelectors = [
      'button[data-cookiebanner="accept_button"]',
      'button[title*="Allow all"]',
      'button[title*="Accept all"]',
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept all")',
      'button:has-text("Принять все")',
      'button:has-text("Разрешить все cookie")',
      '[aria-label="Allow all cookies"]',
      '[aria-label="Decline optional cookies"]',
    ];

    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
      } catch {
        // continue
      }
    }
  }

  private async evaluateStatus(
    page: Page,
    context: BrowserContext,
  ): Promise<{ isLoggedIn: boolean; is2FA: boolean; c_user?: string }> {
    const cookies = await context.cookies();
    const cUser = cookies.find((c) => c.name === 'c_user');

    if (cUser) {
      return { isLoggedIn: true, is2FA: false, c_user: cUser.value };
    }

    const currentUrl = page.url().toLowerCase();
    const html = (await page.content().catch(() => '')).toLowerCase();

    const is2FA =
      currentUrl.includes('checkpoint') ||
      html.includes('two-factor') ||
      html.includes('security code') ||
      html.includes('authenticator') ||
      html.includes('approvals_code') ||
      (await page.locator('input[name="approvals_code"], input[autocomplete="one-time-code"]').count()) > 0;

    return { isLoggedIn: false, is2FA };
  }

  private async saveSessionState(
    context: BrowserContext,
    adminId: number,
  ): Promise<{ success: boolean; c_user?: string }> {
    const cookies = await context.cookies();
    const cUser = cookies.find((c) => c.name === 'c_user');

    const dataDir = path.dirname(FB_SESSION_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    await context.storageState({ path: FB_SESSION_PATH });

    if (this.container?.notifierService) {
      await this.container.notifierService.notifyAdmins(
        `🎉 <b>Facebook Session Successfully Authenticated!</b>\n\n` +
          `Admin ${adminId} authenticated via in-chat Telegram flow.\n` +
          `Session saved to <code>${path.basename(FB_SESSION_PATH)}</code>\n` +
          (cUser ? `<b>c_user:</b> <code>${cUser.value}</code>\n` : '') +
          `Scraper will continue collecting listings on the next cycle.`,
      ).catch(() => {});
    }

    return { success: true, c_user: cUser?.value };
  }
}
