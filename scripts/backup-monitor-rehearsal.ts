/**
 * Deterministic, offline backup watchdog rehearsal. Uses only synthetic file
 * metadata and a temporary notification marker; never inspects Docker, reads
 * production snapshots, or invokes macOS Notification Center.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessBackupMonitor, BACKUP_EARLY_WARNING_MS, BackupNotificationOutcome,
  deliverBackupMonitorNotification, MonitorStatus, WorkerInspection,
} from '../src/database/backup-monitor';
import { BACKUP_HEALTH_MAX_AGE_MS, inspectRecentBackup } from '../src/database/backup-worker';

type RehearsalEvent = {
  scenario: string;
  status: MonitorStatus;
  delivery: BackupNotificationOutcome;
};

export function runBackupMonitorRehearsal(): {
  pass: true;
  scenarios: RehearsalEvent[];
  simulatedNotifications: number;
  simulatedFailedNotifications: number;
} {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-backup-monitor-'));
  const backupDir = path.join(scratch, 'backups');
  const marker = path.join(scratch, '.backup-monitor-state.json');
  const base = Date.UTC(2026, 9, 14, 12);
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  const running: WorkerInspection = { running: true, status: 'running', health: 'healthy' };
  const stopped: WorkerInspection = { running: false, status: 'exited' };
  const scenarios: RehearsalEvent[] = [];
  let notifications = 0;
  let failedNotifications = 0;

  const publishSyntheticSnapshot = (filename: string, mtimeMs: number): void => {
    // Only the timestamp and nonzero size are examined by the watchdog.
    // This is intentionally not a real SQLite recovery point.
    const file = path.join(backupDir, filename);
    fs.writeFileSync(file, 'offline monitor fixture');
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };

  const step = (
    scenario: string, at: number, worker: WorkerInspection,
    expectedStatus: MonitorStatus, expectedDelivery: BackupNotificationOutcome,
    sendSucceeds = true,
  ): void => {
    const inspected24 = inspectRecentBackup(backupDir, at, BACKUP_HEALTH_MAX_AGE_MS);
    const inspected18 = inspectRecentBackup(backupDir, at, BACKUP_EARLY_WARNING_MS);
    const assessment = assessBackupMonitor(worker, inspected24, inspected18);
    assert.equal(assessment.status, expectedStatus, `${scenario}: health`);
    const delivery = deliverBackupMonitorNotification(assessment, marker, at, () => {
      if (!sendSucceeds) {
        failedNotifications++;
        return false;
      }
      notifications++;
      return true;
    });
    assert.equal(delivery, expectedDelivery, `${scenario}: notification`);
    scenarios.push({ scenario, status: assessment.status, delivery });
  };

  try {
    fs.mkdirSync(backupDir);
    publishSyntheticSnapshot('homeasy_backup_2026-10-14_110000_a1.db', base - hour);
    step('initial healthy state', base, running, 'ok', 'skipped');
    step('18-hour warning threshold crossed', base + 19 * hour, running, 'warning', 'delivered');
    step('warning suppressed before repeat', base + 20 * hour, running, 'warning', 'skipped');
    step('24-hour critical threshold crossed', base + 25 * hour, running, 'critical', 'delivered');
    step('stopped worker still critical without duplicate', base + 26 * hour, stopped, 'critical', 'skipped');
    step('critical repeated after six hours', base + 32 * hour, stopped, 'critical', 'delivered');

    publishSyntheticSnapshot('homeasy_backup_2026-10-15_210000_b2.db', base + 33 * hour);
    step('worker and snapshot recover', base + 33 * hour, running, 'ok', 'delivered');
    step('healthy state remains quiet', base + 33 * hour + minute, running, 'ok', 'skipped');
    step('notification transport fails', base + 33 * hour + 2 * minute, stopped, 'critical', 'failed', false);
    step('failed notification is retried', base + 33 * hour + 3 * minute, stopped, 'critical', 'delivered');
    step('recovery is announced once more', base + 33 * hour + 4 * minute, running, 'ok', 'delivered');

    const finalState = JSON.parse(fs.readFileSync(marker, 'utf8')) as { status: string; notifiedAtMs: number };
    assert.deepEqual(finalState, { status: 'ok', notifiedAtMs: base + 33 * hour + 4 * minute });
    assert.equal(notifications, 6);
    assert.equal(failedNotifications, 1);
    return { pass: true, scenarios, simulatedNotifications: notifications,
      simulatedFailedNotifications: failedNotifications };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  console.log(JSON.stringify(runBackupMonitorRehearsal(), null, 2));
}
