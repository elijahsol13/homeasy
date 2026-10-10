import { createContainer } from '../src/container';
import { CanonicalKhmer24DiscoveryRunner } from '../src/modules/parser/canonical-khmer24-discovery';

function numberOption(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : Number(value);
}

async function main(): Promise<void> {
  const maxItems = numberOption('max-items', 0);
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 10) throw new Error('--max-items must be an integer from 0 through 10');
  if (maxItems === 0) {
    console.log(JSON.stringify({ mode: 'DISABLED', maxItems, reason: 'Explicit bounded cap is required before Camoufox discovery can start.' }, null, 2));
    return;
  }
  const container = createContainer();
  try {
    const report = await new CanonicalKhmer24DiscoveryRunner(container.db, container.ingestionService).run({ maxItems });
    console.log(JSON.stringify(report, null, 2));
  } finally { container.db.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
