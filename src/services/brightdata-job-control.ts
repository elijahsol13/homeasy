/** Durable, single-writer Bright Data jobs shared by the Telegram bot and VPS worker. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type BrightDataScope = 'top3' | 'all';
export type BrightDataStatus = 'queued' | 'collecting' | 'classifying' | 'completed' | 'cancelled' | 'failed' | 'needs_review';

export interface BrightDataPlan {
  scope: BrightDataScope;
  budget: number;
  startDate: string;
  endDate: string;
  groupIds: string[];
  groupCount: number;
  perGroupLimit: number;
  maxRequests: number;
}

export interface BrightDataJob extends BrightDataPlan {
  id: string;
  runId: string;
  status: BrightDataStatus;
  userId: number;
  chatId: number;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  result: Record<string, unknown> | null;
  resumeExisting: boolean;
}

const TOP_THREE = ['385053483002145', '201561753758474', 'cheaprentsiemreap'];

export function buildBrightDataPlan(scope: BrightDataScope, budget: number, now = new Date()): BrightDataPlan {
  if (scope !== 'top3' && scope !== 'all') throw new Error('Unknown Bright Data scenario');
  if (![100, 500, 1000].includes(budget)) throw new Error('Choose 100, 500 or 1000 posts');
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const start = new Date(`${today}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (scope === 'top3' ? 14 : 30));
  const count = scope === 'top3' ? 3 : 16;
  return {
    scope, budget, startDate: start.toISOString().slice(0, 10), endDate: today,
    groupIds: scope === 'top3' ? [...TOP_THREE] : [],
    groupCount: count, perGroupLimit: Math.ceil(budget / count), maxRequests: count,
  };
}

interface JobRow {
  id: string; run_id: string; scope: BrightDataScope; budget: number;
  start_date: string; end_date: string; group_ids: string; group_count: number;
  per_group_limit: number; max_requests: number; status: BrightDataStatus;
  user_id: number; chat_id: number; cancel_requested: number;
  created_at: string; updated_at: string; error: string | null; result_json: string | null;
  resume_existing: number;
}

function fromRow(row: JobRow): BrightDataJob {
  return {
    id: row.id, runId: row.run_id, scope: row.scope, budget: row.budget,
    startDate: row.start_date, endDate: row.end_date, groupIds: JSON.parse(row.group_ids) as string[],
    groupCount: row.group_count, perGroupLimit: row.per_group_limit, maxRequests: row.max_requests,
    status: row.status, userId: row.user_id, chatId: row.chat_id,
    cancelRequested: row.cancel_requested === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    error: row.error, result: row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null,
    resumeExisting: row.resume_existing === 1,
  };
}

export function brightDataControlPath(): string {
  return process.env.BRIGHTDATA_CONTROL_DB ?? path.resolve(process.cwd(), 'data', 'brightdata', 'control.sqlite');
}

export class BrightDataJobStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = brightDataControlPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS brightdata_jobs (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL, budget INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        group_ids TEXT NOT NULL, group_count INTEGER NOT NULL, per_group_limit INTEGER NOT NULL, max_requests INTEGER NOT NULL,
        user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, status TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        error TEXT, result_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS brightdata_one_active ON brightdata_jobs ((1))
        WHERE status IN ('queued', 'collecting', 'classifying', 'needs_review');`);
    const columns = this.db.prepare('PRAGMA table_info(brightdata_jobs)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'resume_existing')) {
      this.db.exec('ALTER TABLE brightdata_jobs ADD COLUMN resume_existing INTEGER NOT NULL DEFAULT 0');
    }
  }

  close(): void { this.db.close(); }

  get(id: string): BrightDataJob | null {
    const row = this.db.prepare('SELECT * FROM brightdata_jobs WHERE id=?').get(id) as unknown as JobRow | undefined;
    return row ? fromRow(row) : null;
  }

  latest(): BrightDataJob | null {
    const row = this.db.prepare('SELECT * FROM brightdata_jobs ORDER BY rowid DESC LIMIT 1').get() as unknown as JobRow | undefined;
    return row ? fromRow(row) : null;
  }

  enqueue(plan: BrightDataPlan, userId: number, chatId: number, requestKey: string): BrightDataJob {
    const duplicate = this.db.prepare('SELECT * FROM brightdata_jobs WHERE request_key=?').get(requestKey) as unknown as JobRow | undefined;
    if (duplicate) return fromRow(duplicate);
    const active = this.db.prepare(`SELECT status FROM brightdata_jobs
      WHERE status IN ('queued','collecting','classifying','needs_review') LIMIT 1`).get() as { status: string } | undefined;
    if (active) throw new Error(active.status === 'needs_review'
      ? 'Previous paid job needs manual review before new requests'
      : 'An active Bright Data job already exists');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const runId = `${now.replace(/[:.]/g, '-').slice(0, 19)}_${crypto.randomBytes(3).toString('hex')}`;
    this.db.prepare(`INSERT INTO brightdata_jobs
      (id,request_key,run_id,scope,budget,start_date,end_date,group_ids,group_count,per_group_limit,max_requests,
       user_id,chat_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, requestKey, runId, plan.scope,
      plan.budget, plan.startDate, plan.endDate, JSON.stringify(plan.groupIds), plan.groupCount,
      plan.perGroupLimit, plan.maxRequests, userId, chatId, now, now);
    return this.get(id)!;
  }

  claimNext(): BrightDataJob | null {
    const queued = this.db.prepare("SELECT id FROM brightdata_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get() as { id: string } | undefined;
    if (!queued) return null;
    const changed = this.db.prepare(`UPDATE brightdata_jobs SET status='collecting',updated_at=?
      WHERE id=? AND status='queued' AND cancel_requested=0`).run(new Date().toISOString(), queued.id);
    return changed.changes ? this.get(queued.id) : null;
  }

  /** Explicit operator action after verifying paid raw history and snapshots. */
  resumeReviewed(id: string, expectedRunId: string): BrightDataJob {
    const job = this.get(id);
    if (!job || job.runId !== expectedRunId) throw new Error('Bright Data run identity mismatch');
    if (job.status !== 'needs_review') throw new Error('Only reviewed interrupted jobs may resume');
    if (job.cancelRequested || job.scope !== 'top3' || job.budget !== 1000 ||
        job.groupCount !== 3 || job.perGroupLimit !== 334 || job.maxRequests !== 3 ||
        JSON.stringify(job.groupIds) !== JSON.stringify(TOP_THREE)) {
      throw new Error('Original paid job differs from expected approved plan; manual review required');
    }
    const changed = this.db.prepare(`UPDATE brightdata_jobs
      SET scope='all',group_ids='[]',group_count=16,per_group_limit=45,max_requests=16,
          resume_existing=1,status='queued',error=NULL,updated_at=?
      WHERE id=? AND run_id=? AND status='needs_review' AND cancel_requested=0`).run(
        new Date().toISOString(), id, expectedRunId);
    if (changed.changes !== 1) throw new Error('Reviewed Bright Data job changed before resume');
    return this.get(id)!;
  }

  requestCancel(id: string): BrightDataJob | null {
    this.db.prepare(`UPDATE brightdata_jobs SET cancel_requested=1,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      updated_at=? WHERE id=? AND status IN ('queued','collecting','classifying')`).run(new Date().toISOString(), id);
    return this.get(id);
  }

  isCancellationRequested(id: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM brightdata_jobs WHERE id=?').get(id) as { cancel_requested: number } | undefined;
    if (!row) throw new Error('Unknown Bright Data job; refusing provider request');
    return row.cancel_requested === 1;
  }

  update(id: string, status: BrightDataStatus, details: { error?: string; result?: Record<string, unknown> } = {}): void {
    const changed = this.db.prepare(`UPDATE brightdata_jobs SET status=?,updated_at=?,error=?,result_json=? WHERE id=?`).run(
      status, new Date().toISOString(), details.error ?? null,
      details.result ? JSON.stringify(details.result) : null, id,
    );
    if (!changed.changes) throw new Error('Bright Data job no longer exists');
  }

  /** A lost worker may have sent a billable POST. Never automatically replay it. */
  recoverInterrupted(): number {
    const changed = this.db.prepare(`UPDATE brightdata_jobs
      SET status='needs_review', updated_at=?,error='Worker interrupted; inspect raw/snapshots before another paid POST'
      WHERE status IN ('collecting','classifying')`).run(new Date().toISOString());
    return Number(changed.changes);
  }
}
