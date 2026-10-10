import * as dotenv from 'dotenv';

function numberOption(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : Number(value);
}

async function main(): Promise<void> {
  dotenv.config();
  // Set the narrow config profile before importing the application graph.
  process.env.HOMEASY_CONFIG_PROFILE = 'discovery';
  const maxItems = numberOption('max-items', 0);
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 10) throw new Error('--max-items must be an integer from 0 through 10');
  if (maxItems === 0) {
    console.log(JSON.stringify({ mode: 'DISABLED', maxItems, reason: 'Explicit bounded cap is required before Camoufox discovery can start.' }, null, 2));
    return;
  }
  const [{ createContainer }, { CanonicalKhmer24DiscoveryRunner }] = await Promise.all([
    import('../src/container'),
    import('../src/modules/parser/canonical-khmer24-discovery'),
  ]);
  const container = createContainer();
  try {
    const report = await new CanonicalKhmer24DiscoveryRunner(container.db, container.ingestionService).run({ maxItems });
    console.log(JSON.stringify(report, null, 2));
  } finally { container.db.close(); }
}

main().catch((error) => {
  if (error && typeof error === 'object' && 'report' in error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), mutationReport: error.report }, null, 2));
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
