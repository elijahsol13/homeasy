import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditUnmappedKhmer24Aliases } from '../src/database/khmer24-alias-repair';

const target = process.env.PHASE6A_DB;
if (!target || !existsSync(target)) throw new Error('PHASE6A_DB must specify an existing detached read-only snapshot');
const absolute = resolve(target);
const livePath = resolve('data/homeasy.db');
if (absolute === livePath) throw new Error('Refusing to audit live data/homeasy.db; use a detached snapshot');

const db = new DatabaseSync(absolute, { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON');
  const entries = auditUnmappedKhmer24Aliases(db);
  const counts = Object.fromEntries(['safe', 'blocked', 'already_mapped'].map((status) =>
    [status, entries.filter((entry) => entry.status === status).length]));
  const report = { target: absolute, counts, entries };
  if (process.env.PHASE6A_ALIAS_REPORT) {
    writeFileSync(process.env.PHASE6A_ALIAS_REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
