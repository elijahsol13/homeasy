import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { IngestionBatchResult } from '../../parser/ingestion-contracts';
import type { AlertService } from '../../../services/alert.service';

type IngestionSource = 'facebook' | 'khmer24';
const alertCooldownMs = 30 * 60 * 1000;
const lastAlertBySource = new WeakMap<AlertService, Partial<Record<IngestionSource, number>>>();

export function constantTimeBearer(header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = crypto.createHash('sha256').update(header.slice(7)).digest();
  const expected = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

/** Logs operational counters only. Raw listings and error messages stay out of API logs. */
export function logIngestionBatch(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  source: IngestionSource,
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

/** Alert once per source per incident window. A successful batch re-arms the next failure. */
export async function notifyIngestionFailure(
  logger: Pick<FastifyBaseLogger, 'warn'>,
  alertService: AlertService,
  source: IngestionSource,
  result?: IngestionBatchResult,
): Promise<void> {
  const alerted = lastAlertBySource.get(alertService) ?? {};
  if (result && result.errors.length === 0) {
    delete alerted[source];
    return;
  }

  const now = Date.now();
  if (alerted[source] !== undefined && now - alerted[source] < alertCooldownMs) return;
  alerted[source] = now;
  lastAlertBySource.set(alertService, alerted);
  const label = source === 'facebook' ? 'Facebook' : 'Khmer24';
  // Only trusted numbers and static labels enter Telegram HTML, never source text or errors.
  const message = result
    ? `<b>${label} import failed</b>\n` +
      `Run: ${result.runId ?? 'unknown'}\n` +
      `Received: ${result.inputItems}, failed: ${result.errors.length}.\n` +
      'Source batch needs retry.'
    : `<b>${label} import failed</b>\nUnexpected ingestion error. Source batch needs retry.`;
  try {
    await alertService.warn(message);
  } catch {
    delete alerted[source];
    logger.warn({ event: 'ingestion_alert_delivery_failed', source }, 'Ingestion alert failed');
  }
}
