/**
 * Camoufox browser launcher for the TypeScript pipeline.
 *
 * Architecture: `scripts/camoufox/serve.py` spawns Camoufox as a Playwright
 * websocket server (pythonlib owns launch-time fingerprint options). We connect
 * with the project's own playwright (`firefox.connect`) — both sides run
 * Playwright 1.62, so the wire protocol matches.
 *
 * Hard-won constraints (see AGENTS.md):
 *  - Persistent contexts cannot be served over the websocket — use
 *    `browser.newContext({ storageState })` instead of launchPersistentContext.
 *  - The device identity (fingerprint preset + canvas/audio/font noise seeds)
 *    is pinned server-side in data/fb_device.json by serve.py. Do NOT pass
 *    userAgent/viewport/locale overrides on the client context — overriding
 *    desyncs the spoofed fingerprint.
 *  - Never automate Facebook credential entry; login is a human in a headed
 *    browser window (npm run fb:login).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { firefox, type Browser } from 'playwright';

const CAMOUFOX_PYTHON =
  process.env.CAMOUFOX_PYTHON ?? path.join(process.cwd(), '.venv-camoufox', 'bin', 'python');
const SERVE_SCRIPT = path.join(process.cwd(), 'scripts', 'camoufox', 'serve.py');
const CONNECT_TIMEOUT_MS = 120_000;

export interface CamoufoxBrowser {
  browser: Browser;
  /** Closes the browser and stops the python server process. */
  close: () => Promise<void>;
}

export interface LaunchCamoufoxOptions {
  headless?: boolean;
  /** Raw proxy URL (e.g. http://user:pass@host:port) — parsed by serve.py. */
  proxyUrl?: string;
  /** Device identity file (pinned fingerprint + seeds). Default data/fb_device.json. */
  devicePath?: string;
}

export async function launchCamoufox(options: LaunchCamoufoxOptions = {}): Promise<CamoufoxBrowser> {
  if (!fs.existsSync(CAMOUFOX_PYTHON)) {
    throw new Error(
      `Camoufox python env not found at ${CAMOUFOX_PYTHON}.\n` +
        'Setup: python3 -m venv .venv-camoufox && ' +
        '.venv-camoufox/bin/pip install -r scripts/camoufox/requirements.txt && ' +
        '.venv-camoufox/bin/camoufox fetch',
    );
  }

  const args = [SERVE_SCRIPT];
  if (options.headless) args.push('--headless');
  if (options.proxyUrl) args.push('--proxy', options.proxyUrl);
  if (options.devicePath) args.push('--device', options.devicePath);

  const proc: ChildProcess = spawn(CAMOUFOX_PYTHON, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`Camoufox server produced no ws endpoint within ${CONNECT_TIMEOUT_MS / 1000}s.\n${buf}`)),
      CONNECT_TIMEOUT_MS,
    );
    proc.stdout!.on('data', (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/ws:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`camoufox server exited with code ${code}\n${buf}`));
    });
  });

  console.log(`🦊 Camoufox server up: ${wsEndpoint}`);
  const browser = await firefox.connect(wsEndpoint);

  return {
    browser,
    close: async () => {
      // Closing the last browser makes the Playwright server exit; SIGTERM is
      // the backstop for a wedged shutdown, SIGKILL for a wedged SIGTERM.
      await browser.close().catch(() => {});
      if (proc.exitCode === null) proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}
