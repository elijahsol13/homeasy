import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../src/config/env';
import { FreshnessScheduler } from '../src/modules/parser/freshness-scheduler';

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function main(): void {
  if (process.env.PAID_FRESHNESS_EXECUTION === 'true') {
    throw new Error('This command is dry-run only; PAID_FRESHNESS_EXECUTION must remain false.');
  }
  const db = new DatabaseSync(path.resolve(env.DATABASE_PATH), { readOnly: true });
  try {
    const latest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((latest.version ?? 0) < 43) throw new Error('Apply database migrations through v43 before freshness planning');
    const scheduler = new FreshnessScheduler(db, {
      monthlyBrightDataRecordBudget: numberEnv('BRIGHTDATA_MONTHLY_RECORD_BUDGET', 0),
      freshnessBudgetPercent: numberEnv('BRIGHTDATA_FRESHNESS_BUDGET_PERCENT', 0),
      reservePercent: numberEnv('BRIGHTDATA_RESERVE_PERCENT', 0),
      staleAfterDays: numberEnv('FRESHNESS_STALE_AFTER_DAYS', 7),
      topNPerRequest: numberEnv('FRESHNESS_TOP_N_PER_REQUEST', 5),
    });
    console.log(JSON.stringify(scheduler.plan(), null, 2));
  } finally { db.close(); }
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
