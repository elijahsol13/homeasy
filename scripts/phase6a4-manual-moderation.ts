import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const path = process.env.PHASE6A4_DB ?? 'data/homeasy.db';
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
const changes = [
  { id: 54, status: 'pending', reason: 'Manual canary audit: source title describes land, building, office, and retail for rent; current room/bedroom extraction is unsupported.' },
  { id: 136, status: 'pending', reason: 'Manual canary audit: one source post offers multiple unit types and prices; canonical bedroom/price binding conflicts with the source options.' },
  { id: 196, status: 'pending', reason: 'Manual canary audit: listing title, sangkat, and explicit location conflict; hold until property geography is confirmed.' },
  { id: 240, status: 'pending', reason: 'Manual canary audit: source text identifies Sla Kram while canonical explicit location says Wat Bo; hold geography conflict.' },
  { id: 252, status: 'rejected', reason: 'Manual canary audit: source advertises a hotel room at a nightly rate, outside the monthly rental catalog.' },
] as const;
try {
  const legacyBefore = snapshotLegacyProperties(db);
  db.exec('BEGIN IMMEDIATE');
  const applied = [];
  for (const change of changes) {
    const row = db.prepare(`SELECT m.review_status,m.previous_review_status,l.title FROM canonical_listing_moderation m
      JOIN canonical_listings l ON l.id=m.listing_id WHERE m.listing_id=?`).get(change.id) as { review_status: string; previous_review_status: string | null; title: string } | undefined;
    if (!row) throw new Error(`Expected moderation row missing: ${change.id}`);
    if (row.review_status !== change.status) {
      db.prepare(`UPDATE canonical_listing_moderation SET review_status=?,review_reason=?,decision_origin='EXPLICIT_CANONICAL',
        decision_actor='HUMAN',previous_review_status=?,decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE listing_id=?`)
        .run(change.status, change.reason, row.review_status, change.id);
    }
    applied.push({ id: change.id, title: row.title, priorStatus: row.previous_review_status ?? row.review_status, currentStatus: change.status, reason: change.reason });
  }
  db.exec('COMMIT');
  const legacyAfter = snapshotLegacyProperties(db);
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (legacyBefore.count !== legacyAfter.count || legacyBefore.digest !== legacyAfter.digest || foreignKeys.length
    || (integrity[0] as { integrity_check: string }).integrity_check !== 'ok') {
    throw new Error('Manual moderation changed legacy state or failed database integrity checks');
  }
  const report = { generatedAt: new Date().toISOString(), path, changes: applied,
    legacy: { count: legacyAfter.count, digest: legacyAfter.digest, unchanged: true }, integrity, foreignKeyViolations: foreignKeys.length };
  writeFileSync('reports/phase6a4-manual-moderation-20261007.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* transaction may already be committed */ }
  throw error;
} finally {
  db.close();
}
