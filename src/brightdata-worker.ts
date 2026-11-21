/** VPS-only worker: consumes confirmed admin jobs, calls the existing TS scripts in a separate process. */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrightDataJobStore, type BrightDataJob } from './services/brightdata-job-control';

const outputDir = path.resolve(process.env.BRIGHTDATA_OUTPUT_DIR ?? './data/brightdata/raw');

function runScript(script: 'brightdata-batch-test' | 'brightdata-classify', args: string[], vars: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('dist-tools', 'scripts', `${script}.js`), ...args], {
      cwd: process.cwd(), env: { ...process.env, ...vars }, stdio: 'inherit', shell: false,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script} exited (${signal ?? code})`)));
  });
}

async function sendNotification(job: BrightDataJob, message: string): Promise<void> {
  if (!process.env.BOT_TOKEN) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: job.chatId, text: message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) console.warn('Bright Data notification failed:', response.status);
  } catch (error) { console.warn('Bright Data notification error:', error); }
}

interface CollectionSummary {
  totalGroups: number;
  groupsAttempted: number;
  recordsReceived: number;
  stopReason: string | null;
  results: Array<{ status: string; recordsReceived: number }>;
}

export function buildCollectionArgs(job: BrightDataJob): string[] {
  return [
    '--full',
    ...(job.scope === 'top3' ? [`--group-ids=${job.groupIds.join(',')}`] : []),
    '--submit',
    ...(job.resumeExisting ? ['--resume-existing'] : []),
  ];
}

function validateCollection(job: BrightDataJob, summary: CollectionSummary): void {
  if (summary.totalGroups !== job.groupCount || summary.groupsAttempted !== job.groupCount || summary.results.length !== job.groupCount) {
    throw new Error('Incomplete Bright Data response set; preserve raw data for manual review');
  }
  if (summary.stopReason || summary.results.some((row) => !['success', 'no_records'].includes(row.status))) {
    throw new Error(`Provider collection incomplete: ${summary.stopReason ?? 'one or more groups failed'}`);
  }
  if (summary.recordsReceived > job.budget) {
    throw new Error('Provider exceeded requested record budget; inspect raw before continuing');
  }
}

async function execute(job: BrightDataJob, store: BrightDataJobStore): Promise<void> {
  if (!process.env.BRIGHTDATA_API_KEY) throw new Error('BRIGHTDATA_API_KEY missing on worker');
  if (!process.env.DATABASE_PATH) throw new Error('DATABASE_PATH missing on worker');
  await fs.mkdir(outputDir, { recursive: true });
  const vars = {
    BRIGHTDATA_START_DATE: job.startDate, BRIGHTDATA_END_DATE: job.endDate,
    BRIGHTDATA_RECORD_BUDGET: String(job.budget), BRIGHTDATA_PER_GROUP_LIMIT: String(job.perGroupLimit),
    BRIGHTDATA_RUN_ID: job.runId, BRIGHTDATA_OUTPUT_DIR: outputDir,
    BRIGHTDATA_STRICT_BUDGET: 'true', BRIGHTDATA_CONTROL_JOB_ID: job.id,
    BRIGHTDATA_CONTROL_DB: process.env.BRIGHTDATA_CONTROL_DB ?? path.resolve('data/brightdata/control.sqlite'),
  };
  // No dynamic shell commands can originate from Telegram. The scope and group
  // IDs are validated against the fixed Bright Data registry by the CLI.
  await runScript('brightdata-batch-test', buildCollectionArgs(job), vars);
  const raw = await fs.readFile(path.join(outputDir, `${job.runId}_summary.json`), 'utf8');
  const summary = JSON.parse(raw) as CollectionSummary;
  const current = store.get(job.id)!;
  if (current.cancelRequested && summary.groupsAttempted < summary.totalGroups) {
    store.update(job.id, 'cancelled', { result: { recordsReceived: summary.recordsReceived, attempted: summary.groupsAttempted } });
    await sendNotification(job, `⏹ Bright Data остановлен перед следующим запросом. Получено ${summary.recordsReceived} записей. /brightdata status`);
    return;
  }
  validateCollection(job, summary);
  store.update(job.id, 'classifying', { result: { recordsReceived: summary.recordsReceived } });
  // Uses the existing AI router, dedup, extraction and canonical ingestion.
  await runScript('brightdata-classify', [], {
    ...vars, BRIGHTDATA_SOURCE_RUN_ID: job.runId,
    BRIGHTDATA_RUN_ID: `${job.runId}_ai`,
  });
  const reportPath = path.join(outputDir, `${job.runId}_ai_group_report.json`);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as Record<string, unknown>;
  store.update(job.id, 'completed', { result: {
    recordsReceived: summary.recordsReceived, groupsAttempted: summary.groupsAttempted,
    totalUniqueSupply: report.totalUniqueSupply, totalUniqueDemand: report.totalUniqueDemand,
    classificationCounts: report.classificationCounts,
  } });
  await sendNotification(job, `✅ Bright Data: обработано ${summary.recordsReceived} постов из ${summary.groupsAttempted} групп. AI, дедупликация и canonical ingest завершены. /brightdata status`);
}

async function main(): Promise<void> {
  const store = new BrightDataJobStore();
  const interrupted = store.recoverInterrupted();
  if (interrupted) console.error(`Bright Data: ${interrupted} interrupted jobs need review before more paid requests`);
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      const job = store.claimNext();
      if (job) {
        try {
          await execute(job, store);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const previous = store.get(job.id);
          // Collection could have caused a billable request before an error;
          // never auto-submit another job until an operator inspects the files.
          const review = previous?.status === 'collecting';
          store.update(job.id, review ? 'needs_review' : 'failed', { error: message });
          console.error(`Bright Data ${job.id}: ${message}`);
          await sendNotification(job, `⚠️ Bright Data ${review ? 'требует проверки перед новым платным запуском' : 'ошибка AI/загрузки'}: ${message.slice(0, 300)}. /brightdata status`);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  } finally { store.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
