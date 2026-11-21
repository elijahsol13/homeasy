import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { IngestionBatchResult } from '../../parser/ingestion-contracts';

export function constantTimeBearer(header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = crypto.createHash('sha256').update(header.slice(7)).digest();
  const expected = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

/** Logs operational counters only. Raw listings and error messages stay out of API logs. */
export function logIngestionBatch(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  source: 'facebook' | 'khmer24',
  result: IngestionBatchResult,
  startedAt: number,
): void {
  const failedItems = result.errors.length;
  const event = failedItems ? 'ingestion_batch_failed' : 'ingestion_batch_completed';
  const fields = {
    event,
    source,
    runId: result.runId,
    inputItems: result.inputItems,
    processedItems: result.processedItems,
    successfulItems: result.inputItems - failedItems,
    failedItems,
    newSourceItems: result.newSourceItems,
    updatedSourceItems: result.updatedSourceItems,
    unchangedSourceItems: result.unchangedSourceItems,
    elapsedMs: Date.now() - startedAt,
  };
  if (failedItems) logger.warn(fields, 'Ingestion batch needs retry');
  else logger.info(fields, 'Ingestion batch completed');
}
