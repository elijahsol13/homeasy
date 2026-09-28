import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';

export const FB_SESSION_PATH = path.join(process.cwd(), 'data', 'fb_session.json');
export const FB_DEVICE_PATH = path.join(process.cwd(), 'data', 'fb_device.json');
export const FB_SAFETY_STATE_PATH = path.join(process.cwd(), 'data', 'fb_safety_state.json');
export const FB_RUNTIME_LOCK_PATH = path.join(process.cwd(), 'data', 'fb_runtime.lock');

export type FacebookOperation = 'login' | 'scrape';

export interface FacebookSafetyState {
  status: 'ready' | 'blocked';
  reason?: string;
  detectedUrl?: string;
  detectedAt?: string;
  accountId?: string;
}

interface FacebookRuntimeLock {
  pid: number;
  hostname: string;
  operation: FacebookOperation;
  createdAt: string;
}

const BLOCKED_PATH_PARTS = [
  '/login',
  '/checkpoint',
  '/auth_platform',
  '/two_step_verification',
  '/challenge',
  '/recover',
  '/account_recovery',
];

const BLOCKED_TEXT_MARKERS = [
  'confirm your identity',
  'suspicious activity',
  'account has been locked',
  'account is locked',
  'account suspended',
  'security check',
  'enter the code',
  'two-factor authentication',
];

function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(FB_SAFETY_STATE_PATH), { recursive: true });
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDataDir();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export function loadFacebookSafetyState(): FacebookSafetyState {
  if (!fs.existsSync(FB_SAFETY_STATE_PATH)) return { status: 'ready' };
  try {
    const state = JSON.parse(fs.readFileSync(FB_SAFETY_STATE_PATH, 'utf8')) as FacebookSafetyState;
    if (state.status !== 'ready' && state.status !== 'blocked') {
      return { status: 'blocked', reason: 'Invalid Facebook safety state' };
    }
    return state;
  } catch {
    return { status: 'blocked', reason: 'Unreadable Facebook safety state' };
  }
}

export function blockFacebookAutomation(input: {
  reason: string;
  detectedUrl?: string;
  accountId?: string;
}): FacebookSafetyState {
  const state: FacebookSafetyState = {
    status: 'blocked',
    reason: input.reason,
    detectedUrl: input.detectedUrl,
    detectedAt: new Date().toISOString(),
    accountId: input.accountId,
  };
  atomicWriteJson(FB_SAFETY_STATE_PATH, state);
  return state;
}

export function markFacebookReady(accountId: string): FacebookSafetyState {
  const state: FacebookSafetyState = { status: 'ready', accountId };
  atomicWriteJson(FB_SAFETY_STATE_PATH, state);
  return state;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireFacebookRuntimeLock(operation: FacebookOperation): () => void {
  ensureDataDir();
  const lock: FacebookRuntimeLock = {
    pid: process.pid,
    hostname: os.hostname(),
    operation,
    createdAt: new Date().toISOString(),
  };

  try {
    const fd = fs.openSync(FB_RUNTIME_LOCK_PATH, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2), 'utf8');
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    let existing: FacebookRuntimeLock;
    try {
      existing = JSON.parse(fs.readFileSync(FB_RUNTIME_LOCK_PATH, 'utf8')) as FacebookRuntimeLock;
    } catch {
      throw new Error(`Facebook runtime lock is unreadable: ${FB_RUNTIME_LOCK_PATH}`);
    }

    if (existing.hostname !== os.hostname() || !Number.isInteger(existing.pid) || isProcessRunning(existing.pid)) {
      throw new Error(
        `Facebook ${existing.operation ?? 'operation'} is already locked by PID ${existing.pid ?? 'unknown'} on ${existing.hostname ?? 'unknown host'}`,
      );
    }

    fs.unlinkSync(FB_RUNTIME_LOCK_PATH);
    return acquireFacebookRuntimeLock(operation);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const existing = JSON.parse(fs.readFileSync(FB_RUNTIME_LOCK_PATH, 'utf8')) as FacebookRuntimeLock;
      if (existing.pid === process.pid && existing.hostname === os.hostname()) fs.unlinkSync(FB_RUNTIME_LOCK_PATH);
    } catch (error) {
      void error;
    }
  };
}

export function classifyFacebookChallengeUrl(url: string): string | null {
  const normalized = url.toLowerCase();
  const marker = BLOCKED_PATH_PARTS.find((part) => normalized.includes(part));
  return marker ? `Facebook redirected to ${marker}` : null;
}

export async function detectFacebookChallenge(page: Page): Promise<string | null> {
  const urlReason = classifyFacebookChallengeUrl(page.url());
  if (urlReason) return urlReason;

  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const haystack = `${title}\n${bodyText.slice(0, 5000)}`.toLowerCase();
  const marker = BLOCKED_TEXT_MARKERS.find((text) => haystack.includes(text));
  return marker ? `Facebook challenge marker detected: ${marker}` : null;
}

export async function getAuthenticatedFacebookAccountId(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies();
  const cUser = cookies.find((cookie) => cookie.name === 'c_user' && cookie.value);
  const xs = cookies.find((cookie) => cookie.name === 'xs' && cookie.value);
  return cUser && xs ? cUser.value : null;
}
