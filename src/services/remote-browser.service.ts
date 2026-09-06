import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';
import { env } from '../config/env';
import { parseProxyConfig } from '../modules/parser/proxy';
import type { AppContainer } from '../container';

// Register stealth plugin
chromium.use(stealthPlugin());

export const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');
export const K24_SESSION_PATH = path.join(process.cwd(), 'data', 'k24_session.json');

export interface RemoteSessionInfo {
  token: string;
  adminTelegramId: number;
  service: 'facebook' | 'khmer24';
  createdAt: number;
  expiresAt: number;
}

export interface StreamingSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: unknown) => void): void;
  on(event: 'message', listener: (raw: Buffer | string) => void): void;
}

export class RemoteBrowserService {
  private activeStreams = new Map<string, { browser: Browser; page: Page }>();
  private consumedTokens = new Set<string>();

  constructor(private readonly container: AppContainer) {}

  /**
   * Generates a tamper-proof signed session token valid across container/process boundaries for 15 minutes.
   */
  createSessionToken(adminTelegramId: number, service: 'facebook' | 'khmer24', ttlMs = 15 * 60 * 1000): string {
    const nonce = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const payload = Buffer.from(
      JSON.stringify({ adminTelegramId, service, createdAt: now, expiresAt, nonce }),
    ).toString('base64url');

    const sig = crypto
      .createHmac('sha256', env.BOT_TOKEN || 'homeasy-secret')
      .update(payload)
      .digest('base64url');

    return `${payload}.${sig}`;
  }

  /**
   * Validates if a signed token is authentic, unconsumed, and unexpired across any container.
   */
  verifySessionToken(token: string): RemoteSessionInfo | null {
    if (!token || typeof token !== 'string') return null;
    if (this.consumedTokens.has(token)) return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;

    const expectedSig = crypto
      .createHmac('sha256', env.BOT_TOKEN || 'homeasy-secret')
      .update(payload)
      .digest('base64url');

    if (sig !== expectedSig) return null;

    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        adminTelegramId: number;
        service: 'facebook' | 'khmer24';
        createdAt: number;
        expiresAt: number;
        nonce: string;
      };

      if (typeof data.expiresAt !== 'number' || Date.now() > data.expiresAt) {
        return null;
      }

      return {
        token,
        adminTelegramId: data.adminTelegramId,
        service: data.service,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Invalidates a session token.
   */
  consumeSessionToken(token: string): void {
    this.consumedTokens.add(token);
    setTimeout(() => this.consumedTokens.delete(token), 15 * 60 * 1000).unref();
  }

  /**
   * Launches a Playwright browser instance, starts CDP screencast,
   * and coordinates bidirectional input/output streaming with the web client.
   */
  async handleWebSocketConnection(token: string, socket: StreamingSocket): Promise<void> {
    const sessionInfo = this.verifySessionToken(token);
    if (!sessionInfo) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid or expired session token' }));
      socket.close();
      return;
    }

    const { service, adminTelegramId } = sessionInfo;
    console.log(`🌐 [RemoteBrowser] Starting ${service} interactive session for admin ${adminTelegramId}...`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let cdp: CDPSession | null = null;
    let authCheckTimer: NodeJS.Timeout | null = null;
    let isTerminated = false;

    const cleanup = async () => {
      if (isTerminated) return;
      isTerminated = true;
      if (authCheckTimer) clearInterval(authCheckTimer);
      this.activeStreams.delete(token);
      try {
        if (cdp) await cdp.detach().catch(() => {});
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
      } catch (err) {
        console.warn('[RemoteBrowser] Cleanup warning:', err);
      }
      this.consumeSessionToken(token);
    };

    socket.on('close', () => {
      console.log(`🔌 [RemoteBrowser] WebSocket closed for ${service} session`);
      void cleanup();
    });

    socket.on('error', (err: unknown) => {
      console.error(`[RemoteBrowser] WebSocket error:`, err);
      void cleanup();
    });

    try {
      // 1. Configure proxy if Facebook
      let launchProxy: { server: string; username?: string; password?: string } | undefined;
      if (service === 'facebook') {
        const proxyResult = parseProxyConfig(env.FB_PROXY);
        if (!proxyResult) {
          throw new Error('FB_PROXY is not configured in .env. Facebook login requires residential proxy.');
        }
        launchProxy = proxyResult.config;
      }

      socket.send(JSON.stringify({ type: 'status', text: 'Launching secure browser...' }));

      browser = await chromium.launch({
        headless: true,
        proxy: launchProxy,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
        ],
      });

      const viewport = { width: 1280, height: 800 };
      context = await browser.newContext({
        viewport,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
      });

      page = await context.newPage();
      this.activeStreams.set(token, { browser, page });

      cdp = await context.newCDPSession(page);

      // Start screencast
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });

      cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(JSON.stringify({ type: 'frame', data }));
          try {
            await cdp?.send('Page.screencastFrameAck', { sessionId });
          } catch {
            // ignore
          }
        }
      });

      const initialUrl =
        service === 'facebook'
          ? 'https://www.facebook.com/login'
          : 'https://www.khmer24.com/en/login';

      socket.send(JSON.stringify({ type: 'status', text: `Navigating to ${service}...` }));
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      socket.send(JSON.stringify({ type: 'status', text: 'Ready! Interact on the screen below.' }));

      // Handle user actions from client
      socket.on('message', async (raw: Buffer | string) => {
        if (isTerminated || !page) return;
        try {
          const msg = JSON.parse(raw.toString());
          switch (msg.type) {
            case 'click':
              if (typeof msg.x === 'number' && typeof msg.y === 'number') {
                await page.mouse.click(msg.x, msg.y);
              }
              break;
            case 'type':
              if (typeof msg.text === 'string') {
                await page.keyboard.type(msg.text);
              }
              break;
            case 'press':
              if (typeof msg.key === 'string') {
                await page.keyboard.press(msg.key);
              }
              break;
            case 'scroll':
              if (typeof msg.deltaY === 'number') {
                await page.mouse.wheel(0, msg.deltaY);
              }
              break;
            case 'reload':
              await page.reload().catch(() => {});
              break;
            case 'save_manual':
              await checkAndSaveSession(true);
              break;
          }
        } catch (err) {
          console.error('[RemoteBrowser] Error handling client input:', err);
        }
      });

      // Periodic check for successful login
      const checkAndSaveSession = async (manualTrigger = false): Promise<boolean> => {
        if (isTerminated || !context) return false;

        const cookies = await context.cookies();
        let isLoggedIn = false;

        if (service === 'facebook') {
          const cUser = cookies.find((c) => c.name === 'c_user');
          if (cUser) {
            isLoggedIn = true;
          }
        } else if (service === 'khmer24') {
          // Khmer24 sets user token or session cookies upon login
          const hasK24User = cookies.some((c) => c.name.includes('user') || c.name.includes('session') || c.name.includes('token'));
          const currentUrl = page ? page.url() : '';
          if (hasK24User || (!currentUrl.includes('/login') && manualTrigger)) {
            isLoggedIn = true;
          }
        }

        if (isLoggedIn) {
          console.log(`🎉 [RemoteBrowser] ${service} authenticated session detected!`);
          const targetPath = service === 'facebook' ? FB_SESSION_PATH : K24_SESSION_PATH;
          const dataDir = path.dirname(targetPath);
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }

          await context.storageState({ path: targetPath });

          socket.send(
            JSON.stringify({
              type: 'success',
              message: `✅ ${service.toUpperCase()} session successfully saved to server!`,
            }),
          );

          await this.container.notifierService.notifyAdmins(
            `🎉 <b>${service.toUpperCase()} Session Updated!</b>\n\n` +
              `Администратор успешно вошел через удаленный браузер. Сессия сохранена в <code>${path.basename(targetPath)}</code>.\n` +
              `Скрапер продолжит сбор данных со следующего цикла.`,
          );

          setTimeout(() => {
            void cleanup();
          }, 3000);

          return true;
        } else if (manualTrigger) {
          socket.send(
            JSON.stringify({
              type: 'status',
              text: '⚠️ Сессия пока не обнаружена. Завершите вход в окне.',
            }),
          );
        }

        return false;
      };

      authCheckTimer = setInterval(() => {
        void checkAndSaveSession(false);
      }, 2500);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RemoteBrowser] Session error: ${msg}`);
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: msg }));
      }
      void cleanup();
    }
  }
}
