import fs from 'node:fs';
import path from 'node:path';
import { createDatabase, closeDatabase } from '../src/database/db';
import { createContainer } from '../src/container';
import { ReplayAdapter } from '../src/modules/parser/replay-adapter';
import type { SourceRunContext } from '../src/modules/parser/ingestion-contracts';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../src/config/env';

function parseArgs(args: string[]): { input: string; dryRun: boolean } {
  let input = '';
  let dryRun = false;
  let commit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--input') input = args[++i] ?? '';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--commit') commit = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input) throw new Error('Usage: npm run ingestion:replay -- --input <classified.json> (--dry-run | --commit)');
  if (dryRun === commit) throw new Error('Pass exactly one of --dry-run or --commit');
  return { input: path.resolve(input), dryRun };
}

async function main(): Promise<void> {
  const { input, dryRun } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(input)) throw new Error(`Replay input does not exist: ${input}`);
  const dump = JSON.parse(fs.readFileSync(input, 'utf8')) as {
    runId?: string; totalRaw?: number; classificationCounts?: Record<string, number>; posts?: unknown[];
  };
  const db = dryRun
    ? new DatabaseSync(path.resolve(env.DATABASE_PATH), { readOnly: true })
    : createDatabase();
  try {
    const latestMigration = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((latestMigration.version ?? 0) < 37) throw new Error('Apply database migrations through v37 before replay');
    const container = createContainer({ db });
    const adapter = new ReplayAdapter(input);
    const context: SourceRunContext = {
      runType: 'REPLAY', ingestionMethod: 'REPLAY', dryRun,
      parserVersion: 'unified-ingestion-v1',
    };
    const result = await container.ingestionService.ingestBatch(adapter, context);
    const canonicalCounts = {
      properties: (db.prepare('SELECT COUNT(*) AS count FROM canonical_properties').get() as { count: number }).count,
      listings: (db.prepare('SELECT COUNT(*) AS count FROM canonical_listings').get() as { count: number }).count,
    };
    const report = {
      input: path.relative(process.cwd(), input), sourceRunId: dump.runId ?? null,
      mode: dryRun ? 'DRY_RUN' : 'SHADOW_COMMIT',
      inputItems: result.inputItems,
      inputClassifications: dump.classificationCounts ?? {},
      classifications: result.classificationCounts,
      logicalSourcesCreated: result.newSources,
      newSourceItems: result.newSourceItems,
      updatedSourceItems: result.updatedSourceItems,
      unchangedSourceItems: result.unchangedSourceItems,
      newVersions: result.newVersions,
      identifiersFound: result.identifierCounts,
      providerModelRecords: result.providerCounts,
      errors: result.errors.length,
      skipped: 0,
      classificationDiscrepancies: Object.fromEntries(Object.keys({ ...(dump.classificationCounts ?? {}), ...result.classificationCounts })
        .map((key) => [key, (result.classificationCounts[key] ?? 0) - (dump.classificationCounts?.[key] ?? 0)])
        .filter(([, difference]) => difference !== 0)),
      errorSamples: result.errors.slice(0, 20),
      processingRunId: result.runId ?? null,
      canonicalCounts,
    };
    console.log(JSON.stringify(report, null, 2));
    if (result.errors.length) process.exitCode = 2;
  } finally {
    closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
