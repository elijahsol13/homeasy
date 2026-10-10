import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalKhmer24FreshnessExecutor, CanonicalKhmer24FreshnessPlanner } from '../src/modules/parser/canonical-khmer24-freshness';

function numberOption(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : Number(value);
}

async function main(): Promise<void> {
  const maxItems = numberOption('max-items', 0);
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 10) throw new Error('--max-items must be an integer from 0 through 10');
  const databasePath = path.resolve(process.env.DATABASE_PATH ?? 'data/homeasy.db');
  const db = new DatabaseSync(databasePath, { readOnly: maxItems === 0 });
  try {
    const plan = new CanonicalKhmer24FreshnessPlanner(db).plan();
    if (maxItems === 0) {
      console.log(JSON.stringify({ mode: 'DISABLED', maxItems, wouldCheck: plan.wouldCheck, proposed: plan.proposed }, null, 2));
      return;
    }
    const selected = plan.proposed.slice(0, maxItems);
    const execution = await new CanonicalKhmer24FreshnessExecutor(db).execute(selected, { maxItems: selected.length });
    console.log(JSON.stringify({ mode: 'EXPLICIT_BOUNDED_EXECUTION', maxItems, selected, execution }, null, 2));
  } finally { db.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
