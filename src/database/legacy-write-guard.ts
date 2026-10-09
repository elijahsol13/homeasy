import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface LegacyPropertiesSnapshot {
  count: number;
  ids: number[];
  digest: string;
}

/** Stable digest of every legacy property column, including timestamps. */
export function snapshotLegacyProperties(db: DatabaseSync): LegacyPropertiesSnapshot {
  const columns = (db.prepare('PRAGMA table_info(properties)').all() as Array<{ name: string }>)
    .map(({ name }) => name);
  if (!columns.length) throw new Error('Legacy properties table is missing');
  const quotedColumns = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ');
  const rows = db.prepare(`SELECT ${quotedColumns} FROM properties ORDER BY id`).all() as Array<Record<string, unknown>>;
  const ids = rows.map((row) => Number(row.id));
  const digest = createHash('sha256').update(JSON.stringify({ columns, rows })).digest('hex');
  return { count: rows.length, ids, digest };
}

/**
 * Install connection-local SQLite triggers that reject every legacy INSERT,
 * UPDATE or DELETE in a shadow process. Triggers live in temp schema and never
 * alter the shared database file.
 */
export function installLegacyPropertiesWriteGuard(db: DatabaseSync): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='properties'").get();
  if (!exists) return;
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS shadow_guard_properties_insert
    BEFORE INSERT ON main.properties
    BEGIN SELECT RAISE(ABORT, 'LegacyWriteForbiddenError: INSERT properties blocked in shadow mode'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS shadow_guard_properties_update
    BEFORE UPDATE ON main.properties
    BEGIN SELECT RAISE(ABORT, 'LegacyWriteForbiddenError: UPDATE properties blocked in shadow mode'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS shadow_guard_properties_delete
    BEFORE DELETE ON main.properties
    BEGIN SELECT RAISE(ABORT, 'LegacyWriteForbiddenError: DELETE properties blocked in shadow mode'); END;
  `);
}

export function assertLegacyPropertiesUnchanged(
  db: DatabaseSync,
  before: LegacyPropertiesSnapshot,
): LegacyPropertiesSnapshot {
  const after = snapshotLegacyProperties(db);
  if (before.count !== after.count || before.digest !== after.digest
    || JSON.stringify(before.ids) !== JSON.stringify(after.ids)) {
    throw new Error(`Legacy properties mutated during shadow ingestion (count ${before.count}→${after.count}; digest ${before.digest}→${after.digest})`);
  }
  return after;
}
