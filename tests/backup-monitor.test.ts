import {
  assessBackupMonitor, BACKUP_ALERT_REPEAT_MS, BACKUP_EARLY_WARNING_MS,
  deliverBackupMonitorNotification, shouldNotifyBackupState,
} from '../src/database/backup-monitor';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBackupMonitorRehearsal } from '../scripts/backup-monitor-rehearsal';

const running = { running: true, status: 'running', health: 'healthy' };
const fresh = { healthy: true, filename: 'homeasy_backup_2026-10-14_100000_a.db', ageMs: 60_000 };

describe('MacBook backup monitor', () => {
  it('accepts an actively running healthy worker with a fresh snapshot', () => {
    expect(assessBackupMonitor(running, fresh, fresh)).toMatchObject({ status: 'ok' });
  });

  it('detects a stopped or unreachable worker before its snapshot becomes stale', () => {
    expect(assessBackupMonitor({ running: false, status: 'exited' }, fresh, fresh)).toMatchObject({ status: 'critical' });
    expect(assessBackupMonitor(null, fresh, fresh)).toMatchObject({ status: 'critical' });
    expect(assessBackupMonitor({ ...running, health: 'unhealthy' }, fresh, fresh)).toMatchObject({ status: 'critical' });
  });

  it('warns at 18 hours and escalates when 24 hours expire', () => {
    expect(assessBackupMonitor(running, fresh, {
      healthy: false, filename: fresh.filename, ageMs: BACKUP_EARLY_WARNING_MS + 1,
      reason: 'Latest backup is too old',
    })).toMatchObject({ status: 'warning', reason: 'Latest backup is older than 18 hours' });
    expect(assessBackupMonitor(running, { healthy: false, reason: 'Latest backup is too old' },
      { healthy: false, reason: 'Latest backup is too old' })).toMatchObject({ status: 'critical' });
  });

  it('limits repeated notifications, escalates changes and announces recovery once', () => {
    const now = 1_000_000;
    expect(shouldNotifyBackupState('ok', undefined, now)).toBe(false);
    expect(shouldNotifyBackupState('critical', undefined, now)).toBe(true);
    const previous = { status: 'warning' as const, notifiedAtMs: now };
    expect(shouldNotifyBackupState('warning', previous, now + BACKUP_ALERT_REPEAT_MS - 1)).toBe(false);
    expect(shouldNotifyBackupState('warning', previous, now + BACKUP_ALERT_REPEAT_MS)).toBe(true);
    expect(shouldNotifyBackupState('critical', previous, now + 1)).toBe(true);
    expect(shouldNotifyBackupState('ok', previous, now + 1)).toBe(true);
    expect(shouldNotifyBackupState('ok', { status: 'ok', notifiedAtMs: now }, now + 1)).toBe(false);
  });

  it('persists the marker only after successful delivery and retries transport failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-monitor-test-'));
    const marker = path.join(dir, '.backup-monitor-state.json');
    const critical = assessBackupMonitor(null, fresh, fresh);
    const delivered: string[] = [];
    const send = (title: string): boolean => { delivered.push(title); return true; };
    try {
      expect(deliverBackupMonitorNotification(critical, marker, 1000, () => false)).toBe('failed');
      expect(fs.existsSync(marker)).toBe(false);
      expect(deliverBackupMonitorNotification(critical, marker, 1001, send)).toBe('delivered');
      expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ status: 'critical', notifiedAtMs: 1001 });
      expect(deliverBackupMonitorNotification(critical, marker, 1002, send)).toBe('skipped');
      expect(deliverBackupMonitorNotification(critical, marker, 1001 + BACKUP_ALERT_REPEAT_MS, send))
        .toBe('delivered');
      const recovered = assessBackupMonitor(running, fresh, fresh);
      expect(deliverBackupMonitorNotification(recovered, marker, 1002 + BACKUP_ALERT_REPEAT_MS, send))
        .toBe('delivered');
      expect(deliverBackupMonitorNotification(recovered, marker, 1003 + BACKUP_ALERT_REPEAT_MS, send))
        .toBe('skipped');
      expect(JSON.parse(fs.readFileSync(marker, 'utf8')).status).toBe('ok');
      expect(delivered).toHaveLength(3);
      if (process.platform !== 'win32') expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs all offline outage, repeat, failed delivery and recovery transitions', () => {
    const result = runBackupMonitorRehearsal();
    expect(result.pass).toBe(true);
    expect(result.scenarios).toHaveLength(11);
    expect(result.simulatedNotifications).toBe(6);
    expect(result.simulatedFailedNotifications).toBe(1);
    expect(result.scenarios.at(-1)).toMatchObject({ status: 'ok', delivery: 'delivered' });
  });
});
