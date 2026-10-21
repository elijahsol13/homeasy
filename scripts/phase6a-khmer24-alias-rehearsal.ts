/** Offline rehearsal only: back up a detached snapshot and repair its private copy. */
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyKhmer24AliasRepairs, assessKhmer24Alias } from '../src/database/khmer24-alias-repair';

const sourcePath = process.env.PHASE6A_DB;
const targetPath = process.env.PHASE6A_REPAIR_DB;
if (!sourcePath || !targetPath || !existsSync(sourcePath))
  throw new Error('Set PHASE6A_DB to an existing detached snapshot and PHASE6A_REPAIR_DB to a new copy path');
const source = realpathSync(sourcePath);
const target = resolve(targetPath);
const live = resolve('data/homeasy.db');
const liveReal = existsSync(live) ? realpathSync(live) : live;
if (source === live || source === liveReal || target === live || target === liveReal
  || source === target || existsSync(target))
  throw new Error('Refusing live DB paths, source overwrite or existing destination');
// The destination directory must already exist so a symlinked directory is checked too.
const resolvedTarget = resolve(realpathSync(dirname(target)), target.split('/').pop()!);
if (resolvedTarget === live || resolvedTarget === liveReal || resolvedTarget === source)
  throw new Error('Destination resolves to a protected SQLite path');

const ids = [11, 12, 19, 22, 197, 201] as const;
const protectedTables = ['properties', 'source_items', 'canonical_listings',
  'canonical_listing_moderation', 'canonical_listing_source_occurrences'] as const;

function snapshotDigest(db: DatabaseSync) {
  return Object.fromEntries(protectedTables.map((table) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const digest = createHash('sha256');
    for (const row of rows) digest.update(JSON.stringify(row));
    return [table, { rows: rows.length, sha256: digest.digest('hex') }];
  }));
}

function verify(db: DatabaseSync) {
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (integrity.integrity_check !== 'ok' || foreignKeys.length)
    throw new Error(`SQLite invalid: integrity=${integrity.integrity_check}, foreign_key_violations=${foreignKeys.length}`);
}

async function main(): Promise<void> {
  const original = new DatabaseSync(source, { readOnly: true });
  try {
    original.exec('PRAGMA query_only=ON');
    verify(original);
    const preflight = ids.map((id) => assessKhmer24Alias(original, id));
    if (preflight.some((entry) => entry.status !== 'safe'))
      throw new Error(`Source preflight blocked: ${JSON.stringify(preflight)}`);
    // Node SQLite online backup produces an isolated consistent database file.
    await backup(original, resolvedTarget);
    const copy = new DatabaseSync(resolvedTarget);
    try {
      copy.exec('PRAGMA foreign_keys=ON');
      verify(copy);
      const before = snapshotDigest(copy);
      const aliasCountBefore = (copy.prepare('SELECT COUNT(*) AS n FROM canonical_listing_aliases').get() as { n: number }).n;
      const repaired = applyKhmer24AliasRepairs(copy, ids);
      const repeat = applyKhmer24AliasRepairs(copy, ids);
      verify(copy);
      const after = snapshotDigest(copy);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error('A protected source, listing or moderation table changed during alias repair');
      if (repeat.some((entry) => entry.status !== 'already_mapped'))
        throw new Error('Alias repair was not idempotent');
      const aliasCountAfter = (copy.prepare('SELECT COUNT(*) AS n FROM canonical_listing_aliases').get() as { n: number }).n;
      if (aliasCountAfter !== aliasCountBefore + ids.length)
        throw new Error('Unexpected number of alias rows created');
      const report = {
        source, detachedWritableCopy: resolvedTarget, integrity: 'ok', foreignKeyViolations: 0,
        aliasCountBefore, aliasCountAfter, protectedTables: after, repaired, repeat,
      };
      if (process.env.PHASE6A_REPAIR_REPORT)
        writeFileSync(process.env.PHASE6A_REPAIR_REPORT, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(report, null, 2));
    } finally { copy.close(); }
  } finally { original.close(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
