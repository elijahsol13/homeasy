import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createDatabase, closeDatabase } from '../src/database/db';
import { env } from '../src/config/env';
import { createContainer } from '../src/container';
import { assessLegacyKhmer24Row, LegacyKhmer24BackfillAdapter, type LegacyPropertyRow } from '../src/modules/parser/legacy-khmer24-backfill-adapter';

function parseMode(args: string[]): boolean {
  if (args.length !== 1 || !['--dry-run', '--commit'].includes(args[0]!)) {
    throw new Error('Pass exactly one mode: --dry-run or --commit');
  }
  return args[0] === '--dry-run';
}

async function main(): Promise<void> {
  const dryRun = parseMode(process.argv.slice(2));
  const db = dryRun ? new DatabaseSync(path.resolve(env.DATABASE_PATH), { readOnly: true }) : createDatabase();
  try {
    const legacyRows = db.prepare('SELECT * FROM properties ORDER BY id').all() as unknown as LegacyPropertyRow[];
    const assessments = legacyRows.map((row) => ({ row, result: assessLegacyKhmer24Row(row) }));
    const recognized = assessments.filter((entry) => entry.result.recognized);
    const distinctIds = new Set(recognized.map((entry) => entry.result.externalId));
    const duplicateRows = recognized.length - distinctIds.size;
    const skipped: Record<string, number> = {};
    for (const { result } of assessments) {
      const reason = result.recognized ? 'duplicate_stable_ad_id' : result.reason ?? 'unknown';
      if (!result.recognized) skipped[reason] = (skipped[reason] ?? 0) + 1;
    }
    skipped.duplicate_stable_ad_id = duplicateRows;

    const container = createContainer({ db });
    const ingestion = await container.ingestionService.ingestBatch(
      new LegacyKhmer24BackfillAdapter(db),
      { runType: 'MANUAL_IMPORT', ingestionMethod: 'MANUAL', dryRun, parserVersion: 'legacy-khmer24-backfill-v1' },
    );
    console.log(JSON.stringify({
      mode: dryRun ? 'dry-run' : 'commit',
      legacyRowsInspected: legacyRows.length,
      khmer24RowsRecognized: recognized.length,
      stableKhmer24Ads: distinctIds.size,
      duplicateLegacyRowsCoalesced: duplicateRows,
      skipped,
      ingestion: {
        inputItems: ingestion.inputItems,
        processedItems: ingestion.processedItems,
        newSources: ingestion.newSources,
        newSourceItems: ingestion.newSourceItems,
        updatedSourceItems: ingestion.updatedSourceItems,
        unchangedSourceItems: ingestion.unchangedSourceItems,
        newVersions: ingestion.newVersions,
        newIdentifiers: Object.values(ingestion.identifierCounts).reduce((a, b) => a + b, 0),
        identifierCounts: ingestion.identifierCounts,
        errors: ingestion.errors,
      },
    }, null, 2));
  } finally { closeDatabase(db); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
