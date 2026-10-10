import fs from 'node:fs';
import path from 'node:path';
import { launchCamoufox, type CamoufoxBrowser } from './camoufox-server';
import { classifyKhmer24PageLiveness, isKhmer24ChallengePage } from './khmer24-http';
import { attachTrafficGuard } from './traffic-guard';

export interface Khmer24BrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

export interface Khmer24BrowserContext {
  newPage(): Promise<Khmer24BrowserPage>;
  close(): Promise<void>;
}

export interface Khmer24Browser {
  newContext(options?: { storageState?: string }): Promise<Khmer24BrowserContext>;
}

export interface Khmer24CamoufoxHandle {
  browser: Khmer24Browser;
  close(): Promise<void>;
}

export interface Khmer24PageTransport {
  fetchHtml(url: string): Promise<string>;
  fetchPage?(url: string): Promise<Khmer24TransportPage>;
  close(): Promise<void>;
}

export interface Khmer24TransportPage {
  html: string;
  navigationStatus: number | null;
  finalUrl: string;
  title: string;
  htmlBytes: number;
  elapsedMs: number;
  markers: {
    listing: boolean;
    removedOrNotFound: boolean;
    challengeOrBlock: boolean;
    unexpected: boolean;
  };
}

export interface Khmer24CamoufoxTransportDependencies {
  launch?: (options: { headless: boolean; devicePath: string }) => Promise<Khmer24CamoufoxHandle>;
  attachGuard?: (page: Khmer24BrowserPage) => Promise<void>;
  fileExists?: (filePath: string) => boolean;
  cwd?: () => string;
}

const NAVIGATION_TIMEOUT_MS = 45_000;

/**
 * A direct, page-only Khmer24 transport for reviewed canonical URLs. It has no
 * discovery, proxy, persistence, AI, or Node-fetch preflight path.
 */
export class Khmer24CamoufoxTransport implements Khmer24PageTransport {
  private constructor(
    private readonly handle: Khmer24CamoufoxHandle,
    private readonly sessionPath: string | undefined,
    private readonly attachGuard: (page: Khmer24BrowserPage) => Promise<void>,
  ) {}

  static async open(dependencies: Khmer24CamoufoxTransportDependencies = {}): Promise<Khmer24CamoufoxTransport> {
    const cwd = dependencies.cwd ?? process.cwd;
    const basePath = cwd();
    const devicePath = path.join(basePath, 'data', 'k24_device.json');
    const sessionPath = path.join(basePath, 'data', 'k24_session.json');
    const fileExists = dependencies.fileExists ?? fs.existsSync;
    // Do not let a recheck create or rotate a browser identity. The pinned
    // identity is an explicit prerequisite for this transport.
    if (!fileExists(devicePath)) throw new Error(`Khmer24 pinned device is missing: ${devicePath}`);
    const launch = dependencies.launch ?? (async (options: { headless: boolean; devicePath: string }): Promise<Khmer24CamoufoxHandle> => {
      return launchCamoufox(options) as unknown as Promise<CamoufoxBrowser>;
    });
    const handle = await launch({ headless: true, devicePath });
    return new Khmer24CamoufoxTransport(
      handle,
      fileExists(sessionPath) ? sessionPath : undefined,
      dependencies.attachGuard ?? (async (page) => attachTrafficGuard(page as never)),
    );
  }

  async fetchHtml(url: string): Promise<string> {
    return (await this.fetchPage(url)).html;
  }

  async fetchPage(url: string): Promise<Khmer24TransportPage> {
    const started = Date.now();
    const context = await this.handle.browser.newContext(this.sessionPath ? { storageState: this.sessionPath } : undefined);
    let page: Khmer24BrowserPage | undefined;
    try {
      page = await context.newPage();
      // This must remain before page.goto: Khmer24 pages carry media and
      // telemetry that are irrelevant to liveness classification.
      await this.attachGuard(page);
      const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      const html = await page.content();
      const title = await page.title();
      const liveness = classifyKhmer24PageLiveness(html);
      const challengeOrBlock = isKhmer24ChallengePage(html, title);
      const listing = /"@type"\s*:\s*"Product"/.test(html.slice(0, 200_000));
      return {
        html,
        navigationStatus: navigation?.status() ?? null,
        finalUrl: page.url(),
        title,
        htmlBytes: Buffer.byteLength(html),
        elapsedMs: Date.now() - started,
        markers: {
          listing,
          removedOrNotFound: liveness === 'dead',
          challengeOrBlock,
          unexpected: !listing && liveness !== 'dead' && !challengeOrBlock,
        },
      };
    } finally {
      if (page) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
