import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import {
  buildPhase7AFunnelReport,
  DEFAULT_INTERNAL_TELEGRAM_IDS,
  type FunnelPeriod,
} from '../src/services/phase7a-funnel-report';

function parsePeriod(value: string | undefined): FunnelPeriod {
  if (value === undefined) return '24h';
  if (value === '24h' || value === '3d' || value === '7d') return value;
  throw new Error('--period must be one of: 24h, 3d, 7d');
}

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      period: { type: 'string' },
      'exclude-telegram-id': { type: 'string', multiple: true },
      'include-internal': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const dbPath = values.db ?? process.env.PHASE7A_FUNNEL_DB;
  if (!dbPath) {
    throw new Error('Pass --db <path> or set PHASE7A_FUNNEL_DB to a SQLite copy. This script only opens it read-only.');
  }
  const extraIds = (values['exclude-telegram-id'] ?? []).map((value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid Telegram ID: ${value}`);
    return id;
  });
  const excluded = values['include-internal']
    ? extraIds
    : [...DEFAULT_INTERNAL_TELEGRAM_IDS, ...extraIds];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildPhase7AFunnelReport({
      db,
      period: parsePeriod(values.period),
      excludedTelegramIds: excluded,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`❌ Phase 7A funnel report failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
