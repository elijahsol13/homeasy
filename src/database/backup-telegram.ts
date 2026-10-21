/** Telegram transport for the host-side backup watchdog; no bot process required. */
import path from 'node:path';
import { deliverBackupMonitorNotificationAsync } from './backup-monitor';
import type { BackupMonitorResult } from './backup-monitor';

export type TelegramBackupSender = (
  token: string, chatId: number, title: string, message: string,
) => Promise<boolean>;

export function parseTelegramAdminIds(raw: string | undefined): number[] {
  if (!raw?.trim()) throw new Error('Telegram backup monitor needs ADMIN_IDS');
  const ids = raw.split(',').map((value) => value.trim());
  if (ids.some((value) => !/^\d+$/.test(value)
    || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
    throw new Error('ADMIN_IDS must contain valid positive Telegram user IDs');
  }
  return [...new Set(ids.map(Number))];
}

/** A Telegram API ok=true response is required before persisting delivery. */
export async function sendTelegramBackupAlert(
  token: string, chatId: number, title: string, message: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${title}\n${message}`,
        disable_notification: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[Backup monitor] Telegram delivery rejected (HTTP ${response.status})`);
      return false;
    }
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'ok' in body && body.ok === true;
  } catch {
    // Never log the token or raw fetch error: request URLs contain BOT_TOKEN.
    console.error('[Backup monitor] Telegram delivery failed or timed out');
    return false;
  }
}

/**
 * Each admin has a separate marker; partial failures retry only failed admins.
 * Intended to run periodically from the host, outside the monitored container.
 */
export async function notifyBackupTelegramAdmins(
  result: BackupMonitorResult,
  dataDir: string,
  nowMs: number,
  token: string,
  adminIds: number[],
  send: TelegramBackupSender = sendTelegramBackupAlert,
): Promise<boolean> {
  if (!token.trim() || adminIds.length === 0) throw new Error('Telegram backup monitor not configured');
  const attempts = await Promise.allSettled(adminIds.map(async (chatId) => {
    const marker = path.join(dataDir, `.backup-monitor-telegram-${chatId}.json`);
    const outcome = await deliverBackupMonitorNotificationAsync(result, marker, nowMs,
      (title, message) => send(token, chatId, title, `${message}\n`
        + `Worker: ${result.workerStatus}; snapshot: ${result.filename ?? 'none'}; `
        + `age: ${result.ageHours ?? 'unknown'}h`));
    return outcome !== 'failed';
  }));
  const success = attempts.every((attempt) => attempt.status === 'fulfilled' && attempt.value);
  if (!success) console.error('[Backup monitor] Not all Telegram admin notifications were delivered');
  return success;
}
