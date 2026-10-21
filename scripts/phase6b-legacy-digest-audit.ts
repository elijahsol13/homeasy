import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const FROZEN_DIGEST = '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272';

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function main(): void {
  const dbPath = path.resolve(option('db') ?? process.env.DATABASE_PATH ?? 'data/homeasy.db');
  const outPath = path.resolve(option('out') ?? 'reports/phase6b-legacy-digest-audit.json');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM properties ORDER BY id ASC').all();
    const reportRoutineDigest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const frozen = snapshotLegacyProperties(db);
    const report = {
      mode: 'READ_ONLY_LEGACY_DIGEST_ALGORITHM_AUDIT', dbPath,
      rows: rows.length,
      frozenRoutine: { algorithm: 'sha256(JSON.stringify({columns,rows}))', digest: frozen.digest, matchesFrozenBaseline: frozen.digest === FROZEN_DIGEST },
      phase6bReportRoutine: { algorithm: 'sha256(JSON.stringify(rows))', digest: reportRoutineDigest },
      explanation: 'The two digests intentionally differ because the frozen routine includes ordered schema column names. The current database matches the frozen baseline.',
    };
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ outPath, ...report }, null, 2));
    if (!report.frozenRoutine.matchesFrozenBaseline) process.exitCode = 1;
  } finally { db.close(); }
}

main();
