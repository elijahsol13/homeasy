/** Manually retry Khmer24 batches from the Mac; no browser, SQLite or AI here. */
import 'dotenv/config';
import { flushKhmer24Outbox } from '../src/modules/parser/khmer24-outbox';

async function main(): Promise<void> {
  if (process.env.HOMEASY_DEPLOYMENT_ROLE === 'vps') {
    throw new Error('Khmer24 outbox delivery must run from the Mac');
  }
  const result = await flushKhmer24Outbox();
  console.log(`Khmer24 queue delivered: ${result.newSourceItems} new, ${result.updatedSourceItems} updated, ${result.unchangedSourceItems} unchanged`);
}

void main().catch((error: unknown) => {
  console.error('Khmer24 queue replay failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
