/**
 * Host-side watchdog for the independent Docker SQLite backup worker.
 * Read-only by default. Optional --notify uses macOS notifications;
 * --telegram sends alerts to admins from outside Docker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  BACKUP_HEALTH_MAX_AGE_MS, inspectRecentBackup, localBackupDir,
} from './backup-worker';

export const BACKUP_EARLY_WARNING_MS = 18 * 60 * 60 * 1000;
export const BACKUP_ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

export type MonitorStatus = 'ok' | 'warning' | 'critical';
type BackupInspection = ReturnType<typeof inspectRecentBackup>;

export interface WorkerInspection {
  running: boolean;
  status: string;
  health?: string;
}

export interface BackupMonitorResult {
  status: MonitorStatus;
  reason: string;
  workerStatus: string;
  filename?: string;
  ageHours?: number;
}

export interface NotificationState {
  status: MonitorStatus;
  notifiedAtMs: number;
}

export type BackupNotificationOutcome = 'skipped' | 'delivered' | 'failed';

function notificationMessage(result: BackupMonitorResult): { title: string; message: string } {
  return {
    title: result.status === 'ok' ? 'Homeasy: бэкапы восстановлены' : 'Homeasy: проблема с бэкапами',
    message: result.status === 'ok' ? 'Резервные копии снова создаются.'
      : `${result.reason}. Проверь Docker и резервные копии.`,
  };
}

export function assessBackupMonitor(
  worker: WorkerInspection | null,
  within24h: BackupInspection,
  within18h: BackupInspection,
): BackupMonitorResult {
  const data = {
    workerStatus: worker ? `${worker.status}/${worker.health ?? 'no-healthcheck'}` : 'unavailable',
    filename: within24h.filename,
    ageHours: within24h.ageMs === undefined ? undefined : Math.round(within24h.ageMs / 3_600_000 * 10) / 10,
  };
  if (!worker) return { ...data, status: 'critical', reason: 'Docker backup container cannot be inspected' };
  if (!worker.running) return { ...data, status: 'critical', reason: 'Docker backup worker is not running' };
  if (!within24h.healthy) return { ...data, status: 'critical', reason: within24h.reason ?? 'No recent backup' };
  if (worker.health === 'unhealthy') {
    return { ...data, status: 'critical', reason: 'Docker backup healthcheck failed' };
  }
  if (worker.health !== 'healthy') {
    return { ...data, status: 'warning', reason: 'Docker backup healthcheck is not healthy yet' };
  }
  if (!within18h.healthy) return { ...data, status: 'warning', reason: 'Latest backup is older than 18 hours' };
  return { ...data, status: 'ok', reason: 'Backup worker healthy and snapshot is recent' };
}

export function shouldNotifyBackupState(
  status: MonitorStatus, previous: NotificationState | undefined, nowMs: number,
): boolean {
  if (status === 'ok') return previous !== undefined && previous.status !== 'ok';
  if (!previous || previous.status !== status) return true;
  return nowMs - previous.notifiedAtMs >= BACKUP_ALERT_REPEAT_MS;
}

function inspectDockerBackupWorker(): WorkerInspection | null {
  try {
    // LaunchAgents do not inherit the interactive shell PATH. The installer
    // pins the resolved Docker CLI path in HOMEASY_DOCKER_BIN.
    const dockerBin = process.env.HOMEASY_DOCKER_BIN || 'docker';
    const output = execFileSync(dockerBin, [
      'inspect', '--type', 'container', '--format', '{{json .State}}', 'homeasy-backup',
    ], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = JSON.parse(output) as {
      Running?: boolean;
      Status?: string;
      Health?: { Status?: string };
    };
    return { running: state.Running === true, status: state.Status ?? 'unknown',
      health: state.Health?.Status };
  } catch {
    return null;
  }
}

function readNotificationState(filename: string): NotificationState | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8')) as NotificationState;
    if ((data.status === 'ok' || data.status === 'warning' || data.status === 'critical')
      && Number.isFinite(data.notifiedAtMs)) return data;
  } catch { /* no previous notification state */ }
  return undefined;
}

function macNotify(title: string, message: string): boolean {
  if (process.platform !== 'darwin') return false;
  const quote = (value: string): string => `"${value.replace(/[\r\n\t]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const expression = `display notification ${quote(message)} with title ${quote(title)}`;
  const result = spawnSync('/usr/bin/osascript', ['-e', expression], {
    timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    console.error('[Backup monitor] macOS notification failed:', result.error?.message ?? result.stderr?.trim());
  }
  return result.status === 0;
}

/**
 * Shared delivery path for the LaunchAgent and the offline rehearsal.
 * The marker advances only after the transport acknowledges success, so an
 * unsuccessful notification can be retried on the next monitor invocation.
 */
export function deliverBackupMonitorNotification(
  result: BackupMonitorResult,
  marker: string,
  nowMs: number,
  notify: (title: string, message: string) => boolean,
): BackupNotificationOutcome {
  const previous = readNotificationState(marker);
  if (!shouldNotifyBackupState(result.status, previous, nowMs)) return 'skipped';

  const { title, message } = notificationMessage(result);
  if (!notify(title, message)) return 'failed';

  persistNotificationState(marker, result.status, nowMs);
  return 'delivered';
}

/** Async equivalent, used by Telegram. Each admin gets an independent marker. */
export async function deliverBackupMonitorNotificationAsync(
  result: BackupMonitorResult,
  marker: string,
  nowMs: number,
  notify: (title: string, message: string) => Promise<boolean>,
): Promise<BackupNotificationOutcome> {
  const previous = readNotificationState(marker);
  if (!shouldNotifyBackupState(result.status, previous, nowMs)) return 'skipped';
  const { title, message } = notificationMessage(result);
  if (!await notify(title, message)) return 'failed';
  persistNotificationState(marker, result.status, nowMs);
  return 'delivered';
}

function persistNotificationState(marker: string, status: MonitorStatus, nowMs: number): void {
  const pending = `${marker}.${process.pid}.${nowMs}.tmp`;
  try {
    fs.writeFileSync(pending, `${JSON.stringify({ status, notifiedAtMs: nowMs })}\n`, {
      flag: 'wx', mode: 0o600,
    });
    fs.renameSync(pending, marker);
  } finally {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--notify' && arg !== '--json' && arg !== '--telegram')) {
    throw new Error('Usage: node dist/database/backup-monitor.js [--json] [--notify] [--telegram]');
  }
  const notify = args.includes('--notify');
  const telegram = args.includes('--telegram');
  if (telegram) {
    // DATABASE_PATH also comes from .env; load it before locating snapshots.
    (await import('dotenv')).config();
  }
  const now = Date.now();
  const dir = localBackupDir();
  const worker = inspectDockerBackupWorker();
  const inspection24h = inspectRecentBackup(dir, now, BACKUP_HEALTH_MAX_AGE_MS);
  const inspection18h = inspectRecentBackup(dir, now, BACKUP_EARLY_WARNING_MS);
  const result = assessBackupMonitor(worker, inspection24h, inspection18h);

  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if ((!notify && !telegram) || result.status !== 'ok') {
    console.log(`[Backup monitor] ${result.status.toUpperCase()}: ${result.reason}; `
      + `worker=${result.workerStatus}; age=${result.ageHours ?? 'unknown'}h`);
  }

  if (notify) {
    const marker = path.join(path.dirname(dir), '.backup-monitor-state.json');
    const delivery = deliverBackupMonitorNotification(result, marker, now, macNotify);
    if (delivery === 'failed') process.exitCode = 1;
  }
  if (telegram) {
    // Credentials are loaded only for this explicit mode; the independent
    // backup worker itself stays credential-free.
    const { notifyBackupTelegramAdmins, parseTelegramAdminIds } = await import('./backup-telegram');
    const token = process.env.BOT_TOKEN?.trim();
    if (!token) throw new Error('Telegram backup monitor needs BOT_TOKEN');
    const adminIds = parseTelegramAdminIds(process.env.ADMIN_IDS);
    const delivered = await notifyBackupTelegramAdmins(result, path.dirname(dir), now,
      token, adminIds);
    if (!delivered) process.exitCode = 1;
  }
  if (result.status !== 'ok') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('[Backup monitor] Fatal:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
