import type { DatabaseSync } from 'node:sqlite';
import { CanonicalFreshnessExecutor } from './canonical-freshness-executor';
import type { FreshnessExecutionResult } from './canonical-freshness-executor';
import type { LinkCheckResult } from '../../services/link-verifier.service';

export interface SupervisedProbe {
  jobId: number;
  url: string;
  startedAt: string;
  latencyMs: number;
  receivedBytes: number;
  outcome: LinkCheckResult['outcome'] | null;
  statusCode?: number;
  reason?: string;
  executionStatus: FreshnessExecutionResult['status'];
}

export interface SupervisedReport {
  stopReason: 'completed' | 'idle' | 'unknown' | 'fetch_error' | 'byte_budget' | 'cancelled' | 'execution_error';
  attempts: number;
  receivedBytes: number;
  probes: SupervisedProbe[];
  executions: FreshnessExecutionResult[];
}

export interface SupervisedOptions {
  /** Always an explicit newly staged ID allowlist; an empty list executes nothing. */
  onlyJobIds: readonly number[];
  fetcher: (url: string, signal?: AbortSignal) => Promise<LinkCheckResult>;
  maxChecks: number;
  maxReceivedBytes: number;
  minIntervalMs: number;
  signal?: AbortSignal;
  now?: () => Date;
  monotonicMs?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProbe?: (probe: SupervisedProbe) => void;
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * A single-threaded, opt-in operator fence around already staged free jobs.
 * Byte counts must be supplied by the transport. They measure received body
 * bytes, not total compressed/wire traffic. A per-request transport limit and
 * external network policy remain necessary for any future live execution.
 */
export async function runSupervisedFreshnessBatch(db: DatabaseSync, options: SupervisedOptions): Promise<SupervisedReport> {
  if (!Number.isSafeInteger(options.maxChecks) || options.maxChecks < 1 || options.maxChecks > 3 ||
    !Number.isSafeInteger(options.maxReceivedBytes) || options.maxReceivedBytes < 1 ||
    !Number.isSafeInteger(options.minIntervalMs) || options.minIntervalMs < 0 ||
    options.minIntervalMs > 60_000 || options.onlyJobIds.length > options.maxChecks) {
    throw new Error('Invalid supervised canary bounds (max 3, positive bytes, 0..60000ms pacing)');
  }
  const now = options.now ?? (() => new Date());
  const clock = options.monotonicMs ?? (() => performance.now());
  const wait = options.wait ?? waitWithAbort;
  const report: SupervisedReport = { stopReason: 'completed', attempts: 0, receivedBytes: 0,
    probes: [], executions: [] };
  let lastStart: number | undefined;
  let observed: { url: string; start: number; startedAt: string; result?: LinkCheckResult; error?: string } | null = null;
  const executor = new CanonicalFreshnessExecutor(db, { enabled: true, onlyJobIds: options.onlyJobIds,
    now, fetcher: async (url) => {
      observed = { url, start: clock(), startedAt: now().toISOString() };
      try {
        const result = await options.fetcher(url, options.signal);
        if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead! < 0) {
          throw new Error('Probe did not report valid received byte count');
        }
        observed.result = result;
        return result;
      } catch (error) {
        observed.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } });

  for (let index = 0; index < options.maxChecks; index++) {
    if (options.signal?.aborted) { report.stopReason = 'cancelled'; break; }
    if (report.receivedBytes >= options.maxReceivedBytes) { report.stopReason = 'byte_budget'; break; }
    if (lastStart !== undefined) {
      const remaining = Math.max(0, options.minIntervalMs - (clock() - lastStart));
      if (remaining) await wait(remaining, options.signal);
      if (options.signal?.aborted) { report.stopReason = 'cancelled'; break; }
    }
    observed = null;
    lastStart = clock();
    const execution = await executor.runOne();
    report.executions.push(execution);
    if (execution.status === 'idle') { report.stopReason = 'idle'; break; }
    if (!observed) { report.stopReason = 'execution_error'; break; } // No silent crash replay/cancellation.
    const measurement = observed as { url: string; start: number; startedAt: string;
      result?: LinkCheckResult; error?: string };
    const result = measurement.result;
    const bytes = result?.bytesRead ?? 0;
    report.attempts++;
    report.receivedBytes += bytes;
    const probe: SupervisedProbe = { jobId: execution.jobId!, url: measurement.url,
      startedAt: measurement.startedAt, latencyMs: Math.max(0, clock() - measurement.start),
      receivedBytes: bytes, outcome: result?.outcome ?? null, statusCode: result?.statusCode,
      reason: result?.reason ?? measurement.error, executionStatus: execution.status };
    report.probes.push(probe);
    options.onProbe?.(probe);
    if (measurement.error) { report.stopReason = 'fetch_error'; break; }
    if (execution.status !== 'completed') { report.stopReason = 'execution_error'; break; }
    if (options.signal?.aborted) { report.stopReason = 'cancelled'; break; }
    if (result?.outcome === 'UNKNOWN') { report.stopReason = 'unknown'; break; }
    if (report.receivedBytes >= options.maxReceivedBytes) { report.stopReason = 'byte_budget'; break; }
    if (options.signal?.aborted) { report.stopReason = 'cancelled'; break; }
  }
  return report;
}
