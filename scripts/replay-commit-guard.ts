import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type ComposeRow = { Service?: unknown; State?: unknown };

function physicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function parseComposeRows(output: string): ComposeRow[] {
  const raw = output.trim();
  if (!raw) throw new Error('empty response');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((row) => row !== null && typeof row === 'object')) {
      return parsed as ComposeRow[];
    }
    if (parsed !== null && typeof parsed === 'object') return [parsed as ComposeRow];
  } catch {
    // Some Docker Compose versions output one JSON object per line.
    const rows = raw.split('\n').map((line) => JSON.parse(line) as unknown);
    if (rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
      return rows as ComposeRow[];
    }
  }
  throw new Error('unexpected JSON shape');
}

/**
 * Live host-side replay against the bind-mounted WAL is unsafe while Compose
 * readers/writers are running. Require an explicit maintenance opt-in and a
 * successful Compose state check before opening the first writable connection.
 */
export function assertReplayCommitSafe(
  databasePath: string,
  options: {
    allowLiveDb: boolean;
    projectRoot?: string;
    composePs?: () => string;
  },
): void {
  const projectRoot = options.projectRoot ?? path.resolve(__dirname, '..');
  const liveDb = physicalPath(path.join(projectRoot, 'data/homeasy.db'));
  if (physicalPath(databasePath) !== liveDb) return; // Explicit detached fixtures.

  if (!options.allowLiveDb) {
    throw new Error('Refusing replay --commit to live data/homeasy.db. Use a detached DATABASE_PATH, '
      + 'or use --allow-live-db only after stopping the Compose database services.');
  }

  let rows: ComposeRow[];
  try {
    const output = options.composePs
      ? options.composePs()
      : execFileSync('docker', ['compose', 'ps', '--all', '--format', 'json'], {
        cwd: projectRoot, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    rows = parseComposeRows(output);
  } catch (error) {
    throw new Error('Cannot verify Docker Compose is stopped; live replay --commit denied. '
      + `Reason: ${error instanceof Error ? error.message : String(error)}`);
  }

  const dbServices = new Set(['api', 'bot', 'scraper', 'backup']);
  for (const row of rows) {
    if (typeof row.Service !== 'string' || typeof row.State !== 'string') {
      throw new Error('Incomplete Docker Compose status; live replay --commit denied.');
    }
    if (!dbServices.has(row.Service)) continue;
    const state = row.State.toLowerCase();
    if (!['exited', 'created', 'dead'].includes(state)) {
      throw new Error(`Live replay --commit denied: ${row.Service} container is ${row.State}. `
        + 'Stop all database-using Compose services before maintenance.');
    }
  }
}
