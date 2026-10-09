import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, closeDatabase } from '../src/database/db';
import { env } from '../src/config/env';
import { RepostClusteringService, type RepostClusterConfig } from '../src/modules/parser/repost-clustering';

function parseArgs(args: string[]): { algorithm: string; dryRun: boolean; rebuild: boolean; config: Partial<RepostClusterConfig> } {
  let algorithm = 'repost-v1';
  let dryRun = false;
  let commit = false;
  let rebuild = false;
  const config: Partial<RepostClusterConfig> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--algorithm') algorithm = args[++i] ?? '';
    else if (arg === '--property-code-threshold') config.propertyCodeTextSimilarity = Number(args[++i]);
    else if (arg === '--identity-text-threshold') config.contactAuthorTextSimilarity = Number(args[++i]);
    else if (arg === '--multi-id-threshold') config.multipleIdentifierTextSimilarity = Number(args[++i]);
    else if (arg === '--text-only-threshold') config.textOnlySimilarity = Number(args[++i]);
    else if (arg === '--demand-threshold') config.demandTextSimilarity = Number(args[++i]);
    else if (arg === '--demand-window-hours') config.demandWindowHours = Number(args[++i]);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--commit') commit = true;
    else if (arg === '--rebuild') rebuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (dryRun === commit) throw new Error('Pass exactly one of --dry-run or --commit');
  if (!algorithm) throw new Error('--algorithm requires a value');
  if (rebuild && dryRun) throw new Error('--rebuild is only valid with --commit');
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0 || (name.endsWith('Similarity') && value > 1)) {
      throw new Error(`Invalid repost threshold ${name}=${value}`);
    }
  }
  return { algorithm, dryRun, rebuild, config };
}

async function main(): Promise<void> {
  const { algorithm, dryRun, rebuild, config } = parseArgs(process.argv.slice(2));
  const db = dryRun
    ? new DatabaseSync(path.resolve(env.DATABASE_PATH), { readOnly: true })
    : createDatabase();
  try {
    const latest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((latest.version ?? 0) < 38) throw new Error('Apply database migrations through v38 before clustering');
    const service = new RepostClusteringService(db, config);
    const report = service.run(algorithm, { dryRun, rebuild });
    console.log(JSON.stringify({ ...report, rebuildRequested: rebuild }, null, 2));
  } finally {
    closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
