import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessBackupMonitor, BACKUP_ALERT_REPEAT_MS,
} from '../src/database/backup-monitor';
import {
  notifyBackupTelegramAdmins, parseTelegramAdminIds, sendTelegramBackupAlert,
} from '../src/database/backup-telegram';

const fresh = { healthy: true, filename: 'homeasy_backup_2026-10-15_010000_test.db', ageMs: 60_000 };
const worker = { running: true, status: 'running', health: 'healthy' };

describe('Host Telegram backup alerting (offline)', () => {
  it('validates and deduplicates admin IDs', () => {
    expect(parseTelegramAdminIds('123, 456,123')).toEqual([123, 456]);
    for (const invalid of [undefined, '', ',123', 'abc', '-1', '0', '9007199254740992']) {
      expect(() => parseTelegramAdminIds(invalid)).toThrow();
    }
  });

  it('requires Telegram API acknowledgement and posts a text-only alert', async () => {
    const fakeFetch = jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await sendTelegramBackupAlert('dummy_token', 123, 'Title', 'Message',
      fakeFetch as typeof fetch)).toBe(true);
    const [url, options] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botdummy_token/sendMessage');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({
      chat_id: 123, text: 'Title\nMessage', disable_notification: false,
    });
    const rejected = jest.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
    expect(await sendTelegramBackupAlert('dummy', 123, 'a', 'b', rejected as typeof fetch)).toBe(false);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const errorFetch = jest.fn(async () => { throw new Error('secret-test-token'); });
      expect(await sendTelegramBackupAlert('secret-test-token', 123, 'a', 'b',
        errorFetch as typeof fetch)).toBe(false);
      expect(log.mock.calls.flat().join(' ')).not.toContain('secret-test-token');
      const httpFail = jest.fn(async () => new Response('', { status: 403 }));
      expect(await sendTelegramBackupAlert('dummy', 123, 'a', 'b', httpFail as typeof fetch)).toBe(false);
    } finally { log.mockRestore(); }
  });

  it('tracks admins independently through failure/retry, escalation, repeat and recovery', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-telegram-monitor-'));
    const seen: Array<{ id: number; title: string; message: string }> = [];
    let failSecond = true;
    const send = async (_token: string, id: number, title: string, message: string): Promise<boolean> => {
      seen.push({ id, title, message });
      if (id === 456 && failSecond) return false;
      return true;
    };
    const healthy = assessBackupMonitor(worker, fresh, fresh);
    const critical = assessBackupMonitor(null, fresh, fresh);
    const warning = assessBackupMonitor(worker, fresh, { healthy: false, ageMs: 19 * 3600_000 });
    const run = (result: typeof healthy, at: number) => notifyBackupTelegramAdmins(
      result, dataDir, at, 'dummy_token', [123, 456], send,
    );
    try {
      expect(await run(healthy, 1_000)).toBe(true);
      expect(seen).toHaveLength(0);
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try { expect(await run(warning, 2_000)).toBe(false); } finally { log.mockRestore(); }
      expect(seen.map((n) => n.id)).toEqual([123, 456]);
      expect(seen[0].message).toContain('Worker: running/healthy');
      expect(fs.existsSync(path.join(dataDir, '.backup-monitor-telegram-123.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, '.backup-monitor-telegram-456.json'))).toBe(false);
      failSecond = false;
      expect(await run(warning, 3_000)).toBe(true);
      expect(seen.map((n) => n.id)).toEqual([123, 456, 456]);
      expect(await run(warning, 4_000)).toBe(true);
      expect(seen).toHaveLength(3);
      expect(await run(critical, 5_000)).toBe(true);
      expect(seen).toHaveLength(5);
      expect(await run(critical, 5_001)).toBe(true);
      expect(seen).toHaveLength(5);
      expect(await run(critical, 5_000 + BACKUP_ALERT_REPEAT_MS)).toBe(true);
      expect(seen).toHaveLength(7);
      expect(await run(healthy, 5_001 + BACKUP_ALERT_REPEAT_MS)).toBe(true);
      expect(seen).toHaveLength(9);
      expect(seen.at(-1)?.title).toContain('восстановлены');
      expect(await run(healthy, 5_002 + BACKUP_ALERT_REPEAT_MS)).toBe(true);
      expect(seen).toHaveLength(9);
      for (const id of [123, 456]) {
        const marker = path.join(dataDir, `.backup-monitor-telegram-${id}.json`);
        expect(JSON.parse(fs.readFileSync(marker, 'utf8')).status).toBe('ok');
        if (process.platform !== 'win32') expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
