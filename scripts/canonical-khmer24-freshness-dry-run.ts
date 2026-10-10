import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CityKey } from '../src/config/settings';
import { CanonicalKhmer24FreshnessPlanner } from '../src/modules/parser/canonical-khmer24-freshness';

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function main(): void {
  const databasePath = path.resolve(process.env.DATABASE_PATH ?? './data/homeasy.db');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const migration = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((migration.version ?? 0) < 51) throw new Error('Phase 6B canonical planning requires migration 51');
    const city = process.env.FRESHNESS_CITY ?? 'siem_reap';
    if (city !== 'siem_reap' && city !== 'phnom_penh') throw new Error('FRESHNESS_CITY must be siem_reap or phnom_penh');
    const planner = new CanonicalKhmer24FreshnessPlanner(db, {
      city: city as CityKey,
      staleAfterDays: numberEnv('FRESHNESS_STALE_AFTER_DAYS', 7),
      topNPerSavedFilter: numberEnv('FRESHNESS_TOP_N_PER_SAVED_FILTER', 5),
    });
    console.log(JSON.stringify(planner.plan(), null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
